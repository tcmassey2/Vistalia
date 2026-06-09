import { requireUser } from "./_lib/auth.js";
import { rateLimit } from "./_lib/rate-limit.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 15000;
const LOW_CONFIDENCE_THRESHOLD = 62;
const ALLOWED_CATEGORIES = [
  "exterior hero",
  "kitchen",
  "living room",
  "bedroom",
  "bathroom",
  "backyard/outdoor",
  "amenity",
  "detail/other"
];

export default async function handler(request, response) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ status: "fallback", reason: "Use POST /api/classify-image." });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    response.status(200).json({ status: "fallback", reason: "OPENAI_API_KEY is not configured server-side." });
    return;
  }

  // v26: auth + rate limit. NOTE: as of this writing no frontend code calls
  // this endpoint (curation moved into create-edit-plan's Vision pass) —
  // it's kept for the legacy app surface. If it comes back into use, the
  // caller must send the Supabase JWT. 120/hr covers a 24-photo upload
  // burst across several projects.
  const auth = await requireUser(request, response);
  if (!auth.ok) return;
  const limitedClassify = await rateLimit(request, response, {
    bucket: "classify",
    max: 120,
    windowMs: 60 * 60 * 1000
  });
  if (limitedClassify) return;

  const body = parseBody(request.body);
  const imageUrl = String(body.imageUrl || "");
  if (!imageUrl || imageUrl.startsWith("blob:")) {
    response.status(200).json({ status: "fallback", reason: "Vision classification requires a public URL or data URL, not a browser blob URL." });
    return;
  }

  try {
    const openaiResponse = await fetchWithTimeout(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildVisionRequest(imageUrl, body))
    }, Number(process.env.OPENAI_VISION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));

    const payload = await openaiResponse.json().catch(() => ({}));
    if (!openaiResponse.ok) {
      response.status(200).json({
        status: "fallback",
        reason: payload.error?.message || `OpenAI Vision returned ${openaiResponse.status}.`
      });
      return;
    }

    const parsed = parseVisionOutput(payload);
    const result = normalizeResult(parsed);
    if (!result || result.confidence < Number(process.env.OPENAI_VISION_MIN_CONFIDENCE || LOW_CONFIDENCE_THRESHOLD)) {
      response.status(200).json({
        status: "fallback",
        reason: result ? `OpenAI Vision confidence was ${result.confidence}%.` : "OpenAI Vision returned an unusable response.",
        result
      });
      return;
    }

    response.status(200).json({ status: "complete", result });
  } catch (error) {
    response.status(200).json({
      status: "fallback",
      reason: error.name === "AbortError" ? "OpenAI Vision classification timed out." : error.message || "OpenAI Vision classification failed."
    });
  }
}

function buildVisionRequest(imageUrl, body) {
  return {
    model: process.env.OPENAI_VISION_MODEL || DEFAULT_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You classify real estate listing photos for a photo-to-reel pipeline.",
              `Choose exactly one category from: ${ALLOWED_CATEGORIES.join(", ")}.`,
              "Only describe visible, factual image content. Never invent features, rooms, views, upgrades, or amenities.",
              "Return strict JSON with keys: category, confidence, visibleFeatures, description.",
              "confidence must be 0-100. visibleFeatures must be short factual strings."
            ].join(" ")
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Classify this listing photo. Filename: ${String(body.fileName || "unknown").slice(0, 120)}. Upload order: ${Number(body.uploadOrder || 0)}.`
          },
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "low"
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "estate_motion_photo_classification",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: { type: "string", enum: ALLOWED_CATEGORIES },
            confidence: { type: "number", minimum: 0, maximum: 100 },
            visibleFeatures: {
              type: "array",
              maxItems: 6,
              items: { type: "string" }
            },
            description: { type: "string", maxLength: 180 }
          },
          required: ["category", "confidence", "visibleFeatures", "description"]
        }
      }
    },
    temperature: 0,
    max_output_tokens: 220
  };
}

function parseVisionOutput(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return parseBody(payload.output_text);
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part.type === "output_text" && part.text) return parseBody(part.text);
      if (part.type === "text" && part.text) return parseBody(part.text);
    }
  }
  return {};
}

function normalizeResult(result) {
  if (!result || !ALLOWED_CATEGORIES.includes(result.category)) return null;
  const confidence = Math.max(0, Math.min(100, Math.round(Number(result.confidence || 0))));
  const visibleFeatures = Array.isArray(result.visibleFeatures)
    ? result.visibleFeatures.map((item) => String(item).trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    category: result.category,
    confidence,
    visibleFeatures,
    tags: visibleFeatures,
    description: String(result.description || "").trim().slice(0, 180),
    source: "openai-vision"
  };
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
