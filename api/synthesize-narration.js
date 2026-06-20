// Vistalia — Per-line narration synthesis.
//
// Two callers:
//   1. The render-worker, which hits ElevenLabs directly using the same
//      key (worker has its own ELEVENLABS_API_KEY env var). The worker does
//      not call THIS endpoint — it imports the synthesizer from
//      render-worker/src/voice-mixer.mjs which is a near-identical copy.
//   2. The frontend "test your voice" preview, which hits this endpoint
//      with a short test phrase to verify the clone works end-to-end.
//
// We do NOT cache synthesized audio server-side. Every call is fresh. The
// frontend uses the response as a transient blob URL — a cloned voice can
// be tested, played back, then discarded.

import { requireUser } from "./_lib/auth.js";
import { rateLimit } from "./_lib/rate-limit.js";
import { resolveVoiceId } from "./_lib/voice-resolver.js";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
// "eleven_turbo_v2_5" is the cheapest model that still sounds professional
// on voice clones. Use multilingual_v2 if you need non-English support.
const DEFAULT_MODEL = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const FALLBACK_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel"

export default async function handler(request, response) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    response.status(503).json({ status: "failed", error: "Voice synthesis is not configured." });
    return;
  }

  // v26: auth + rate limit — every call here is fresh ElevenLabs spend.
  // 30/hr covers honest "test your voice" usage (a handful of previews
  // per session) with room to spare.
  const auth = await requireUser(request, response);
  if (!auth.ok) return;
  const limited = await rateLimit(request, response, {
    bucket: "narration",
    max: 30,
    windowMs: 60 * 60 * 1000
  });
  if (limited) return;

  try {
    let voiceId = "";
    let text = "";
    if (request.method === "GET") {
      const url = new URL(request.url || "", "http://localhost");
      voiceId = String(url.searchParams.get("voiceId") || "").trim();
      text = String(url.searchParams.get("text") || "").trim();
    } else if (request.method === "POST") {
      const body = parseBody(request.body);
      voiceId = String(body.voiceId || "").trim();
      text = String(body.text || "").trim();
    } else {
      response.status(405).json({ status: "failed", error: "Use GET or POST." });
      return;
    }

    if (!text) {
      response.status(400).json({ status: "failed", error: "text is required." });
      return;
    }
    if (text.length > 500) {
      response.status(400).json({ status: "failed", error: "Preview text is capped at 500 characters." });
      return;
    }

    // v27: voiceId may be a preset slug ("luxury-warm") or a raw cloned ID.
    // ElevenLabs only accepts raw IDs — resolve before calling. Without this,
    // previewing a preset voice 404'd and "voice doesn't work" looked real.
    const targetVoiceId = resolveVoiceId(voiceId);

    const ttsResponse = await fetchWithTimeout(
      `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(targetVoiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        },
        body: JSON.stringify({
          text,
          model_id: DEFAULT_MODEL,
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.85,
            style: 0.15,
            use_speaker_boost: true
          }
        })
      },
      30000
    );

    if (!ttsResponse.ok) {
      const errBody = await ttsResponse.text().catch(() => "");
      response.status(502).json({
        status: "failed",
        error: `ElevenLabs synthesis failed (${ttsResponse.status}): ${errBody.slice(0, 200)}`
      });
      return;
    }

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    response.setHeader("Content-Type", "audio/mpeg");
    response.setHeader("Cache-Control", "private, max-age=60");
    response.status(200).send(audioBuffer);
  } catch (error) {
    response.status(500).json({ status: "failed", error: error.message || "Synthesis failed." });
  }
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
