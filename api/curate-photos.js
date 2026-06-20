// Vistalia — /api/curate-photos
//
// "AI hand-picks the best 24 photos and arranges them in a strong real-estate
// tour order." User uploads N photos (up to 60). OpenAI Vision scores each
// one for real-estate marketability, then we pick the top 24 with mandatory
// room coverage and order them as a professional walkthrough.
//
// Flow:
//   1. Accept up to 60 photos with durable URLs.
//   2. Send all of them to gpt-4.1-mini (Vision) at "low" detail. ~$0.002/img,
//      so a 50-photo curation costs ~$0.10. Budget-friendly.
//   3. Model returns per-photo: roomType, quality (0-100), pickWorthiness
//      (0-100), one-line rationale, isHero flag.
//   4. We apply the picker:
//        - Mandatory rooms first (exterior > kitchen > living > primary
//          bedroom > bathroom > outdoor) — at least one of each if available.
//        - Fill remaining slots with highest pickWorthiness, capped per room
//          (no 5 bedroom photos in a 24-scene tour).
//        - Sort the chosen 24 into tour order.
//   5. Return { curated: [{photoId, order, roomType, score, reason}],
//                rejected: [{photoId, reason}] }.
//
// Why this is its own endpoint (not folded into /api/create-edit-plan):
//   - Lets the user curate first, see the picks, swap any out, THEN render.
//   - Curation runs in seconds; edit-plan generation takes 30+ seconds. They
//     have different UX expectations.
//   - Keeps the cost gate clear: curation is one Vision call; edit-plan is
//     another. Each can be metered independently if we add quotas.

import { rateLimit } from "./_lib/rate-limit.js";

// v23: Vercel function timeout. Default for Node serverless is 10s (Hobby)
// or 60s (Pro). The OpenAI Vision call alone can take 50-90s for 25-photo
// curations, so we explicitly request 120s. Pro plan allows up to 300s.
// Without this, Vercel kills the function before OpenAI responds and the
// frontend sees the same "Auto-curate timed out. Falling back to upload
// order." error every time.
export const config = {
  maxDuration: 120
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";
// v23 retune: bumped from 45s → 120s. Real-world finding: scoring 25 photos
// at gpt-4.1-mini Vision ("low" detail) regularly takes 50-90s when OpenAI
// is under load. The old 45s timeout fired the "Auto-curate timed out.
// Falling back to upload order." path on every legitimate large request.
// Vercel serverless function ceiling is 300s on Pro plans, so 120s leaves
// plenty of headroom for the rest of the response handling.
const DEFAULT_TIMEOUT_MS = 120000;
// Cap requests we forward to OpenAI to avoid hitting context-window or
// per-request token limits even on the upper input bound. Vision input
// images count toward token budget; staying under this keeps responses
// well within model limits.
const MAX_OPENAI_BATCH = 30;

// Hard caps to bound cost + token usage.
const MAX_INPUT_PHOTOS = 60;
const TARGET_KEEP = 24;
// Minimum photo count for AI to do useful work. Below this, the photo set
// is so small that re-ordering provides marginal value vs the OpenAI cost
// + latency. v23 lowered from 25 → 8 because most real-estate listings
// arrive with 12-30 photos, and users want tour-order curation even when
// no photos need to be dropped.
const MIN_INPUT_FOR_CURATION = 8;

// Tour-order priority — how a strong real-estate walkthrough is structured.
// Lower index = earlier in the video. Photos within the same room type
// preserve their pickWorthiness ranking.
const TOUR_ORDER = [
  "exterior",
  "outdoor",       // front yard / curb appeal — separate from "exterior" hero
  "kitchen",
  "living",
  "bedroom",
  "bathroom",
  "amenity",
  "detail"
];

// Room-coverage targets: how many slots to reserve per room when curating.
// Stops the AI from filling all 24 slots with kitchen photos.
// Sums to TARGET_KEEP. Tunable.
const ROOM_QUOTAS = {
  exterior: 3,
  kitchen: 4,
  living: 4,
  bedroom: 5,    // primary + secondary bedrooms
  bathroom: 3,
  outdoor: 3,
  amenity: 1,
  detail: 1
};

export default async function handler(request, response) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method !== "POST") {
    response.status(405).json({ status: "failed", error: "Use POST /api/curate-photos." });
    return;
  }

  // Each curate call is one OpenAI Vision request (~$0.10). 30/hour caps
  // the worst-case spend at $3/hour per user; honest users never need
  // more than 2-3 per project.
  const limited = await rateLimit(request, response, {
    bucket: "curate",
    max: 30,
    windowMs: 60 * 60 * 1000
  });
  if (limited) return;

  const body = parseBody(request.body);
  const rawPhotos = Array.isArray(body.photos) ? body.photos : [];
  const photos = rawPhotos
    .map((p) => ({
      id: String(p?.id || ""),
      durableUrl: String(p?.durableUrl || p?.publicUrl || ""),
      fileName: String(p?.fileName || "")
    }))
    .filter((p) => p.id && p.durableUrl && /^https?:/i.test(p.durableUrl))
    .slice(0, MAX_INPUT_PHOTOS);

  // v23: only skip if there are too few photos to make AI scoring worthwhile.
  // For sets of 8-24 photos: still run OpenAI Vision so the AI can re-order
  // them into a strong tour sequence (kitchen-living-bedroom-bath-exterior),
  // just don't drop any since we're already at or under TARGET_KEEP.
  if (photos.length < MIN_INPUT_FOR_CURATION) {
    response.status(200).json({
      status: "skipped",
      reason: `You have ${photos.length} photos — AI curation needs at least ${MIN_INPUT_FOR_CURATION}. Upload more or arrange manually.`,
      curated: photos.map((p, i) => ({ photoId: p.id, order: i + 1, roomType: "", score: 0, reason: "" })),
      rejected: []
    });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    response.status(503).json({
      status: "failed",
      error: "AI curation requires OPENAI_API_KEY on the server."
    });
    return;
  }

  try {
    const openaiResp = await fetchWithTimeout(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildOpenAIRequest(photos))
    }, DEFAULT_TIMEOUT_MS);

    const payload = await openaiResp.json().catch(() => ({}));
    if (!openaiResp.ok) {
      const detail = payload?.error?.message || `HTTP ${openaiResp.status}`;
      console.warn("[curate-photos] OpenAI failed:", detail);
      response.status(200).json({
        status: "fallback",
        reason: `Auto-curate unavailable (${detail}). Falling back to upload order.`,
        curated: photos.slice(0, TARGET_KEEP).map((p, i) => ({
          photoId: p.id, order: i + 1, roomType: "", score: 0, reason: ""
        })),
        rejected: photos.slice(TARGET_KEEP).map((p) => ({
          photoId: p.id, reason: "Beyond top 24 in upload order — fallback used."
        }))
      });
      return;
    }

    const scored = parseOpenAIScores(payload, photos);
    if (!scored.length) {
      response.status(200).json({
        status: "fallback",
        reason: "Auto-curate returned an unreadable response. Falling back to upload order.",
        curated: photos.slice(0, TARGET_KEEP).map((p, i) => ({
          photoId: p.id, order: i + 1, roomType: "", score: 0, reason: ""
        })),
        rejected: photos.slice(TARGET_KEEP).map((p) => ({
          photoId: p.id, reason: "Beyond top 24 in upload order — fallback used."
        }))
      });
      return;
    }

    // BUG FIX: detect partial OpenAI responses (truncation at max_output_tokens,
    // mid-stream drops, or the model omitting entries). Without this guard the
    // curator would happily return only the photos OpenAI scored, silently
    // dropping the unscored ones from the user's project.
    // We accept anything within 90% of input as "the model just rejected a
    // few" (legitimate), but below that we fall back rather than lose photos.
    const completeness = scored.length / photos.length;
    if (completeness < 0.9) {
      console.warn(
        `[curate-photos] OpenAI returned ${scored.length}/${photos.length} entries — too partial, falling back.`
      );
      response.status(200).json({
        status: "fallback",
        reason: `AI only scored ${scored.length} of your ${photos.length} photos (possibly hit a token limit). Falling back to upload order so no photos are dropped.`,
        curated: photos.slice(0, TARGET_KEEP).map((p, i) => ({
          photoId: p.id, order: i + 1, roomType: "", score: 0, reason: ""
        })),
        rejected: photos.slice(TARGET_KEEP).map((p) => ({
          photoId: p.id, reason: "Beyond top 24 in upload order — fallback used."
        }))
      });
      return;
    }

    const result = pickAndOrder(scored);

    // Secondary guard: if AI marked every photo as "skip", pickAndOrder will
    // return zero kept photos. Without this fallback the frontend sees
    // status:ok + curated:[] and surfaces "AI didn't return any picks" —
    // which is misleading; the AI returned data, it just rejected everything.
    if (!result.curated.length) {
      response.status(200).json({
        status: "fallback",
        reason: "AI marked every photo as not tour-worthy (paperwork, floor plans, or low quality). Falling back to upload order.",
        curated: photos.slice(0, TARGET_KEEP).map((p, i) => ({
          photoId: p.id, order: i + 1, roomType: "", score: 0, reason: ""
        })),
        rejected: photos.slice(TARGET_KEEP).map((p) => ({
          photoId: p.id, reason: "Beyond top 24 in upload order — fallback used."
        }))
      });
      return;
    }

    response.status(200).json({
      status: "ok",
      model: motionModel(),
      inputCount: photos.length,
      keptCount: result.curated.length,
      curated: result.curated,
      rejected: result.rejected
    });
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    console.warn("[curate-photos] threw:", err.message || err);
    response.status(200).json({
      status: "fallback",
      reason: isTimeout
        ? "Auto-curate timed out. Falling back to upload order."
        : `Auto-curate failed (${err.message || "unknown"}). Falling back to upload order.`,
      curated: photos.slice(0, TARGET_KEEP).map((p, i) => ({
        photoId: p.id, order: i + 1, roomType: "", score: 0, reason: ""
      })),
      rejected: photos.slice(TARGET_KEEP).map((p) => ({
        photoId: p.id, reason: "Beyond top 24 in upload order — fallback used."
      }))
    });
  }
}

/* ============================================================
   OpenAI request builder
   ============================================================ */

function buildOpenAIRequest(photos) {
  const photoIds = photos.map((p) => p.id);
  // Ask for one ranking object per photo. Strict JSON schema means OpenAI
  // returns valid JSON every time, no parsing acrobatics.
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      photos: {
        type: "array",
        minItems: photos.length,
        maxItems: photos.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            photoId: { type: "string", enum: photoIds },
            roomType: {
              type: "string",
              enum: ["exterior", "kitchen", "living", "bedroom", "bathroom", "outdoor", "amenity", "detail", "skip"]
            },
            // 0-100 — pure visual quality (focus, lighting, composition).
            quality: { type: "number", minimum: 0, maximum: 100 },
            // 0-100 — should this photo be in a real-estate listing video?
            // Distinct from quality: a sharp photo of a cluttered closet
            // gets quality:80 + pickWorthiness:20.
            pickWorthiness: { type: "number", minimum: 0, maximum: 100 },
            // True for photos that would make the strongest opening shot
            // (exterior hero / dramatic view / twilight / curb appeal).
            isHero: { type: "boolean" },
            // v23.1: model-produced tour order. The model knows tour flow
            // better than our hardcoded TOUR_ORDER list — particularly for
            // intercutting bedrooms with their bathrooms, alternating
            // interior/exterior for variety, and saving the strongest
            // closing shot for last. 1 = first scene, N = last scene.
            // Set to 0 if the photo should be REJECTED (not in the final cut).
            tourOrder: { type: "integer", minimum: 0, maximum: 60 },
            // One-line reason for keep/reject (shown to the user).
            reason: { type: "string" }
          },
          required: ["photoId", "roomType", "quality", "pickWorthiness", "isHero", "tourOrder", "reason"]
        }
      }
    },
    required: ["photos"]
  };

  const systemPrompt = [
    "You are a senior real-estate cinematographer + editor curating photos for a 60-90 second listing video.",
    "Two jobs: (1) score each photo for keep/reject, (2) assign a global tour order for the keepers.",
    "",
    "INCLUSION DEFAULT: agents have already curated their upload; lean toward INCLUDING photos in the tour. Only reject if a photo is genuinely unusable. A typical listing should have 90%+ of uploads in the final cut. Aim to KEEP at least 80% of input photos, more for sets under 25.",
    "",
    "REJECT criteria (rare — set tourOrder=0 only when one of these clearly applies):",
    "- Out-of-focus, severely underexposed, or unusable composition.",
    "- Documents, floor plans, neighborhood maps, MLS sheets.",
    "- Photos that are clearly NOT this property (stock photos, neighborhood shots, etc.).",
    "- Two photos that are exactly the same shot (genuine duplicates from burst mode).",
    "- Severely cluttered or actively-staged-mid-shoot (people in frame, visible photographer reflection).",
    "",
    "PROMOTE criteria (high pickWorthiness):",
    "- Wide angles showing the full room.",
    "- Dramatic exterior, twilight, amenity shots.",
    "- Clean staging with intentional composition.",
    "- Hero kitchen, living, primary bedroom shots.",
    "- Pool, view, deck, landscaping.",
    "",
    "TOUR FLOW (this is the key job — use tourOrder to express it):",
    "1. OPEN with the single strongest first impression — usually a wide front exterior, twilight, or curb-appeal shot. Set isHero=true on this photo.",
    "2. ESTABLISH with a wide entry / foyer / approach shot if available.",
    "3. MAIN LIVING SPACES: living room → kitchen → dining. Show the space agents lead with.",
    "4. PRIMARY SUITE: bedroom → ensuite bathroom (intercut, don't group all bedrooms then all bathrooms).",
    "5. SECONDARY BEDROOMS + their bathrooms: same intercut pattern.",
    "6. OUTDOOR: pool, deck, yard, view shots.",
    "7. AMENITIES: gym, office, garage (if luxury), wine cellar, theatre.",
    "8. CLOSE with the strongest closing shot — usually pool at dusk, sunset deck view, or twilight rear exterior.",
    "",
    "VARIETY RULES (critical — flat sequences kill engagement):",
    "- Avoid 3+ consecutive shots of the same room type.",
    "- Alternate intimate (bedroom, bathroom) with expansive (living, kitchen, outdoor) when possible.",
    "- Group a primary bedroom with its bathroom, NOT all bedrooms together.",
    "- Save 1-2 of the best outdoor/exterior shots for the closing sequence.",
    "",
    "ROOM TYPE: classify each photo. Paperwork/floor plans → 'skip'.",
    "isHero: TRUE for the single strongest opening-shot candidate (one photo, ideally exterior or dramatic interior).",
    "tourOrder: 1..N for kept photos in the order they should appear; 0 for rejects. Numbers must be unique among kept photos."
  ].join("\n");

  const userTextItem = {
    type: "input_text",
    text: [
      `Score these ${photos.length} listing photos. Return one entry per photo, in the same order I provide them. Use the photoId values exactly as given.`,
      "",
      `Photos: ${photos.map((p, i) => `${i + 1}. id="${p.id}" file="${p.fileName}"`).join("; ")}`
    ].join("\n")
  };

  const imageItems = photos.map((p) => ({
    type: "input_image",
    image_url: p.durableUrl,
    detail: "low" // ~85 tokens per image — keeps total request cheap
  }));

  return {
    model: motionModel(),
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [userTextItem, ...imageItems]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "curated_photos",
        schema,
        strict: true
      }
    },
    max_output_tokens: 4096
  };
}

/* ============================================================
   Parse + pick
   ============================================================ */

function parseOpenAIScores(payload, originalPhotos) {
  // Responses API returns the structured JSON inside output[0].content[0].text
  const text = extractStructuredText(payload);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.photos)) return [];
    const byId = new Map(originalPhotos.map((p) => [p.id, p]));
    // Keep only entries that match real photo IDs and have all fields.
    return parsed.photos
      .filter((row) => row?.photoId && byId.has(row.photoId))
      .map((row) => ({
        photoId: String(row.photoId),
        roomType: String(row.roomType || "skip").toLowerCase(),
        quality: clampNumber(row.quality, 0, 100),
        pickWorthiness: clampNumber(row.pickWorthiness, 0, 100),
        isHero: Boolean(row.isHero),
        tourOrder: clampNumber(row.tourOrder, 0, 60),
        reason: String(row.reason || "").slice(0, 240)
      }));
  } catch {
    return [];
  }
}

function pickAndOrder(scored) {
  // Step 1: drop "skip" room types entirely — they're not part of any tour.
  const valid = scored.filter((r) => r.roomType !== "skip");
  const skipped = scored.filter((r) => r.roomType === "skip");

  // Step 2: sort by composite score = pickWorthiness * 0.7 + quality * 0.3.
  // Hero candidates get a +5 boost so they outrank merely-good photos.
  const composite = (r) =>
    r.pickWorthiness * 0.7 + r.quality * 0.3 + (r.isHero ? 5 : 0);
  const ranked = [...valid].sort((a, b) => composite(b) - composite(a));

  // Step 3: room-quota pass — greedily fill quotas in tour order.
  const kept = new Map(); // photoId -> entry
  const perRoomCount = Object.fromEntries(Object.keys(ROOM_QUOTAS).map((r) => [r, 0]));

  for (const r of ranked) {
    if (kept.size >= TARGET_KEEP) break;
    const quota = ROOM_QUOTAS[r.roomType] ?? 0;
    if (quota === 0) continue;
    if (perRoomCount[r.roomType] >= quota) continue;
    kept.set(r.photoId, r);
    perRoomCount[r.roomType]++;
  }

  // Step 4: top-up — if quotas didn't fill TARGET_KEEP slots (some rooms had
  // 0 photos), fill remaining slots with the next best regardless of room.
  if (kept.size < TARGET_KEEP) {
    for (const r of ranked) {
      if (kept.size >= TARGET_KEEP) break;
      if (kept.has(r.photoId)) continue;
      kept.set(r.photoId, r);
    }
  }

  // v23.1: model-rejection safety net. If the model rejected so many
  // photos that we ended up with way fewer than the user uploaded, that's
  // almost always over-aggressive AI judgment. Real-estate agents have
  // already pre-curated their uploads — Troy reported the AI keeping only
  // 15 of 25 photos which produces a 50-60s video instead of the expected
  // 2 minutes. Force a floor of min(input, max(20, 80% of input)).
  const inputCount = scored.length + skipped.length;
  const minKeepFloor = Math.min(
    TARGET_KEEP,
    Math.max(20, Math.floor(inputCount * 0.8))
  );
  if (kept.size < minKeepFloor) {
    // Fill from the rest of the ranked list (skipping already-kept and
    // the model-flagged 'skip' room types that are clearly garbage).
    for (const r of ranked) {
      if (kept.size >= minKeepFloor) break;
      if (kept.has(r.photoId)) continue;
      kept.set(r.photoId, r);
    }
    // If we STILL haven't hit the floor, dip into the 'skip' bucket as a
    // last resort. Better to include a marginally-bad photo than ship a
    // 60-second video when the agent expected 2 minutes.
    if (kept.size < minKeepFloor) {
      for (const r of skipped) {
        if (kept.size >= minKeepFloor) break;
        if (kept.has(r.photoId)) continue;
        // Reclassify skipped photos to 'detail' so they have a roomType
        // the picker can sort against.
        kept.set(r.photoId, { ...r, roomType: r.roomType === "skip" ? "detail" : r.roomType });
      }
    }
  }

  // Step 5: order the kept photos in tour sequence.
  //
  // v23.1: prefer the model's tourOrder field when it provided one. The
  // Vision model knows tour flow (intercut bedrooms with bathrooms,
  // alternate intimate vs expansive, save best closing shot for last)
  // far better than a hardcoded room-type sort. We use the model's
  // ordering directly when ALL kept photos have a non-zero, unique
  // tourOrder. Otherwise we fall back to the legacy room-type sort.
  const keptArray = [...kept.values()];
  const allHaveTourOrder = keptArray.every((r) => r.tourOrder > 0);
  const tourOrders = keptArray.map((r) => r.tourOrder);
  const allTourOrdersUnique = new Set(tourOrders).size === tourOrders.length;

  let orderedKept;
  if (allHaveTourOrder && allTourOrdersUnique) {
    // Trust the model's ordering. Sort ascending by tourOrder.
    orderedKept = [...keptArray].sort((a, b) => a.tourOrder - b.tourOrder);
    // Hero override: if the model marked an isHero photo but it's not
    // already first, move it to position 1 (real-estate openers are
    // psychologically anchored on the first frame — better one strong
    // opener than the model's preferred sequence).
    const heroPick = orderedKept.find((r) => r.isHero);
    if (heroPick && orderedKept[0] !== heroPick) {
      orderedKept = [heroPick, ...orderedKept.filter((r) => r !== heroPick)];
    }
  } else {
    // Fallback: legacy room-type sort. Used when the model returned
    // duplicate or missing tourOrder values (rare with strict JSON schema).
    const heroPick = keptArray.find((r) => r.isHero) || null;
    orderedKept = keptArray
      .filter((r) => r !== heroPick)
      .sort((a, b) => {
        const ai = TOUR_ORDER.indexOf(a.roomType);
        const bi = TOUR_ORDER.indexOf(b.roomType);
        if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        return composite(b) - composite(a);
      });
    if (heroPick) orderedKept.unshift(heroPick);
  }

  // Step 6: emit the response shape the frontend wants.
  const curated = orderedKept.map((r, i) => ({
    photoId: r.photoId,
    order: i + 1,
    roomType: r.roomType,
    score: Math.round((r.pickWorthiness * 0.7 + r.quality * 0.3) * 10) / 10,
    reason: r.reason
  }));

  const rejectedFromValid = ranked
    .filter((r) => !kept.has(r.photoId))
    .map((r) => ({
      photoId: r.photoId,
      reason: r.reason || "Lower pick-worthiness than the chosen 24."
    }));
  const rejected = [
    ...skipped.map((r) => ({
      photoId: r.photoId,
      reason: r.reason || "AI marked this as not a tour-worthy room (paperwork, floor plan, etc.)."
    })),
    ...rejectedFromValid
  ];

  return { curated, rejected };
}

/* ============================================================
   Helpers
   ============================================================ */

function extractStructuredText(payload) {
  // Responses API: payload.output[0].content[0].text  (most common shape)
  // Sometimes:     payload.output_text  (newer SDK shape)
  if (typeof payload?.output_text === "string" && payload.output_text) return payload.output_text;
  const arr = payload?.output;
  if (!Array.isArray(arr)) return "";
  for (const block of arr) {
    const content = block?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type === "output_text" && typeof item?.text === "string") return item.text;
      if (item?.type === "text" && typeof item?.text === "string") return item.text;
    }
  }
  return "";
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function motionModel() {
  return process.env.OPENAI_CURATE_MODEL || process.env.OPENAI_MOTION_DIRECTOR_MODEL || DEFAULT_MODEL;
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
