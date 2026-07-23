// v23: explicit Vercel function timeout. Default for Node serverless is
// 60s on Pro plans. The Motion Director call (gpt-4.1-mini Vision on
// 12 photos + scene planning) typically completes in 25-50s but can hit
// 70s under OpenAI load. Budget 90s to keep functions alive past
// 'normal slow' without burning serverless minutes on truly hung requests.
export const config = {
  maxDuration: 90
};

import { requireUser } from "./_lib/auth.js";
import { rateLimit } from "./_lib/rate-limit.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";
// v35.2: 60s → 48s. The v34.2 verify pass (≤20s) and v34.3 polish (≤9s)
// stack ON TOP of this call inside the same 90s function — at 60s a slow
// OpenAI day left no headroom and the whole function died, shipping the
// deterministic fallback plan with stock narration ("Welcome to this
// listing" — test-17). 48 + 20 + 9 + overhead ≈ 80s, always inside the
// ceiling, and 48s still covers the p95 of the 16-image plan call.
const DEFAULT_TIMEOUT_MS = 48000;
// Number of photos sent to OpenAI Vision for actual visual analysis.
// Cost-controlled: at gpt-4.1-mini "low" detail, ~$0.002/image so 12 images =
// ~$0.024 per render. Photos beyond this cap are still INCLUDED in the edit
// plan — OpenAI just orders them via metadata (filename, upload order, etc.)
// instead of visual quality scoring.
const OPENAI_VISION_PHOTO_LIMIT = 16;
// v24 rebrand: target 30s default / 60s max per render. Each Cinematic AI
// scene is ~5 sec of Runway-rendered video, so 6 scenes = 30s and 12 scenes
// = 60s. Quick Reel scenes are shorter (~2-3s each) so 30s = ~10-12 scenes.
// MAX_PLAN_SCENES is the hard ceiling for the longest 60s render path.
// targetSceneCountFor() picks the actual count based on manifest.targetDurationSec.
// MAX_PLAN_SCENES drives the upper bound. v24.1 bumped from 12 to 16
// because predicted-Ken-Burns scenes are 2.8s (not 5s) so we need more
// of them to hit the 60s ceiling. v31 bumped 16 → 18: Veo scenes now
// average 3.5s, so a 60s target needs ~17 scenes.
const MAX_PLAN_SCENES = 18;
const DEFAULT_TARGET_DURATION_SEC = 30;
const MAX_TARGET_DURATION_SEC = 60;

// v24.1: predict which scenes will fall back to Ken Burns at render
// time so we can size the scene count correctly. Mirror the BALANCED
// guard logic in render-worker/src/runway-job.mjs::decideUseKenBurns.
// v24.5: balanced guard now only auto-falls-back KITCHENS. Bathrooms
// run through Runway unless risk >= 85 (rare on plan-time data); other
// rooms only at >= 90 (effectively never on a normal listing).
// So plan-time prediction shrinks to: kitchens fall back, everything
// else runs Runway. This makes avgSecPerScene math accurate for the
// new "≤1 KB per typical listing" target.
function predictKenBurnsFallback(roomType) {
  const room = String(roomType || "").toLowerCase();
  if (room === "kitchen") return true;
  // Everything else mostly runs through Runway.
  return false;
}

// Average per-scene duration used to compute scene count for a given
// target render length. Cinematic AI scenes that pass the guard are 5s
// (Runway native). Predicted fallbacks are 2.8s (Quick Reel Ken Burns).
function avgSecPerScene({ engine, hasKitchen, hasBathroom }) {
  // v31 (720p pivot): Veo scenes are now planned at 3-4s (3.5 avg) and
  // generated in 4s/6s buckets at 720p. 30s → ~8-9 scenes, 60s → ~17.
  // Denser cuts fit the beat cadences (1.5-2.6s targets) far better than the
  // old 5x6s plan, large listings get real coverage, and a 4s bucket costs
  // $0.60 vs the old forced 8s@1080p $1.20 — more scenes AND lower COGS.
  if (engine === "veo") return 3.5;
  if (engine !== "runway") return 2.8;
  // Mixed-engine math: assume a typical listing has ~1 kitchen + ~1
  // bathroom scene that will fall back. The rest are 5s Runway clips.
  // For 6 planned scenes with 2 fallbacks: (4*5 + 2*2.8)/6 = 3.93 avg.
  // We use 4.0 as a round number — close enough that 30s targets land
  // at 7-8 scenes and 60s targets land at 14-15 scenes.
  return 4.0;
}

const ROOM_TYPES = ["exterior", "kitchen", "living", "bedroom", "bathroom", "outdoor", "amenity", "detail"];
const CAMERA_MOTIONS = ["push_in", "pull_out", "lateral_pan", "vertical_reveal", "parallax_zoom", "detail_sweep"];
const TRANSITIONS = ["crossfade", "blur_wipe", "whip_pan", "match_cut", "light_leak"];
const RENDER_ENGINES = ["remotion", "runway", "veo"];

// Runway Gen-3 Turbo image-to-video prompt templates. These map our internal
// camera-motion taxonomy onto natural-language prompts that Runway responds well
// to. Every template ENDS with a hallucination-blocking constraint clause —
// real estate is one of the few AI-video use cases where any element morphing
// or imagined feature is a legal liability, not just an aesthetic problem.
// v24.3: REVERTED to v22-era motion prompts — these produced the good
// homepage hero video on a real luxury listing. The v23.3 rewrite
// ("confident dolly", "15% zoom", "locked tripod, no handheld jitter")
// was an over-correction for shake complaints. In practice, the strong
// language pushed Runway to over-commit to motion and produced more
// shape morphing on tight interior shots (rentals, small bedrooms).
// The original "subtle / slow / deliberate" vocabulary lets Gen-4
// produce gentler, more reliable camera moves that suit real-estate
// content. If shake recurs on a specific listing, troubleshoot per-
// scene rather than juicing the global prompts.
const RUNWAY_MOTION_PROMPTS = {
  push_in:
    "Slow cinematic camera push toward the focal subject. Subtle 6-8% zoom. Smooth, deliberate motion.",
  pull_out:
    "Slow cinematic camera pull-back revealing the full space. Subtle 6-8% reverse zoom. Smooth motion.",
  lateral_pan:
    "Smooth horizontal camera pan from left to right across the space. No vertical drift. Steady pace.",
  vertical_reveal:
    "Slow vertical camera tilt from lower foreground upward, revealing the full space. Cinematic reveal.",
  parallax_zoom:
    "Cinematic parallax push with subtle depth separation between foreground and background elements. 6-8% zoom. Soft.",
  detail_sweep:
    "Slow detail-focused camera move across an architectural feature. Tight framing. Soft, deliberate motion."
};

// Universal anti-hallucination constraint appended to every Runway prompt.
// MUST keep the full prompt under Runway's 1000-character limit on
// `promptText`. Earlier verbose version rejected every scene with HTTP
// 400. This compressed version preserves the same constraint coverage
// (no new objects, no plants, no people, no weather changes) in ~400
// chars so the motion + style + scene-description pieces fit too.
// v23.0: prompt versioning. Every audit row gets stamped with this version
// so we can correlate quality complaints / metrics with specific prompt
// iterations. Bump this whenever any of the prompt constants below change.
//
// Versioning convention:
//   <major>.<minor>  — major bumps for structural prompt rewrites,
//                      minor for individual clause tweaks.
//
// Changelog (last 5 versions):
//   v24.3 — REVERTED to v22-era subtle/slow/deliberate motion prompts.
//           v23.3 strong-language rewrite was over-correcting for shake
//           complaints and produced more morphing on tight interior shots.
//           v22 prompts produced the good homepage hero video on a real
//           luxury listing — match that.
//   v23.3 — Stronger motion prompts (dolly/track/crane vocab + 15% zoom).
//   v23.2 — Universal NO-NEW-FANS clause + living-room + outdoor constraints
//   v23.1 — MLS auto-strict guard, softer LUTs, model-driven photo tour order
//   v23.0 — Prompt versioning + B-roll integration + voice catalog
//   v22.0 — Hallucination Guard balanced/strict tiers + kitchen lockout
//   v26.0 — Phase 2 engine swap: Veo 3.1 Fast prompt system added
//           (VEO_MOTION_PROMPTS + VEO_STYLE_PROMPTS + buildVeoPrompt).
//           Explicit cinematography vocabulary validated by the June 9
//           laundry/pool bake-off. Scenes carry veoPrompt + runwayPrompt.
export const PROMPT_VERSION = "v26.0";

// v23.2 — Universal anti-hallucination clause now leads with the most
// common failure mode (phantom ceiling fans) AND covers ALL rooms, not
// just kitchen/bedroom. Real-world finding: Gen-4 Turbo invents tiny
// ceiling fans in living rooms, dining rooms, even covered patios.
// Naming the failure explicitly + universally is more effective than
// per-room callouts, because the model has been seen to invent fans in
// scenes our heuristic didn't tag with a fan-bearing roomType.
const RUNWAY_CONSTRAINT_CLAUSE =
  "STRICT FIDELITY: photorealistic, exactly the camera move described above with natural cinematic motion. " +
  "NO NEW CEILING FANS anywhere — if no fan visible in the source, do not add one. NO fan blades. NO new fixtures, no new lights, no new vents on any ceiling. " +
  "Every appliance, door, wall, window, fixture keeps its EXACT shape, design, count, and position. " +
  "Fridges keep their doors. Walls stay put — no new partitions or panels. " +
  "DO NOT add, remove, duplicate, morph, or redesign any object, plant, person, animal, vehicle, sign, text, water, fire, or particle. " +
  "Preserve original lighting, time of day, weather, sky. " +
  "Real estate film. MLS compliant.";

// Per-room anti-hallucination clauses. Injected into the prompt only when
// the scene's roomType matches. Gen-4 Turbo responds much better to
// SPECIFIC named objects ("the refrigerator", "the cabinet doors") than
// to abstract instructions ("preserve appliances"). Each clause names
// the actual physical items in that room to anchor the model's spatial
// understanding. Keep each clause under ~180 chars so the total prompt
// (motion + subject + visible + style + universal constraint + this)
// stays under Runway's 1000-char limit.
// Kitchen prompt names the specific Runway failure modes we keep seeing
// (split counters, phantom fans, microwave-on-fridge, doubled cabinet
// doors) so the model has explicit "do not" guidance. Gen-4 Turbo
// responds noticeably better when failures are named directly than to
// generic "preserve appliances" instructions. Kept under ~280 chars
// so total prompt stays under Runway's 1000-char limit.
const RUNWAY_ROOM_CONSTRAINTS = {
  kitchen:
    "Kitchen: refrigerator, oven, microwave, dishwasher, range, hood, sink, faucet, cabinets, drawers, countertops keep exact shape and count. Do not split, divide, or duplicate any countertop or cabinet face. No microwave doors on the refrigerator.",
  bathroom:
    "Bathroom: shower head, faucets, toilet, vanity, mirror, towel rack, tile patterns stay aligned and unchanged. No new tiles, no new fixtures, no duplicated faucets, no extra mirrors.",
  bedroom:
    "Bedroom: bed, headboard, nightstands, lamps, art, closet doors keep their exact shape and position. Bedding stays still. No duplicated lamps or pillows.",
  // v23.2: living-room added after Troy reported ceiling-fan hallucinations
  // appearing here. Same pattern as bedroom — name the fixed objects, lock
  // shapes. Universal constraint already covers fans.
  living:
    "Living room: sofa, chairs, coffee table, TV, fireplace, art, windows, blinds keep exact shape, count, and position. Cushions stay still. No duplicated lamps or pillows. No new artwork. Window treatments stay aligned.",
  // outdoor / exterior covered patios — another fan-hallucination hotspot
  outdoor:
    "Outdoor: every plant, tree, fence, structure, pool edge, deck board, patio cover, light fixture keeps exact shape and count. Sky stays still. No new outdoor lights or fans on patio covers. No new birds, animals, or people."
};

const RUNWAY_STYLE_PROMPTS = {
  "Cinematic Luxury":
    "Editorial luxury feel. Warm golden tones. Slow, deliberate, premium pacing.",
  "Modern Social":
    "Crisp, modern, social-ready energy. Clean color, slightly punched contrast.",
  "MLS Clean":
    "Neutral, accurate color. No stylization. Clean professional listing video aesthetic.",
  "Investor Tour":
    "Direct, factual cinematography. Neutral grade. Steady pacing without flourish."
};

/* =================================================================
   v26.0 — Veo 3.1 Fast prompt system (Phase 2 engine swap)

   Veo differs from Runway in three ways that shape these prompts:
   1. It follows the prompt LITERALLY — and the Jan-2026 Veo 3.1 update
      sharpened that further. Naming camera equipment ("tripod", "dolly",
      "slider") or a filming scenario ("documentary footage", "social
      reel") makes Veo RENDER it — a tripod, a crew, an operator — into
      the room. v27: describe camera MOVEMENT and the property as a
      "film" only; never name a rig or a shoot. (The June-9 bake-off ran
      on the older, less-literal Veo, which is why "locked tripod" passed
      then and hallucinates now.)
   2. It rewards scene-level art direction (lighting, atmosphere,
      lens feel), so style notes are written as a DP would brief.
   3. No 1000-char API limit, so we don't have to choose between
      motion vocabulary and constraints. The universal fidelity
      clause is appended WORKER-SIDE (VEO_FIDELITY_SUFFIX in
      runway-job.mjs) so it can never be dropped by prompt assembly.
   ================================================================= */
// v27 hallucination fix: motion described as camera MOVEMENT only, never by
// equipment ("dolly", "slider", "tripod"). The Jan-2026 Veo 3.1 update sharply
// improved prompt adherence, so naming a rig makes Veo render the rig (and an
// operator). These describe the move and the stability, with no nouns to render.
// v32.4: every forward move now carries a CLEAR-PATH clause — test-6 pushed
// the camera INTO a ceiling beam, wiping the frame with blurred wood. All
// pixels were "real", so fidelity checks couldn't object; the trajectory was
// the defect. Name it in the prompt AND in QC (occlusion_artifacts).
const CLEAR_PATH =
  " The camera path stays clear: it never moves into or through any foreground object, " +
  "beam, wall, plant, or furniture, and the room stays fully visible and well-framed for " +
  "the entire move.";
const VEO_MOTION_PROMPTS = {
  push_in:
    "The camera moves slowly and smoothly forward toward the focal point of the room, " +
    "about 6% total travel. Perfectly stable, no handheld sway, no vertical drift." + CLEAR_PATH,
  pull_out:
    "The camera moves slowly backward to reveal the full space, about 6% total travel. " +
    "Perfectly stable, constant speed, no drift." + CLEAR_PATH,
  lateral_pan:
    "The camera moves slowly sideways from left to right, level horizon throughout. " +
    "No rotation, no vertical movement." + CLEAR_PATH,
  vertical_reveal:
    "The view tilts gently upward from the lower foreground to reveal the full height of " +
    "the space. Slow, constant speed, perfectly stable." + CLEAR_PATH,
  parallax_zoom:
    "The camera moves slowly forward with natural depth parallax between foreground and " +
    "background. About 6% travel. Stable, deliberate, no shake." + CLEAR_PATH,
  detail_sweep:
    "The camera moves slowly across the architectural detail at close range, shallow depth " +
    "of field, tight framing. Constant speed, and the subject never becomes blocked or smeared."
};

// Per-mode art direction, written as a DP brief. Each mode also carries a
// pacing hint the Motion Director sees when planning scene order.
// v27 hallucination fix: these are written to mirror "Cinematic Luxury" (the
// style that's been rendering perfectly). The old wording for the other three
// named a FILMING SCENARIO — "documentary footage", "social-media reel",
// "walkthrough documentation", "camera work" — which Veo 3.1 (a generative
// image-to-video model) rendered literally as a person/crew with a tripod. We
// keep the look (light, color, pacing) but only ever describe the property as a
// "film", never a shoot. No equipment or filming-scene nouns.
const VEO_STYLE_PROMPTS = {
  "Cinematic Luxury":
    "Editorial luxury real-estate film. Warm golden-hour light quality, soft contrast, " +
    "gentle highlight rolloff. 35mm lens feel. Unhurried, premium pacing.",
  "Modern Social":
    "Bright, contemporary real-estate film. Clean daylight white balance, crisp detail, " +
    "lightly lifted contrast. 35mm lens feel. Calm, smooth, stable camera motion — the " +
    "modern energy comes from the bright, crisp grade, NOT from fast or dynamic movement.",
  "MLS Clean":
    "Clean, accurate real-estate film. True-to-life neutral color, no stylization, no " +
    "atmosphere effects. Natural lens feel. The room looks exactly as a buyer would see it " +
    "in person. Steady, even pacing.",
  "Investor Tour":
    "Factual, neutral real-estate film. Even exposure, clear sightlines, true-to-life color. " +
    "35mm lens feel. Steady, efficient pacing without flourish."
};

function buildVeoPrompt(scene, photos, context = {}) {
  const photo = photos.find((p) => p.id === scene.photoId) || {};
  const motionClause = VEO_MOTION_PROMPTS[scene.cameraMotion] || VEO_MOTION_PROMPTS.push_in;
  const styleClause = VEO_STYLE_PROMPTS[context.selectedStyle] || VEO_STYLE_PROMPTS["Cinematic Luxury"];
  // Named-object anchoring carries over from the Runway system — naming
  // the physical contents of the room anchors spatial understanding on
  // Veo too, and we no longer pay a character-budget price for it.
  const roomClause = RUNWAY_ROOM_CONSTRAINTS[scene.roomType] || "";
  const subject = describeSubject(scene, photo);
  // v27 AUDIT FIX: this is IMAGE-to-video — Veo already sees the photo. Naming a
  // spinning/animatable or text object here (e.g. "ceiling fan", "chandelier",
  // "sign") on the now-literal Veo can make it animate or mangle that object.
  // Drop those terms from the named-elements clause; keep the safe anchors.
  const RISKY_FEATURE_TERMS = /\b(fan|fans|ceiling fan|blade|blades|pendant|chandelier|propeller|turbine|sign|signage|logo|text|lettering|menu|license plate|clock|tv|television|screen|monitor)\b/i;
  const safeFeatures = (scene.visibleFeatures || []).filter((f) => !RISKY_FEATURE_TERMS.test(String(f)));
  const visibleClause = safeFeatures.length
    ? `Visible elements include: ${safeFeatures.slice(0, 4).join(", ")}.`
    : "";

  // Motion first, subject second, anchoring, then art direction. The
  // universal fidelity clause is appended by the worker — do NOT add it
  // here or it doubles up.
  const parts = [motionClause, `Subject: ${subject}.`, visibleClause, styleClause, roomClause];
  let combined = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (combined.length > 1800) combined = combined.slice(0, 1790) + " ...";
  return combined;
}

export default async function handler(request, response) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ status: "failed", error: "Use POST /api/create-edit-plan." });
    return;
  }

  // v26: auth + rate limit. This is the most expensive OpenAI call in the
  // product (Vision on up to 12 photos) and was previously open to anyone
  // with the URL.
  const auth = await requireUser(request, response);
  if (!auth.ok) return;
  const limited = await rateLimit(request, response, {
    bucket: "edit-plan",
    max: 20,
    windowMs: 60 * 60 * 1000
  });
  if (limited) return;

  const body = parseBody(request.body);
  const rawPhotos = Array.isArray(body.photos) ? body.photos : [];
  const invalidPhotoUrls = invalidInputPhotos(rawPhotos);
  if (invalidPhotoUrls.length) {
    logMotionDirector("warn", "invalid photo URLs rejected", {
      count: invalidPhotoUrls.length,
      ids: invalidPhotoUrls.map((photo) => photo.id).slice(0, 12)
    });
  }
  const photos = normalizeInputPhotos(rawPhotos);
  // Photos sent for VISION analysis are capped for cost. ALL photos are
  // referenced in the plan via metadata.
  const visionPhotos = photos.slice(0, OPENAI_VISION_PHOTO_LIMIT);
  const listingDetails = normalizeListingDetails(body.listingDetails || {});
  const brandKit = normalizeBrandKitForPrompt(body.brandKit || {});
  const selectedStyle = String(body.selectedStyle || "Cinematic Luxury");
  // v30 beat-sync: the CHOSEN music track filename (from the webapp's music
  // selector) so scene cuts snap to THIS track's beat grid, not the style
  // default. Was missing → snapping always used the style default's tempo,
  // so a non-default track played out of sync.
  const musicTrack = String(body.musicTrack || "").trim();
  const exportFormat = String(body.exportFormat || "vertical");
  const engine = RENDER_ENGINES.includes(String(body.engine || "")) ? String(body.engine) : "remotion";
  // v23.2: ALWAYS request narration lines in the edit plan. The worker
  // decides at render time whether to synthesize them (based on its OWN
  // ELEVENLABS_API_KEY env var + manifest.skipNarration flag). The old
  // gate checked process.env.ELEVENLABS_API_KEY on VERCEL — which is
  // wrong, because ElevenLabs is a WORKER concern, not a Vercel concern.
  // That gate caused edit plans to ship without narration text whenever
  // the Vercel deployment didn't happen to have the worker's key
  // configured (which was always, since it shouldn't be there). Result:
  // narration silently broken since launch.
  //
  // Now: edit plan always carries narrationLine per scene. Worker
  // gracefully no-ops if ElevenLabs isn't configured on its end.
  const includeNarration = body?.includeNarration !== false;
  // v24: 30s default, 60s ceiling. Frontend will pass this; older clients
  // omit it and get the 30s default.
  const targetDurationSec = Math.max(
    15,
    Math.min(MAX_TARGET_DURATION_SEC, Number(body?.targetDurationSec) || DEFAULT_TARGET_DURATION_SEC)
  );

  if (photos.length < 3) {
    const error = invalidPhotoUrls.length
      ? `Motion Director needs at least 3 durable public or signed listing photo URLs. ${invalidPhotoUrls.length} photo URL${invalidPhotoUrls.length === 1 ? " was" : "s were"} local, temporary, or missing.`
      : "Motion Director needs at least 3 uploaded listing photos.";
    logMotionDirector("warn", "fallback unavailable: fewer than 3 valid photos", {
      validPhotoCount: photos.length,
      invalidPhotoCount: invalidPhotoUrls.length,
      category: invalidPhotoUrls.length ? "invalid_photo_urls" : "too_few_photos"
    });
    response.status(400).json({
      status: "failed",
      error,
      errorCategory: invalidPhotoUrls.length ? "invalid_photo_urls" : "too_few_photos"
    });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    const reason = "Motion Director unavailable: missing OPENAI_API_KEY.";
    logMotionDirector("warn", "fallback reason", { category: "missing_openai_api_key", reason, validPhotoCount: photos.length });
    response.status(200).json({
      status: "fallback",
      reason,
      errorCategory: "missing_openai_api_key",
      editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec })
    });
    return;
  }

  try {
    const urlCheck = await validateRemotePhotos(visionPhotos);
    if (!urlCheck.valid) {
      const reason = `Motion Director unavailable: ${urlCheck.reason}`;
      logMotionDirector("warn", "invalid photo URLs rejected before OpenAI", {
        category: "inaccessible_image_url",
        reason,
        invalidPhotos: urlCheck.invalidPhotos
      });
      response.status(200).json({
        status: "fallback",
        reason,
        errorCategory: "inaccessible_image_url",
        editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec })
      });
      return;
    }

    logMotionDirector("info", "OpenAI request started", {
      photoCount: photos.length,
      visionPhotoCount: visionPhotos.length,
      maxScenes: Math.min(photos.length, MAX_PLAN_SCENES),
      selectedStyle,
      exportFormat,
      engine,
      model: motionModel(),
      timeoutMs: Number(process.env.OPENAI_MOTION_DIRECTOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
    });

    // v45.1 (m32b "audio broke"): ONE retry on 429/5xx before falling back.
    // During the July 10 rate-limit storm the single-shot call 429'd
    // straight into the deterministic fallback — and the fallback's
    // narration enrichment ALSO needs OpenAI, so the render shipped with a
    // 2-line script. Most 429 bursts clear in seconds; the retry uses a
    // shorter timeout so worst-case stays inside the function budget.
    const directorBody = JSON.stringify(buildOpenAIRequest({ allPhotos: photos, visionPhotos, listingDetails, selectedStyle, exportFormat, engine, brandKit, includeNarration, targetDurationSec }));
    const directorHeaders = {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    };
    let openaiResponse = await fetchWithTimeout(OPENAI_RESPONSES_URL, {
      method: "POST", headers: directorHeaders, body: directorBody
    }, Number(process.env.OPENAI_MOTION_DIRECTOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
    if (!openaiResponse.ok && (openaiResponse.status === 429 || openaiResponse.status >= 500)) {
      logMotionDirector("warn", `OpenAI ${openaiResponse.status} — retrying once in 4s`, { status: openaiResponse.status });
      await new Promise((r) => setTimeout(r, 4000));
      openaiResponse = await fetchWithTimeout(OPENAI_RESPONSES_URL, {
        method: "POST", headers: directorHeaders, body: directorBody
      }, Math.min(25000, Number(process.env.OPENAI_MOTION_DIRECTOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)));
    }

    const payload = await openaiResponse.json().catch(() => ({}));
    if (!openaiResponse.ok) {
      const openaiError = extractOpenAIError(openaiResponse, payload);
      const reason = userFacingOpenAIReason(openaiError);
      logMotionDirector("error", "OpenAI request failed; fallback used", openaiError);
      response.status(200).json({
        status: "fallback",
        reason,
        errorCategory: openaiError.category,
        requestId: openaiError.requestId,
        editPlan: await enrichFallbackPlan(
          deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec }),
          photos,
          { listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec }
        )
      });
      return;
    }

    const parsed = parseOpenAIJson(payload);
    // Validate against ALL photos — the AI is allowed to reference any of them.
    const validation = validateEditPlan(parsed, photos);
    if (!validation.valid) {
      logMotionDirector("warn", "JSON parse/validation failure; fallback used", {
        category: "schema_validation",
        reason: validation.error,
        outputId: payload.id || ""
      });
      response.status(200).json({
        status: "fallback",
        reason: `Motion Director unavailable: schema validation failed. ${validation.error}`,
        errorCategory: "schema_validation",
        editPlan: await enrichFallbackPlan(
          deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec }),
          photos,
          { listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec }
        )
      });
      return;
    }

    logMotionDirector("info", "OpenAI request succeeded", {
      sceneCount: parsed.scenes?.length || 0,
      heroPhotoId: parsed.heroPhotoId
    });
    // v23: validate then normalize. validateNormalizedPlan checks for
    // structural problems and length-clamp violations on the normalized
    // plan. (Renamed from validateEditPlan to avoid colliding with the
    // pre-existing validateEditPlan at line ~534 which checks the raw
    // OpenAI response shape — duplicate function declarations under ESM
    // strict mode threw SyntaxError and 500'd every request.)
    const preNormalizeValidation = validateNormalizedPlan(parsed, photos);
    const normalizedPlan = normalizeEditPlan(parsed, photos, { listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec });
    // v34.2 PER-PHOTO VERIFY-AND-REPAIR (test-11): the Motion Director call
    // juggles up to 16 images in one context and demonstrably degrades on
    // the LATER photos — test-11 labeled the twilight exterior "bedroom"
    // and the great room "kitchen", then narrated "the modern kitchen
    // includes wood cabinetry" over a living room. (The v33.3 category
    // reconciliation was a no-op: these photos carried no stored category.)
    // Repair = one cheap vision call PER SCENE, one photo per call — no
    // long-context decay possible — verifying the label and the line
    // against the actual pixels. Fail-open at every level: a dead repair
    // call keeps the original scene untouched.
    await verifyAndRepairScenes(normalizedPlan, photos, { listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec });
    // v34.3 GLOBAL POLISH (test-12): verify-and-repair fixed the FACTS but
    // cost the script its voice — 18 isolated single-photo calls share no
    // context, so they converge on identical captions ("bright living room
    // with cozy seating" spoken twice, "cozy" 4x, alt-text fragments, CTA
    // repaired away into a room description). Facts stay per-photo; STYLE
    // is global: one text-only pass sees the assembled script and rewrites
    // for variety, complete sentences, and a closing invitation — under a
    // hard rule that it may not add any feature the verified lines don't
    // already contain. No images in, so it cannot re-hallucinate the rooms.
    await polishNarrationFlow(normalizedPlan, { listingDetails, selectedStyle });
    // v32 observability: make the continuous script's presence LOUD in the
    // function logs — its absence was silent for a full smoke-test round.
    console.info(
      `[plan] narrationScript: ${normalizedPlan.narrationScript ? normalizedPlan.narrationScript.trim().split(/\s+/).length + " words" : "ABSENT (per-line fallback will run)"}`
    );
    // v33.4 observability: room ↔ line mapping, verifiable BEFORE spending
    // fal credits — test-10 spoke "kitchen" over the great room and the
    // mismatch was only discoverable by watching the finished video.
    for (const sc of normalizedPlan.scenes || []) {
      if (sc.narrationLine) console.info(`[plan] scene ${sc.order} (${sc.roomType}): "${sc.narrationLine}"`);
    }
    // v34.2 coverage fingerprint: spoken-scene count + window layout, so a
    // coverage collapse is visible in THIS log instead of in the finished
    // video 6 minutes later.
    {
      const all = normalizedPlan.scenes || [];
      const spoken = all.filter((s) => s.narrationLine).length;
      console.info(
        `[plan] narration coverage: ${spoken}/${all.length} scenes speak · windows ` +
        all.map((s) => (s.narrationLine ? `${(s.narrationWindowSec || 0).toFixed(1)}s` : "·")).join("|")
      );
    }
    const postNormalizeValidation = validateNormalizedPlan(normalizedPlan, photos);
    if (!preNormalizeValidation.ok) {
      logMotionDirector("warn", "Pre-normalize validation found issues; normalize step repaired them.", {
        errors: preNormalizeValidation.errors.slice(0, 5)
      });
    }
    response.status(200).json({
      status: "complete",
      editPlan: normalizedPlan,
      ...(preNormalizeValidation.errors.length || postNormalizeValidation.errors.length
        ? {
            validationWarnings: [
              ...preNormalizeValidation.errors,
              ...postNormalizeValidation.errors
            ].slice(0, 10)
          }
        : {})
    });
  } catch (error) {
    const category = error.name === "AbortError" ? "timeout" : "openai_exception";
    const reason = error.name === "AbortError" ? "Motion Director unavailable: planning service timed out." : `Motion Director unavailable: ${error.message || "planning request failed."}`;
    logMotionDirector("error", "OpenAI request exception; fallback used", {
      category,
      message: error.message || "",
      name: error.name || ""
    });
    response.status(200).json({
      status: "fallback",
      reason,
      errorCategory: category,
      editPlan: await enrichFallbackPlan(
        deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec }),
        photos,
        { listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec }
      )
    });
  }
}

function buildOpenAIRequest({ allPhotos, visionPhotos, listingDetails, selectedStyle, exportFormat, engine = "remotion", brandKit = {}, includeNarration = false, targetDurationSec = DEFAULT_TARGET_DURATION_SEC }) {
  // v24: target scene count is now duration-driven, not photo-count-driven.
  // 30s default = 6 Cinematic AI scenes (5s each) or 10-12 Quick Reel scenes
  // (2.5s avg). 60s = 12 Cinematic AI or up to MAX_PLAN_SCENES Quick Reel.
  // Always capped by available photos AND the hard MAX_PLAN_SCENES ceiling.
  const isCinematicAI = engine === "runway" || engine === "veo";
  const clampedDuration = Math.max(15, Math.min(MAX_TARGET_DURATION_SEC, Number(targetDurationSec) || DEFAULT_TARGET_DURATION_SEC));
  // v24.1: account for mixed-engine fallbacks. Runway-only assumed 5s/scene
  // which gave only 6 scenes at 30s — but when ~30% of scenes fall back
  // to 2.8s Ken Burns, total duration falls short of target. avgSecPerScene
  // assumes ~1 kitchen + ~1 bathroom fallback per listing and uses a
  // blended 4.0s average.
  const secPerScene = avgSecPerScene({ engine });
  const desiredScenes = Math.round(clampedDuration / secPerScene);
  const targetSceneCount = Math.min(allPhotos.length, MAX_PLAN_SCENES, Math.max(4, desiredScenes));

  // Narration guidance: real estate listing videos sound more professional
  // with CONTINUOUS narration across every scene. Sparse narration (the old
  // behavior: ~35% of scenes) produced long silent gaps that users
  // perceived as "voice broken after 5 seconds." Every scene now gets a
  // line; the AI is asked to vary length and cadence so it doesn't sound
  // monotonous.
  const narrationTargetCount = targetSceneCount;
  // v32: the PRIMARY narration deliverable is one continuous script; the
  // per-scene lines are kept for single-scene regen and as a fallback.
  const scriptWordTarget = Math.round(clampedDuration * 1.7);
  const narrationGuidance = includeNarration
    ? [
        `MOST IMPORTANT: also return a top-level field "narrationScript" — ONE continuous spoken voiceover for the ENTIRE tour. LENGTH IS A HARD REQUIREMENT: between ${Math.round(scriptWordTarget * 0.85)} and ${Math.round(scriptWordTarget * 1.1)} words — count them. A script shorter than ${Math.round(scriptWordTarget * 0.85)} words is WRONG and leaves most of the video silent. Write flowing spoken prose in the same order as the scenes: open by naming the property, give every major space its moment with natural transitions ("Through the entry…", "Out back…"), close with a brief call to action (keep just the final sentence under 8 words). No scene numbers, no headings, no stage directions — only words to be read aloud, as one connected piece. SCENE-SYNC DISCIPLINE (v50.3, non-negotiable): each sentence must FINISH while its own scene is still on screen — size every sentence to its scene's seconds at ~2 words/sec, and NEVER let a sentence about one space still be playing when a different room appears (a bathroom sentence narrating the patio is the exact defect this rule exists to kill). Prefer two short sentences over one long one; never describe two different rooms in one sentence; never mention a space before its scene arrives. THE OPENER MUST FIT ITS SCENE: if the full address is too long for scene 1's seconds, use the short street form ("Welcome to Hawks Nest Lane" not the full unit-numbered address) — a chopped first sentence ruins the whole video. NEVER READ ON-PHOTO TEXT into the narration: watermarks, MLS stamps, and staging disclosures ("AI staged", "virtually staged") printed on a photo are labels, not features — describe the room, never the label.`,
        `Add narrationLine to EVERY scene — all ${targetSceneCount} of them. Continuous narration sounds more professional than sparse voice with long silent gaps.`,
        `Each narrationLine is ONE complete natural sentence about ITS scene, sized to be spoken in roughly the scene's length at ~1.9 words/sec (3s scene ≈ 5 words, 4s ≈ 7, 6s hero ≈ 10). THE LINE MUST DESCRIBE WHAT IS VISIBLE IN THAT SCENE'S PHOTO — look at the image itself. If the room label and the image disagree, TRUST THE IMAGE. Never say "kitchen" over a photo with no kitchen in it; never mention rooms, fixtures, or features you cannot actually see in that photo. When unsure what a room is, describe what you see ("Light pours across the tile floors") instead of naming a room type. SELL THE SPACE, NOT THE STAGING (v34.4): never describe movable furniture or decor — sofas, tables, chairs, beds, rugs, lamps, art, plants. The furniture leaves with the seller; buyers are buying light, space, views, ceilings, windows, flooring, and finishes (cabinetry, counters, fireplaces, and built-ins are part of the home — those are fine). "A glass table sits beside the window" → "Expansive windows frame the red-rock views". CRITICAL: the lines are synthesized back-to-back as ONE continuous voiceover in scene order — so consecutive lines must READ AS A FLOWING TOUR: vary sentence openings, use occasional connective phrases ("Just beyond…", "Upstairs…"), and keep one consistent warm tone. Never write a fragment.`,
        // v40.1: style-aware narration tone (master-21: MLS Clean shipped
        // "stunning… breathtaking" — puffery on the broker-compliant style).
        /mls/i.test(selectedStyle || "")
          ? `NARRATION TONE — MLS CLEAN: strictly factual and neutral, broker-compliant. FORBIDDEN anywhere: "stunning", "breathtaking", "gorgeous", "luxurious", "beautiful", "dream", "wow", "warm", "inviting", "ambiance", "impressive", "captures attention", "must-see". The rule behind the list: NO subjective or emotional adjectives at all — state what is visible plainly (rooms, light, materials, views, dimensions). Plain CTA: "Schedule a tour today."`
          : /investor/i.test(selectedStyle || "")
          ? `NARRATION TONE — INVESTOR: direct and factual, like a walkthrough for a buyer who runs numbers. Features, spaces, materials, condition. FORBIDDEN: lifestyle and emotional language ("warm", "inviting", "ambiance", "impressive", "beautiful", "stunning", "charm"). Say "High ceilings and large windows" not "an impressive atmosphere". Plain CTA: "Schedule a walkthrough today."`
          : `NARRATION TONE: warm and confident, matched to the ${selectedStyle || "Cinematic Luxury"} style.`,
        `Scene 1 is the intro — name the property briefly. The FINAL scene is the CTA — keep it short and punchy (≤8 words) so it finishes cleanly BEFORE the closing brand card ("Schedule your private tour today"). Middle scenes describe what's on screen.`,
        `The agent's name is "${brandKit.fullName || "the listing agent"}", brokerage "${brandKit.brokerage || "their brokerage"}". Refer to them only on scene 1 and the outro CTA — don't repeat the name throughout.`,
        `Narration MUST stay grounded in the listing facts provided (price, beds, baths, sq ft, address) and what is visible in the photo. Never invent features, views, schools, or neighborhoods.`,
        `For detail or repeat-room shots, narrate the small thing the viewer sees — finishes, fixtures, light quality. Short observations work great here.`
      ].join(" ")
    : "Do NOT include narrationLine on any scene.";

  return {
    model: motionModel(),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You are Vistalia Motion Director, a professional real estate video editor.",
              "Build a cinematic edit plan from the uploaded listing photos.",
              "USE EVERY PHOTO PROVIDED — do not skip any. Each photo becomes one scene.",
              "Order the scenes as a professional property tour: exterior hero → entry → kitchen → living/great room → dining → primary bedroom → other bedrooms → bathrooms → outdoor/pool → neighborhood/amenities → detail/outro.",
              "Never invent property features, views, amenities, upgrades, materials, or room names.",
              "Only describe details visible in the image or user-provided listing facts.",
              `Allowed roomType values: ${ROOM_TYPES.join(", ")}.`,
              `Allowed cameraMotion values: ${CAMERA_MOTIONS.join(", ")}.`,
              `Allowed transition values: ${TRANSITIONS.join(", ")}.`,
              "Prefer vertical 9:16 pacing.",
              isCinematicAI
                // v31 (720p pivot): scenes are planned at 3-4s and generated
                // in 4s/6s Veo buckets. Bias toward 3-3.5s (lands in the
                // cheap 4s bucket after xfade compensation); allow 4-6s only
                // for hero shots. Faster cutting also matches Reels/TikTok
                // pacing and the per-style beat cadences.
                // v31.2 launch bias: lateral/parallax moves are where
                // object-glide artifacts live (objects tracking with the
                // camera). Depth-axis moves (push/pull) are the most stable
                // on image-to-video. Keep laterals rare and only where
                // there's real depth to traverse.
                ? "Engine is Cinematic AI (Veo image-to-video). Set scene duration to 3-3.5 seconds for most scenes; the exterior hero and one or two showcase rooms may run 4-6 seconds; never exceed 6. Camera motion: strongly prefer push_in (most stable). NEVER use pull_out — backward moves reveal frame-edge area the photo has no data for, and the model invents content there. Use lateral_pan or parallax_zoom ONLY for wide, open, deep spaces (large great rooms, exteriors with long sightlines) — never in furnished rooms shot at close or medium range. Use detail_sweep only on true close-up detail shots. For rooms with prominent exposed ceiling beams, low soffits, or large foreground obstructions near the camera, keep push_in but make it very slow and shallow so the camera never reaches the foreground."
                : "Engine is Quick Reel (Ken Burns photo motion). Scene duration 2.0–3.0s for kitchen/living, 1.6–2.4s for detail shots, 2.6–3.2s for hero shots.",
              narrationGuidance,
              "Return strict JSON only."
            ].join(" ")
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              listingDetails,
              selectedStyle,
              exportFormat,
              engine,
              targetSceneCount,
              instruction: `Generate exactly ${targetSceneCount} scenes — one per photo. Use every photo ID below. Photos with images visible to you should anchor the order; the rest should be inferred from filename and category.`,
              photos: allPhotos.map((photo, index) => ({
                id: photo.id,
                fileName: photo.fileName,
                uploadOrder: index + 1,
                category: photo.category || "",
                hasImage: index < visionPhotos.length
              }))
            })
          },
          // Visual analysis on the first N photos only — cost control
          ...visionPhotos.flatMap((photo) => [
            {
              type: "input_text",
              text: `Photo ID: ${photo.id}. Filename: ${photo.fileName}. Use this exact ID if selected.`
            },
            {
              type: "input_image",
              image_url: photo.url,
              detail: "high"
            }
          ])
        ]
      }
    ],
    text: {
      // Schema enum allows AI to reference ANY uploaded photo, not just visioned ones.
      format: editPlanTextFormat(allPhotos.map((photo) => photo.id), targetSceneCount, { includeNarration })
    },
    temperature: 0.2,
    max_output_tokens: 4000
  };
}

function motionModel() {
  return process.env.OPENAI_MOTION_MODEL || process.env.OPENAI_MOTION_DIRECTOR_MODEL || DEFAULT_MODEL;
}

/* ============================================================
   v34.2 — per-photo verify-and-repair
   ============================================================
   Why this exists: the Motion Director sees up to 16 photos in ONE
   context and its accuracy decays across them — the tail photos get
   generic labels ("bedroom", "kitchen") and template lines written from
   the LABEL instead of the pixels. Test-11 spoke "the modern kitchen
   includes wood cabinetry" over a great room with a picture window.

   The repair primitive is decay-proof by construction: one photo per
   call, so there is no long context to decay across. Each call verifies
   the scene's roomType and its narration line against that single image
   and returns corrections. Corrected labels also flow into rebuilt
   veo/runway prompts (subject description + hallucination-guard risk both
   key off roomType — test-11 burned a needless CONSTRAINED generation on
   "kitchen risk 80" for a photo that was never a kitchen).

   Failure posture: fail-open at every level. Any call that errors, times
   out, or returns junk leaves its scene exactly as the Motion Director
   wrote it. The pass as a whole is bounded by PLAN_VERIFY_BUDGET_MS so it
   can never push the function toward the 90s ceiling.
   Cost: ≤18 calls at "low" detail ≈ $0.01-0.02 per plan. */
const PLAN_VERIFY_BUDGET_MS = 20000;
const PLAN_VERIFY_PER_CALL_MS = 12000;
const PLAN_VERIFY_WAVE_SIZE = 6;

/* ============================================================
   v35.2 — fallback plan enrichment
   ============================================================
   When the Motion Director mega-call fails (timeout, OpenAI error,
   schema), the deterministic fallback plan used to ship STOCK narration
   ("Welcome to this listing" / "Schedule your private tour today" —
   test-17) — fine in the pre-narration era, unshippable now.

   The per-photo verify pass doesn't need the mega-call: one photo per
   request, a different latency class entirely. So the fallback now gets
   the same treatment as a real plan: greedy narration windows over the
   deterministic durations, verify writes real lines from the actual
   pixels (it fills narrated-but-empty scenes by design), polish makes
   them read as one voiceover. Stock lines become the fallback OF the
   fallback. Fail-open at every level. */
async function enrichFallbackPlan(plan, photos, context) {
  try {
    const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
    if (!scenes.length || !process.env.OPENAI_API_KEY) return plan;
    // Greedy window coverage — same algorithm as normalizeEditPlan v34.2.
    // v50.3: same room-family merge guard as the primary path (see
    // normalizeEditPlan) — windows never absorb a different room.
    const durations = scenes.map((s) => Number(s.duration) || 3);
    const MIN_WINDOW_SEC = 3.2;
    const FB_OUTDOOR_FAM = /exterior|outdoor|backyard|front|yard|patio|pool|garden|deck/;
    const fbSameFamily = (a, b) => {
      const ra = String(a || "").toLowerCase();
      const rb = String(b || "").toLowerCase();
      if (FB_OUTDOOR_FAM.test(ra) && FB_OUTDOOR_FAM.test(rb)) return true;
      return ra === rb;
    };
    const isNarrated = new Array(durations.length).fill(false);
    {
      let i = 0;
      while (i < durations.length) {
        isNarrated[i] = true;
        let w = durations[i];
        let j = i + 1;
        while (
          j < durations.length &&
          w < MIN_WINDOW_SEC &&
          fbSameFamily(scenes[i]?.roomType, scenes[j]?.roomType)
        ) {
          w += durations[j];
          j += 1;
        }
        i = j;
      }
    }
    if (isNarrated.length > 1) isNarrated[isNarrated.length - 1] = true;
    // v45.1 BLACKOUT-PROOF STOCK LINES (m32b): the old seeds were opener +
    // CTA only — every other narrated scene expected the per-scene OpenAI
    // repair pass to write its line. In a full rate-limit blackout those
    // calls all fail and the render ships a 2-line script over 50 seconds
    // of video. Seed EVERY narrated scene with a grounded, generic-safe
    // stock line keyed to its room type; when OpenAI is healthy, the
    // verify pass replaces them with photo-specific lines exactly as
    // before. Deliberately staging-free and feature-free — nothing a
    // stock line asserts can contradict the photo.
    const STOCK_LINES = {
      exterior: ["A striking first impression from the curb.", "Great presence from the street."],
      outdoor: ["Outdoor living, ready to enjoy.", "Room to breathe outside."],
      kitchen: ["The kitchen sits at the heart of the home.", "A kitchen made for gathering."],
      living: ["Natural light carries through the main living space.", "An easy, open flow through the living areas."],
      bedroom: ["A calm and comfortable retreat.", "Rest comes easy here."],
      bathroom: ["A clean, well-appointed bath.", "Simple, polished, and functional."],
      amenity: ["A standout feature of this home.", "An amenity buyers remember."],
      detail: ["The details set this one apart.", "Craftsmanship worth a closer look."]
    };
    // v45.3: per-line used-set — the v45.1 global counter let two scenes of
    // the same room type draw the IDENTICAL stock line ("the details set
    // this one apart" twice in one 25s render). Never repeat a line; if a
    // pool is exhausted, borrow the first unused line from any pool.
    const usedStock = new Set();
    const pickStock = (roomType) => {
      const pool = STOCK_LINES[String(roomType || "").toLowerCase()] || STOCK_LINES.living;
      for (const line of pool) if (!usedStock.has(line)) { usedStock.add(line); return line; }
      for (const anyPool of Object.values(STOCK_LINES)) {
        for (const line of anyPool) if (!usedStock.has(line)) { usedStock.add(line); return line; }
      }
      return ""; // every line used — better one silent scene than a repeat
    };
    scenes.forEach((s, i) => {
      if (!isNarrated[i]) {
        s.narrationWindowSec = 0;
        s.narrationLine = "";
        return;
      }
      let w = durations[i];
      for (let j = i + 1; j < durations.length && !isNarrated[j]; j++) w += durations[j];
      s.narrationWindowSec = Math.round(w * 100) / 100;
      // Keep the stock opener/CTA as seeds; verify rewrites or fills.
      s.narrationLine = String(s.narrationLine || "").trim();
      if (s.narrationLine) usedStock.add(s.narrationLine);
      if (!s.narrationLine && w >= 2.4) {
        s.narrationLine = pickStock(s.roomType);
      }
    });
    await verifyAndRepairScenes(plan, photos, context);
    await polishNarrationFlow(plan, context);
    const spoken = scenes.filter((s) => s.narrationLine).length;
    console.info(`[plan-fallback] deterministic plan enriched — ${spoken}/${scenes.length} scenes narrated from photos.`);
    for (const sc of scenes) {
      if (sc.narrationLine) console.info(`[plan-fallback] scene ${sc.order} (${sc.roomType}): "${sc.narrationLine}"`);
    }
  } catch (err) {
    console.warn(`[plan-fallback] enrichment failed open (${err.message}) — stock narration ships.`);
  }
  return plan;
}

/* ============================================================
   v34.3 — global narration polish
   ============================================================
   Runs AFTER verify-and-repair. Text-only (no images): takes the ordered,
   photo-verified lines and rewrites them as one flowing voiceover — line k
   stays welded to scene k, but the writer finally sees the whole script,
   which is the only place duplicates, adjective soup, and a missing close
   are even visible. Fact containment: the prompt forbids naming any room,
   feature, or object absent from the input line; with no images attached
   there is nothing new to describe. Fail-open: any error keeps the
   verified lines exactly as they are. */
// v53.7 (m73): 9s → 16s. The v53.5 completeness additions lengthened the
// polish prompt, and the one render where polish died on the new prompt
// shipped the worst script ever gated ("This living area features a
// fireplace." twice in a row, no CTA). Slower and present beats fast and
// dead — the plan budget absorbs it.
const PLAN_POLISH_TIMEOUT_MS = 16000;

// v53.7 — deterministic narration floor. Runs after polish WHETHER IT
// SUCCEEDED OR FAILED (m73: polish failed open and the raw verify drafts
// shipped with two identical lines, a bare fragment, and no closing CTA —
// the customer-visible fingerprint of a silent LLM failure). No model
// calls here; string ops only, so this floor cannot itself fail open:
//   - exact-duplicate lines (case/punct-insensitive): the later copy goes
//     silent — its window donates airtime (v34.2 machinery). Silence beats
//     hearing the same sentence twice.
//   - the final line MUST invite the tour (the v34.3 non-negotiable): if
//     polish died before enforcing it, force the canonical CTA.
// Returns { dupesSilenced, ctaForced, openerMonotony } for the log.
function enforceNarrationFloor(narrated) {
  const out = { dupesSilenced: 0, ctaForced: false, openerMonotony: false };
  if (!Array.isArray(narrated) || narrated.length === 0) return out;
  const seen = new Set();
  for (const s of narrated) {
    const key = String(s.narrationLine || "").trim().toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ");
    if (!key) continue;
    if (seen.has(key)) {
      s.narrationLine = "";
      out.dupesSilenced += 1;
    } else {
      seen.add(key);
    }
  }
  const spoken = narrated.filter((s) => String(s.narrationLine || "").trim());
  const last = spoken[spoken.length - 1];
  if (last && !/\b(tour|come see|see it)\b/i.test(last.narrationLine)) {
    last.narrationLine = "Schedule your private tour today.";
    out.ctaForced = true;
  }
  // Monotony telemetry: >half the lines opening with the same two words is
  // the template signature ("This living area…" ×4). Logged, not rewritten
  // — a deterministic rewriter would just be a worse template.
  const monotoneAt = (depth) => {
    const counts = {};
    for (const s of spoken) {
      const o = String(s.narrationLine).toLowerCase().split(/\s+/).slice(0, depth).join(" ");
      counts[o] = (counts[o] || 0) + 1;
    }
    return Object.values(counts).some((n) => n > Math.max(1, Math.floor(spoken.length / 2)));
  };
  out.openerMonotony = monotoneAt(1) || monotoneAt(2);
  return out;
}

// v50.5 (m61 "almost every sentence mentions wood") — deterministic
// repetition detector. The vision model writes each line from its own photo,
// so a wood cabin gets "wood" in every sentence and nobody in the pipeline
// ever hears the echo. This scan is lexical and cheap: stem material/feature
// families (wood/wooden/woodwork → wood), count how many LINES each family
// appears in, and flag anything present in more than two. The flags feed
// named constraints into the polish prompt, and a post-polish recount logs
// whether the fix landed (fail-open — repetitive beats silent).
const NARRATION_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "with", "of", "to", "in", "on", "for",
  "this", "that", "its", "is", "are", "has", "have", "your", "by", "at",
  "from", "into", "out", "up", "home", "room", "rooms", "area", "areas",
  "space", "spaces", "scene", "private", "tour", "today", "schedule",
  "come", "see", "features", "offers", "includes", "throughout"
]);
const NARRATION_STEM_FAMILIES = [
  "wood", "stair", "window", "light", "floor", "cabinet", "ceiling",
  "granite", "marble", "tile", "stone", "brick", "counter", "deck",
  "patio", "pool", "view", "modern", "natural", "spacious"
];
function narrationStem(raw) {
  let t = String(raw || "").toLowerCase().replace(/[^a-z\-]/g, "");
  if (t.length > 3 && t.endsWith("es")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s")) t = t.slice(0, -1);
  for (const fam of NARRATION_STEM_FAMILIES) {
    if (t.startsWith(fam)) return fam;
  }
  return t;
}
function repetitionFlags(lines, maxLines = 2) {
  const counts = new Map();
  lines.forEach((line, idx) => {
    const seen = new Set();
    for (const raw of String(line || "").split(/\s+/)) {
      const t = narrationStem(raw);
      if (!t || t.length < 4 || NARRATION_STOPWORDS.has(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      if (!counts.has(t)) counts.set(t, []);
      counts.get(t).push(idx + 1);
    }
  });
  const flags = [];
  for (const [term, lineIdxs] of counts) {
    if (lineIdxs.length > maxLines) flags.push({ term, lines: lineIdxs });
  }
  return flags.sort((a, b) => b.lines.length - a.lines.length);
}

async function polishNarrationFlow(plan, context) {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const narrated = scenes.filter((s) => String(s.narrationLine || "").trim());
  if (narrated.length < 2 || !process.env.OPENAI_API_KEY) {
    // v53.7: the deterministic floor applies even when polish is skipped.
    plan.narrationGuard = enforceNarrationFloor(narrated);
    return;
  }
  const t0 = Date.now();
  // v35.3: window-honest budgets (the old `isLast ? 6 : 3` floors inflated
  // lines past what tiny windows could hold → mid-word trims, test-19).
  // Scenes with sub-4-word windows are already silent by this point.
  const budgets = narrated.map((s, i) => {
    const isLast = i === narrated.length - 1;
    // v53.2: recalibrated to measured TTS (see normalize speakSec note).
    return Math.max(
      Math.floor((Number(s.narrationWindowSec || 0) - 0.65) * 2.1),
      isLast ? 4 : 4
    );
  });
  const inputList = narrated
    .map((s, i) =>
      `${i + 1} (${s.roomType}, max ${budgets[i]} words): "${s.narrationLine}"`)
    .join("\n");
  // v50.5: repetition constraints, computed deterministically from the
  // drafts and named explicitly in the prompt — "vary your vocabulary" is
  // ignorable; "the wood family appears in lines 1,3,4,5,6,8" is not.
  const repFlags = repetitionFlags(narrated.map((s) => s.narrationLine), 2);
  const repetitionClause = repFlags.length
    ? `- REPETITION DETECTED (deterministic scan of the drafts) — the #1 defect to fix: ` +
      repFlags.slice(0, 5).map((f) => `the "${f.term}" family appears in lines ${f.lines.join(",")}`).join("; ") +
      `. Keep each flagged family in at most TWO lines (pick the scenes where it matters most) and rewrite the ` +
      `others around DIFFERENT true qualities those lines already contain — light, space, texture, height, views, ` +
      `layout, warmth. Synonym-swapping ("wood"→"timber") does NOT count as fixing; change what the sentence is ` +
      `ABOUT. (m61 shipped "wood" in six consecutive sentences this way.)\n`
    : "";
  const prompt =
    `Polish the narration for a ${context.selectedStyle || "cinematic"} real-estate listing video. ` +
    `Each numbered line below narrates one scene, in order, and has been verified accurate against that scene's photo.\n` +
    `Rewrite them as ONE flowing voiceover. HARD RULES:\n` +
    `- Return exactly ${narrated.length} lines in the same order; line k still narrates scene k.\n` +
    `- Never name a room, feature, or object that line k's input does not already contain. ` +
    `You may drop details or generalize; never add, and never move a detail to a different line.\n` +
    `- Sell the SPACE, not the staging: if an input line mentions movable furniture or decor ` +
    `(sofas, tables, chairs, beds, rugs, lamps, art), rewrite around the permanent qualities that line ` +
    `already contains — light, windows, views, space. Furniture never appears in your output.\n` +
    `- Word caps are ABSOLUTE and cuts are ugly: a line over its cap gets machine-truncated ` +
    `mid-phrase in the final audio ("an entryway filled—"). Count your words; land at least one ` +
    `word UNDER every cap. USE the airtime you're given: for any line whose cap is 8 words or ` +
    `more, write exactly one word under the cap — a short line in a long window leaves seconds ` +
    `of dead silence in the video (m44 shipped a 3.5s hole this way). ` +
    `A 4-word complete sentence always beats a 9-word cut one. Every line ` +
    `stands alone as one complete spoken sentence with a subject and verb. Numbers and addresses count as their SPOKEN length ("356A" is four words, "Road 7" is three). Never end a line on a transitive verb ('The kitchen boasts.' is an error — m27 shipped it; one night's renders shipped 'roof crowns.', 'light fills.', 'exterior adds.', 'countertops blend.', 'tile work complements.') or a preposition ('cabinetry beneath.'): if the object doesn't fit the cap, write a shorter complete thought instead. Match determiners to their nouns ('this area', 'these areas' — never 'this dining areas'). Never split one idea ` +
    `across two lines, never open with a verb fragment.\n` +
    `- Variety: no two lines open with the same word; use each of ` +
    `"cozy", "bright", "spacious", "beautiful", "stunning", "modern" at most once across the whole script.\n` +
    repetitionClause +
    `- NON-NEGOTIABLE: the FINAL line is an INVITATION, never a description. It contains "tour" or ` +
    `"see" (e.g. "Schedule your private tour today." / "Come see it for yourself."). A room ` +
    `description in the final slot is an error. No address, no phone, no agent name.\n` +
    `- NEVER mention websites, URLs, phone numbers, or "more information" — contact details live on the end card, not in the voiceover.\n` +
    `- Warm, confident, unhurried tone. No exclamation marks, no questions, no "welcome to".\n` +
    // v40.1 (master-21, Troy): MLS Clean shipped "stunning… captures
    // attention… breathtaking" — puffery on the one style whose promise is
    // neutral and broker-compliant. Style-aware tone floor:
    (/mls/i.test(context.selectedStyle || "")
      ? `- MLS COMPLIANCE TONE (this is an MLS Clean video): strictly factual and neutral. ` +
        `FORBIDDEN words anywhere: "stunning", "breathtaking", "gorgeous", "luxurious", ` +
        `"beautiful", "dream", "wow", "warm", "inviting", "ambiance", "impressive", ` +
        `"captures attention", "must-see", "one of a kind". The rule behind the list: NO ` +
        `subjective or emotional adjectives at all — state what IS ` +
        `("The living room has vaulted ceilings and mountain views."). The final invitation ` +
        `stays plain: "Schedule a tour today."\n\n`
      : /investor/i.test(context.selectedStyle || "")
      ? `- INVESTOR TONE: direct and factual, for a buyer who runs numbers — features, ` +
        `materials, spaces, condition. FORBIDDEN: lifestyle/emotional language ("warm", ` +
        `"inviting", "ambiance", "impressive", "beautiful", "stunning", "charm"). ` +
        `Plain CTA: "Schedule a walkthrough today."\n\n`
      : `\n`) +
    inputList;
  try {
    const res = await fetchWithTimeout(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: motionModel(),
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        text: {
          format: {
            type: "json_schema",
            name: "narration_polish",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["lines"],
              properties: {
                // NOTE: no minItems/maxItems — strict-mode support for them
                // has been inconsistent and a schema 400 would silently kill
                // every polish. Length is enforced in code below instead.
                lines: {
                  type: "array",
                  items: { type: "string" }
                }
              }
            }
          }
        },
        temperature: 0.7,
        max_output_tokens: 700
      })
    }, PLAN_POLISH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`polish HTTP ${res.status}`);
    const payload = await res.json().catch(() => ({}));
    const verdict = parseOpenAIJson(payload);
    const lines = Array.isArray(verdict?.lines) ? verdict.lines : [];
    if (lines.length !== narrated.length) throw new Error(`polish returned ${lines.length}/${narrated.length} lines`);
    let applied = 0;
    for (let i = 0; i < narrated.length; i++) {
      const polished = clampNarrationSentenceSafe(cleanText(String(lines[i] || ""), 240), Math.max(budgets[i], 3));
      if (polished && polished !== narrated[i].narrationLine) {
        narrated[i].narrationLine = polished;
        applied += 1;
      }
    }
    console.info(`[plan-polish] ${applied}/${narrated.length} lines polished in ${Date.now() - t0}ms.`);
    // v50.5: recount after polish — the QC half of the repetition fix.
    // Fail-open (repetitive beats silent), but LOUD: the founder log now
    // says whether the echo was actually fixed.
    if (repFlags.length) {
      const after = repetitionFlags(narrated.map((s) => s.narrationLine), 2);
      const still = after.filter((f) => repFlags.some((g) => g.term === f.term));
      if (still.length === 0) {
        console.info(`[plan-polish] repetition QC: ${repFlags.length} flagged famil${repFlags.length === 1 ? "y" : "ies"} (${repFlags.map((f) => `${f.term}×${f.lines.length}`).join(", ")}) → clean after polish.`);
      } else {
        console.warn(`[plan-polish] repetition QC: STILL repetitive after polish — ${still.map((f) => `${f.term} in lines ${f.lines.join(",")}`).join("; ")} — shipping fail-open.`);
      }
    }
    plan.narrationPolish = `ok:${applied}/${narrated.length}`;
  } catch (err) {
    plan.narrationPolish = `failed:${String(err.message).slice(0, 80)}`;
    console.warn(`[plan-polish] failed open (${err.message}) — verified lines ship un-polished.`);
  }
  // v53.7: the floor runs on BOTH exits — see enforceNarrationFloor.
  const floor = enforceNarrationFloor(narrated);
  plan.narrationGuard = floor;
  if (floor.dupesSilenced || floor.ctaForced || floor.openerMonotony) {
    console.warn(`[plan-guard] narration floor acted: ${JSON.stringify(floor)} (polish=${plan.narrationPolish || "?"})`);
  }
}

async function verifyAndRepairScenes(plan, photos, context) {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  if (!scenes.length || !process.env.OPENAI_API_KEY) return;
  const isAiEngine = plan.engine === "runway" || plan.engine === "veo";
  const deadline = Date.now() + PLAN_VERIFY_BUDGET_MS;
  const t0 = Date.now();
  let labelFixes = 0;
  let lineFixes = 0;
  let checked = 0;

  const verifyOne = async (scene, isLastScene) => {
    const photo = photos.find((p) => p.id === scene.photoId);
    if (!photo?.url) return;
    const narrated = Number(scene.narrationWindowSec || 0) > 0;
    // v35.3 (test-19): the old Math.max(wordBudget, 6) floor UNDID the
    // normalize stage's window sizing — scenes whose 2.0s windows fit ~1
    // word got 6-word lines written back into them, and the mixer trimmed
    // them mid-sentence ("Vaulted ceilings with stone—"). Budgets are now
    // window-honest: a narrated scene whose window can't hold 4 words goes
    // SILENT instead (its airtime flows to the previous line via the
    // mixer's flowing-window model); only the CTA keeps a 4-word floor.
    // v53.2: recalibrated to measured TTS — see the speakSec note in
    // normalize. Same model at all three budget sites or they fight.
    const rawBudget = narrated
      ? Math.max(Math.floor((Number(scene.narrationWindowSec) - 0.65) * 2.1), isLastScene ? 4 : 0)
      : 12;
    const lineWritable = !narrated || rawBudget >= 4;
    const wordBudget = rawBudget;
    if (narrated && !lineWritable && scene.narrationLine) {
      console.info(`[plan-verify] scene ${scene.order}: window too small for a sentence (budget ${rawBudget}) — going silent, airtime donates back.`);
      scene.narrationLine = "";
    }
    const currentLine = String(scene.narrationLine || "").trim();
    const prompt =
      `One photo from a real-estate listing video. Current scene label: "${scene.roomType}". ` +
      `Current narration line: ${currentLine ? `"${currentLine}"` : "(none)"}.\n` +
      `Return JSON:\n` +
      `- roomType: what THIS photo actually shows. exterior = any facade shot incl. twilight/dusk; ` +
      `living = any living/family/great room; outdoor = patio, deck, yard, pool; ` +
      `detail = close-up vignette; else kitchen, bedroom, bathroom, amenity.\n` +
      `- lineAccurate: true ONLY if the current line describes things clearly visible in THIS photo ` +
      `AND is about the home itself rather than its staging. ` +
      `false if it names a different room, invents features, or is mainly about movable furniture/decor ` +
      `(sofas, tables, chairs, beds, rugs, lamps, art). (No current line → false.)\n` +
      `- line: if lineAccurate is false, ONE warm natural narration sentence, at most ${Math.max(wordBudget, 4)} words, ` +
      `about what is clearly visible in this photo — sell the SPACE: light, views, windows, ceilings, flooring, ` +
      `finishes, built-ins, cabinetry. Never mention movable furniture or decor. No invented features, no address, no price. ` +
      `The sentence must END on a noun or adjective — never on a verb missing its object ` +
      `("light fills.", "roof crowns." are errors) or a preposition ("cabinetry beneath."). ` +
      `Match determiners to nouns ("this area", "these areas"). ` +
      `Vary structure: NEVER the skeleton "This <room> features <thing>" — lead with the concrete ` +
      `subject instead ("A stone fireplace anchors the living room", "Morning light pours across the island"). ` +
      `If lineAccurate is true, repeat the current line exactly.`;
    const body = {
      model: motionModel(),
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: photo.url, detail: "low" }
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "scene_verify",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["roomType", "lineAccurate", "line"],
            properties: {
              roomType: { type: "string", enum: ROOM_TYPES },
              lineAccurate: { type: "boolean" },
              line: { type: "string" }
            }
          }
        }
      },
      temperature: 0.1,
      max_output_tokens: 120
    };
    const res = await fetchWithTimeout(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }, Math.min(PLAN_VERIFY_PER_CALL_MS, Math.max(1500, deadline - Date.now())));
    if (!res.ok) throw new Error(`verify HTTP ${res.status}`);
    const payload = await res.json().catch(() => ({}));
    const verdict = parseOpenAIJson(payload);
    if (!verdict || typeof verdict !== "object") throw new Error("verify: unparseable verdict");
    checked += 1;

    // Label repair — flows into prompts + hallucination-guard risk.
    if (ROOM_TYPES.includes(verdict.roomType) && verdict.roomType !== scene.roomType) {
      console.info(`[plan-verify] scene ${scene.order}: label ${scene.roomType} → ${verdict.roomType}`);
      scene.roomType = verdict.roomType;
      if (isAiEngine) {
        scene.runwayPrompt = buildRunwayPrompt(scene, photos, context);
        scene.veoPrompt = buildVeoPrompt(scene, photos, context);
      }
      labelFixes += 1;
    }

    // Line repair — ONLY on narrated scenes with a window big enough to
    // hold a sentence (silent scenes must stay silent; their airtime is
    // already donated to the previous window).
    if (narrated && lineWritable && verdict.lineAccurate !== true) {
      const repaired = clampNarrationSentenceSafe(cleanText(String(verdict.line || ""), 240), Math.max(wordBudget, 4));
      if (repaired && repaired !== currentLine) {
        console.info(
          `[plan-verify] scene ${scene.order}: line ${currentLine ? "rewritten" : "filled"} → "${repaired}"`
        );
        scene.narrationLine = repaired;
        lineFixes += 1;
      }
    }
  };

  try {
    for (let w = 0; w < scenes.length; w += PLAN_VERIFY_WAVE_SIZE) {
      if (Date.now() > deadline - 2000) {
        console.warn(`[plan-verify] budget reached after ${checked}/${scenes.length} scenes — remaining scenes ship as planned.`);
        break;
      }
      const wave = scenes.slice(w, w + PLAN_VERIFY_WAVE_SIZE);
      const results = await Promise.allSettled(
        wave.map((scene) => verifyOne(scene, scene === scenes[scenes.length - 1]))
      );
      for (let k = 0; k < results.length; k++) {
        if (results[k].status === "rejected") {
          console.warn(`[plan-verify] scene ${wave[k].order} verify failed (${results[k].reason?.message || results[k].reason}) — keeping original.`);
        }
      }
    }
    console.info(
      `[plan-verify] ${checked}/${scenes.length} scenes verified in ${Date.now() - t0}ms — ` +
      `${labelFixes} label${labelFixes === 1 ? "" : "s"} corrected, ${lineFixes} line${lineFixes === 1 ? "" : "s"} repaired.`
    );
  } catch (err) {
    console.warn(`[plan-verify] pass failed open (${err.message}) — plan ships as the Motion Director wrote it.`);
  }
}

// v32.3: never ship a skeleton script. Target ≈ 1.7 words/sec; below 60% of
// that, the model under-delivered (test-6: 8 words → 34s of silence) — fall
// back to the per-scene lines joined into one read. They're grounded per-room
// and collectively right-sized, so the floor is always a competent script.
function enforceScriptFloor(script, scenes, targetDurationSec) {
  const target = Math.round(targetDurationSec * 1.7);
  const words = String(script || "").trim() ? script.trim().split(/\s+/).length : 0;
  if (words >= Math.round(target * 0.6)) {
    console.info(`[plan] narrationScript length OK: ${words}/${target} words`);
    return script;
  }
  const joined = (scenes || [])
    .map((s) => String(s.narrationLine || "").trim())
    .filter(Boolean)
    .join(" ");
  const joinedWords = joined ? joined.split(/\s+/).length : 0;
  console.warn(
    `[plan] narrationScript UNDER FLOOR (${words}/${target} words) — ` +
    (joinedWords >= 8
      ? `rebuilt from ${joinedWords} words of per-scene lines.`
      : `per-scene lines also empty; leaving script as-is.`)
  );
  return joinedWords >= 8 ? joined : script;
}

// v33.3: map classify-image categories → scene roomTypes. Categories come
// from a dedicated one-photo-per-call vision pass, so when present they
// outrank the Motion Director's roomType guess.
function roomTypeFromCategory(category) {
  const c = String(category || "").toLowerCase();
  if (!c) return "";
  if (c.includes("exterior")) return "exterior";
  if (c.includes("kitchen")) return "kitchen";
  if (c.includes("living")) return "living";
  if (c.includes("bedroom")) return "bedroom";
  if (c.includes("bathroom")) return "bathroom";
  if (c.includes("outdoor") || c.includes("backyard")) return "outdoor";
  if (c.includes("amenity")) return "amenity";
  if (c.includes("detail")) return "detail";
  return "";
}

function editPlanTextFormat(photoIds, targetSceneCount, options = {}) {
  return {
    type: "json_schema",
    name: "estate_motion_edit_plan",
    strict: true,
    schema: editPlanSchema(photoIds, targetSceneCount, options)
  };
}

function editPlanSchema(photoIds, targetSceneCount, { includeNarration = false } = {}) {
  // Min/max scenes: aim for the target but allow ±1 slack so the AI doesn't
  // get stuck if a photo is genuinely unusable (e.g. duplicated from upload).
  const minScenes = Math.max(3, Math.min(targetSceneCount - 1, photoIds.length));
  const maxScenes = Math.min(MAX_PLAN_SCENES, photoIds.length);

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      heroPhotoId: { type: "string", enum: photoIds },
      exportFormat: { type: "string" },
      selectedStyle: { type: "string" },
      musicMood: { type: "string" },
      // v32 continuous narration: ONE flowing voiceover for the whole tour.
      // ROOT-CAUSE NOTE (round-5 smoke test): this field was instructed in
      // the prompt but MISSING from this strict schema — strict structured
      // outputs cannot return unlisted properties, so the model never
      // produced it and the mixer silently fell back to the per-line path.
      // Schema is the contract; prompt text alone is dead letter.
      ...(includeNarration ? {
        narrationScript: { type: ["string", "null"], maxLength: 1400 }
      } : {}),
      introCard: {
        type: "object",
        additionalProperties: false,
        properties: {
          headline: { type: "string" },
          subline: { type: "string" }
        },
        required: ["headline", "subline"]
      },
      outroCard: {
        type: "object",
        additionalProperties: false,
        properties: {
          headline: { type: "string" },
          subline: { type: "string" }
        },
        required: ["headline", "subline"]
      },
      scenes: {
        type: "array",
        minItems: minScenes,
        maxItems: maxScenes,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            photoId: { type: "string", enum: photoIds },
            order: { type: "integer", minimum: 1, maximum: MAX_PLAN_SCENES },
            roomType: { type: "string", enum: ROOM_TYPES },
            visibleFeatures: {
              type: "array",
              maxItems: 5,
              items: { type: "string" }
            },
            qualityScore: { type: "number", minimum: 0, maximum: 100 },
            // Allow up to 6s — Cinematic AI worker uses 5 or 10s based on this.
            duration: { type: "number", minimum: 1.2, maximum: 6 },
            cameraMotion: { type: "string", enum: CAMERA_MOTIONS },
            transition: { type: "string", enum: TRANSITIONS },
            overlay: {
              type: "object",
              additionalProperties: false,
              properties: {
                headline: { type: "string" },
                subline: { type: "string" }
              },
              required: ["headline", "subline"]
            },
            // Optional voiceover line. Empty string OR null = silent scene.
            // Capped at ~140 chars so a single ElevenLabs call stays cheap
            // and the voice fits comfortably inside a 5s scene at
            // conversational speaking rate (~150 wpm). OpenAI strict mode
            // requires every listed property to also appear in `required`,
            // so we model "optional" as "string or null" and require it.
            ...(includeNarration ? {
              narrationLine: { type: ["string", "null"], maxLength: 140 }
            } : {})
          },
          required: includeNarration
            ? ["photoId", "order", "roomType", "visibleFeatures", "qualityScore", "duration", "cameraMotion", "transition", "overlay", "narrationLine"]
            : ["photoId", "order", "roomType", "visibleFeatures", "qualityScore", "duration", "cameraMotion", "transition", "overlay"]
        }
      }
    },
    required: includeNarration
      ? ["heroPhotoId", "exportFormat", "selectedStyle", "musicMood", "narrationScript", "introCard", "outroCard", "scenes"]
      : ["heroPhotoId", "exportFormat", "selectedStyle", "musicMood", "introCard", "outroCard", "scenes"]
  };
}

function deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack = "", exportFormat, engine = "remotion", includeNarration = false, targetDurationSec = DEFAULT_TARGET_DURATION_SEC }) {
  const ranked = photos
    .map((photo, index) => ({
      ...photo,
      roomType: inferRoomType(photo, index),
      qualityScore: qualityScore(photo, index)
    }))
    .sort((a, b) => roomRank(a.roomType) - roomRank(b.roomType) || b.qualityScore - a.qualityScore);
  // v24.1: scene count duration-driven, accounting for mixed-engine
  // fallbacks (kitchens + bathrooms drop to 2.8s Ken Burns, rest are
  // 5s Runway). Blended 4.0s/scene average for Cinematic AI.
  const clampedDuration = Math.max(15, Math.min(MAX_TARGET_DURATION_SEC, Number(targetDurationSec) || DEFAULT_TARGET_DURATION_SEC));
  const secPerScene = avgSecPerScene({ engine });
  const desiredScenes = Math.min(
    MAX_PLAN_SCENES,
    Math.max(4, Math.round(clampedDuration / secPerScene))
  );
  const unique = [];
  const used = new Set();
  ranked.forEach((photo) => {
    if (unique.length < desiredScenes && !used.has(photo.id)) {
      used.add(photo.id);
      unique.push(photo);
    }
  });
  const scenes = unique.map((photo, index) => {
    const roomType = photo.roomType;
    const isLast = index === unique.length - 1;
    return {
      photoId: photo.id,
      order: index + 1,
      roomType,
      visibleFeatures: fallbackVisibleFeatures(photo, roomType),
      qualityScore: photo.qualityScore,
      duration: durationFor(roomType, selectedStyle, index, engine),
      cameraMotion: motionFor(roomType, selectedStyle, index),
      transition: transitionFor(roomType, selectedStyle, index),
      overlay: overlayFor(roomType, listingDetails, index),
      narrationLine: includeNarration ? fallbackNarrationFor(roomType, listingDetails, index, isLast) : ""
    };
  });
  return normalizeEditPlan({
    source: "deterministic-fallback",
    // v32: fallback continuous script = the per-scene lines joined into one
    // read. Less elegant than the Motion Director's, but flows in one pass.
    narrationScript: includeNarration
      ? scenes.map((s) => String(s.narrationLine || "").trim()).filter(Boolean).join(" ")
      : "",
    heroPhotoId: scenes[0]?.photoId || photos[0]?.id,
    exportFormat,
    selectedStyle,
    musicMood: musicMoodFor(selectedStyle),
    introCard: {
      headline: listingDetails.address || "Featured listing",
      subline: [listingDetails.price, listingDetails.beds ? `${listingDetails.beds} BD` : "", listingDetails.baths ? `${listingDetails.baths} BA` : "", listingDetails.squareFeet ? `${listingDetails.squareFeet} SQ FT` : ""].filter(Boolean).join(" · ")
    },
    outroCard: {
      headline: listingDetails.agentName || "Schedule a private tour",
      subline: listingDetails.brokerage || listingDetails.cta || "Contact the listing agent"
    },
    scenes
  }, photos, { listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec });
}

function validateEditPlan(plan, photos) {
  if (!plan || typeof plan !== "object") return { valid: false, error: "Edit plan is not an object." };
  const photoIds = new Set(photos.map((photo) => photo.id));
  if (!photoIds.has(plan.heroPhotoId)) return { valid: false, error: "Edit plan heroPhotoId does not match uploaded photos." };
  if (!Array.isArray(plan.scenes) || plan.scenes.length < 3) return { valid: false, error: "Edit plan must include at least 3 scenes." };
  const seen = new Set();
  for (const scene of plan.scenes) {
    if (!photoIds.has(scene.photoId)) return { valid: false, error: "Edit plan includes a photoId that was not uploaded." };
    if (seen.has(scene.photoId)) return { valid: false, error: "Edit plan repeats a photoId." };
    seen.add(scene.photoId);
    if (!ROOM_TYPES.includes(scene.roomType)) return { valid: false, error: "Edit plan includes an unsupported roomType." };
    if (!CAMERA_MOTIONS.includes(scene.cameraMotion)) return { valid: false, error: "Edit plan includes an unsupported cameraMotion." };
    if (!TRANSITIONS.includes(scene.transition)) return { valid: false, error: "Edit plan includes an unsupported transition." };
  }
  return { valid: true, error: "" };
}

// ── Beat-timed transitions (v29) ──────────────────────────────────────────
// Per-track musical grids, measured offline (librosa) from the bundled
// render-worker/music/*.mp3. We snap scene CUT points to these so transitions
// land on the beat. `beat`/`bar` = seconds between beats / bars; `firstBeat` =
// where the first beat lands. Music plays from t=0, so cuts snap to the
// phase-aligned grid (firstBeat + n*unit) — no music re-timing needed.
const BEAT_GRID = {
  "luxury-poradovskyi.mp3": { beat: 0.627, bar: 2.508, firstBeat: 0.21 },
  // ── Pixabay picks (measured via librosa) ──
  // Cinematic Luxury
  "leberch-piano-516448.mp3":                            { beat: 0.372, bar: 1.486, firstBeat: 0.16 },
  "jonasblakewood-emotional-527472.mp3":                 { beat: 0.511, bar: 2.043, firstBeat: 0.12 },
  "tunetank-inspiring-cinematic-music-409347.mp3":       { beat: 1.091, bar: 4.365, firstBeat: 0.07 },
  "atlasaudio-cinematic-softness-511863.mp3":            { beat: 0.813, bar: 3.251, firstBeat: 0.39 },
  "paulyudin-piano-piano-music-508963.mp3":              { beat: 0.488, bar: 1.950, firstBeat: 0.07 },
  // Modern Social
  "the_mountain-pop-490010.mp3":                         { beat: 0.511, bar: 2.043, firstBeat: 0.07 },
  "jonasblakewood-pop-524132.mp3":                       { beat: 0.464, bar: 1.858, firstBeat: 0.21 },
  "jonasblakewood-pop-dance-friends-frequencies-445891.mp3": { beat: 0.650, bar: 2.601, firstBeat: 0.14 },
  "eliveta-uplifting-pop-491240.mp3":                    { beat: 0.720, bar: 2.879, firstBeat: 0.35 },
  "prettyjohn1-pop-pop-music-503314.mp3":                { beat: 0.488, bar: 1.950, firstBeat: 0.07 },
  // MLS Clean
  "nastelbom-corporate-soft-488321.mp3":                 { beat: 0.604, bar: 2.415, firstBeat: 0.07 },
  "leberch-corporate-509707.mp3":                        { beat: 0.534, bar: 2.136, firstBeat: 0.14 },
  "daily-business-anthe-elegant-corporate-brand-541377.mp3": { beat: 0.534, bar: 2.136, firstBeat: 0.07 },
  "jonasblakewood-corporate-background-524146.mp3":      { beat: 0.511, bar: 2.043, firstBeat: 1.30 },
  // Investor Tour
  "the_mountain-corporate-455905.mp3":                   { beat: 0.511, bar: 2.043, firstBeat: 1.53 },
  "atlasaudio-corporate-corporate-music-507826.mp3":     { beat: 0.372, bar: 1.486, firstBeat: 0.07 },
  "prettyjohn1-corporate-corporate-music-483403.mp3":    { beat: 0.580, bar: 2.322, firstBeat: 0.07 },
  "jonasblakewood-upbeat-corporate-533853.mp3":          { beat: 0.534, bar: 2.136, firstBeat: 0.21 }
};
// Per-style default track (display name → filename) + snap aggressiveness.
// Modern Social = punchy downbeat ("bar") cuts; others = subtle nearest-beat.
const STYLE_DEFAULT_TRACK = {
  "Cinematic Luxury": "luxury-poradovskyi.mp3",
  "Modern Social": "the_mountain-pop-490010.mp3",
  "MLS Clean": "nastelbom-corporate-soft-488321.mp3",
  "Investor Tour": "the_mountain-corporate-455905.mp3"
};
// Per-style TARGET cut cadence (seconds between cuts). This is the editorial
// "feel" of each style; the actual snap unit is derived PER TRACK from its
// tempo (below), so a 55-BPM cinematic bed and a 130-BPM pop track each land
// on their own musical grid instead of a blanket beat/bar rule.
//   Luxury  → slow, editorial ~2-3s      Social   → punchy, Reels-fast ~1-1.5s
//   MLS     → calm, unobtrusive ~2-2.5s   Investor → confident ~2s
const STYLE_TARGET_CADENCE = {
  "Cinematic Luxury": 2.6,
  "Modern Social": 1.5,
  "MLS Clean": 2.2,
  "Investor Tour": 2.0
};
const DEFAULT_TARGET_CADENCE = 2.2;

// Pick the snap unit (in seconds) for a track: the musical subdivision —
// 1 beat, half-bar (2), bar (4), or 2-bar (8 beats) — whose length is closest
// to the style's target cadence. Uses the track's MEASURED beat/bar, so the
// choice adapts to tempo: fast tracks land on half-bars/bars (still punchy at
// their BPM), slow tracks on beats/half-bars (so cuts don't drift too far
// apart). Returns 0 if the grid is unusable → caller skips snapping.
function chooseSnapUnitSec(grid, targetSec) {
  if (!grid || !(grid.beat > 0)) return 0;
  const bar = grid.bar > 0 ? grid.bar : grid.beat * 4;
  const candidates = [grid.beat, grid.beat * 2, bar, bar * 2]; // 1, 2, 4, 8 beats
  return candidates.reduce(
    (best, c) => (Math.abs(c - targetSec) < Math.abs(best - targetSec) ? c : best),
    candidates[0]
  );
}

// Snap scene cut points to the music beat grid so transitions land on the beat.
// `unit` is the per-track snap interval (seconds) from chooseSnapUnitSec. Each
// scene stays within [MIN, 8s] and — importantly — snapped boundaries stay
// grid-aligned even when clamped (MIN is a whole number of units, not a flat
// floor). Fail-safe: returns input unchanged if grid/unit is invalid, so a
// render can never break on this.
function snapDurationsToBeat(durations, grid, unit) {
  if (!grid || !(unit > 0)) return durations;
  const MAX_D = 8;
  // v31 pipeline-audit fix: EPS guards on every boundary comparison. Without
  // them, float error (d = 2.9719999999999995 vs MIN_D = 2.972) tripped the
  // MIN branch, whose ceil() of a value an epsilon ABOVE a whole number then
  // jumped a full extra unit — silently DOUBLING random scenes on tracks
  // whose unit divides evenly (e.g. leberch-piano at 2.972s). Doubled scenes
  // broke pacing, overshot the target duration by up to ~35%, and pushed 4s
  // fal buckets to 8s (2x COGS on those scenes).
  const EPS = 1e-6;
  // Minimum scene = the fewest whole units that clear ~1.6s, so short scenes
  // still snap to a real grid point instead of an off-grid flat minimum.
  const minUnits = Math.max(1, Math.ceil(1.6 / unit - EPS));
  const MIN_D = Math.min(minUnits * unit, MAX_D);
  const out = [];
  let cum = 0;
  for (let i = 0; i < durations.length; i++) {
    const targetEnd = cum + durations[i];
    const k = Math.round((targetEnd - grid.firstBeat) / unit);
    let d = grid.firstBeat + k * unit - cum;
    if (d < MIN_D - EPS) {
      const kMin = Math.ceil((cum + MIN_D - grid.firstBeat) / unit - EPS);
      d = grid.firstBeat + kMin * unit - cum;
    }
    if (d > MAX_D + EPS) {
      const k2 = Math.floor((cum + MAX_D - grid.firstBeat) / unit + EPS);
      const d2 = grid.firstBeat + k2 * unit - cum;
      d = d2 >= MIN_D - EPS && d2 <= MAX_D + EPS ? d2 : MAX_D;
    }
    d = Number(d.toFixed(3));
    out.push(d);
    cum += d;
  }
  return out;
}

function normalizeEditPlan(plan, photos, context) {
  const photoIds = new Set(photos.map((photo) => photo.id));
  const engine = RENDER_ENGINES.includes(context.engine) ? context.engine : "remotion";
  // Cinematic AI: clip duration up to 10 (worker decides 5 vs 10 based on >5.5 boundary).
  // Quick Reel: clip duration capped at 5 (Ken Burns shouldn't sit on one photo longer).
  // v31 (720p pivot): Veo scenes plan at 3-4s (3.5 default), generated in
  // 4s/6s/8s buckets at 720p and trimmed. Ceiling stays 8 — the beat snapper
  // also caps at 8 (MAX_D), and 8 is the largest fal bucket.
  const maxDuration = engine === "runway" ? 10 : engine === "veo" ? 8 : 5;
  const defaultDuration = engine === "runway" ? 5 : engine === "veo" ? 3.5 : 2.4;
  // Resolve the music track (explicit, else the style default) and derive its
  // per-track beat-snap unit: the style sets a target cadence, the track's own
  // tempo decides whether that lands on beats, half-bars, bars, or 2-bars.
  const trackFile = String(context.musicTrack || STYLE_DEFAULT_TRACK[context.selectedStyle] || "").trim();
  const beatGrid = BEAT_GRID[trackFile] || null;
  const styleCadence = STYLE_TARGET_CADENCE[context.selectedStyle] || DEFAULT_TARGET_CADENCE;
  // v44.1 PHOTO-LIMITED STRETCH (luxury-demo finding): the target duration
  // used to drive only the scene COUNT — with fewer photos than the count
  // wants, every scene still took the style's short cadence and a "60s"
  // render shipped at ~31s (12 photos × 2.6s luxury cadence) while charging
  // 2 credits. When photos cap the count, stretch the cadence so
  // photos × cadence ≈ target: the beat snapper then lands scenes on a
  // LONGER musical subdivision (poradovskyi: 2 bars = 5.016s → 12 × 5s ≈
  // 60s, still on the grid). Never shrinks below the style's feel; capped
  // at 5.2s so clips stay inside the 6s generation bucket. 30s renders and
  // photo-rich 60s renders are numerically unchanged.
  const targetSecForPlan = Number(context.targetDurationSec) || 30;
  const plannedSceneCount = Math.min(
    [...(plan.scenes || [])].filter((s) => photoIds.has(s.photoId)).length || photos.length,
    MAX_PLAN_SCENES
  );
  const OUTRO_ALLOWANCE_SEC = 4;
  // Gate: long targets only (the 2-credit product). 30s renders keep the
  // style's editorial feel untouched — simulation showed the ungated
  // stretch blew a 12-photo Modern Social 30s render out to ~48s.
  const stretchEligible = targetSecForPlan >= 45;
  const stretchedCadence = stretchEligible && plannedSceneCount > 0
    ? (targetSecForPlan - OUTRO_ALLOWANCE_SEC) / plannedSceneCount
    : styleCadence;
  const targetCadence = Math.max(styleCadence, Math.min(5.2, stretchedCadence));
  const cadenceStretched = targetCadence > styleCadence + 0.05;
  const snapUnit = chooseSnapUnitSec(beatGrid, targetCadence);

  const baseScenes = [...(plan.scenes || [])]
    .filter((scene) => photoIds.has(scene.photoId))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    // Cap at MAX_PLAN_SCENES (24) — was hard-capped at 12, which is why
    // 2-minute renders silently turned into 1-minute renders.
    .slice(0, MAX_PLAN_SCENES)
    .map((scene, index) => {
      // v33.3 ROOM RECONCILIATION: the per-photo classifier (curate/classify,
      // one image per call) is more reliable than the Motion Director's
      // 16-images-in-one-context juggling, which mislabeled scenes in launch
      // QA (bedroom tagged "detail", living room tagged "kitchen") — and
      // narration lines are WRITTEN from roomType, so mislabels became
      // "the kitchen offers ample cabinetry" spoken over a living room.
      // Category wins when present; Motion Director fills the gaps.
      const roomTypeNorm = (() => {
        const photo = photos.find((p) => p.id === scene.photoId);
        const fromCategory = roomTypeFromCategory(photo?.category);
        if (fromCategory) return fromCategory;
        return ROOM_TYPES.includes(scene.roomType) ? scene.roomType : inferRoomType(photo, index);
      })();
      const isExterior = /exterior|backyard|outdoor|front|yard|patio|garden|deck/.test(String(roomTypeNorm).toLowerCase());
      let motion = CAMERA_MOTIONS.includes(scene.cameraMotion) ? scene.cameraMotion : "parallax_zoom";
      // v41.2 (master-23 invented sidewalk): EXTERIORS ARE PUSH-IN ONLY.
      // Reveals, pulls, and lateral pans hand Veo blank canvas at the frame
      // edge — where it paints plausible sidewalks and bushes that pass any
      // consistency check, because the photo has no data there. A push-in
      // synthesizes no new area: every on-screen pixel descends from photo
      // pixels. Hero-shot drama survives — push-in IS the classic house
      // opener. (QC-ladder retries manage their own motion downstream.)
      if (isExterior && motion !== "push_in") motion = "push_in";
      // v46 (m50, launch day): PULL-OUT IS RETIRED EVERYWHERE, not just
      // exteriors. Troy: "the camera should not be panning out." Backward
      // moves reveal edge area the photo has no data for — Veo paints
      // plausible streets/sidewalks/furniture there and QC can't falsify
      // what the photo never showed (m50 scene 1 shipped an invented brick
      // street). Interiors keep the rest of the palette.
      if (motion === "pull_out") motion = "push_in";
      return {
      photoId: scene.photoId,
      order: index + 1,
      roomType: roomTypeNorm,
      visibleFeatures: cleanStringArray(scene.visibleFeatures).slice(0, 5),
      qualityScore: clamp(Number(scene.qualityScore || 70), 0, 100),
      duration: clamp(Number(scene.duration || defaultDuration), 1.2, maxDuration),
      cameraMotion: motion,
      transition: TRANSITIONS.includes(scene.transition) ? scene.transition : "crossfade",
      overlay: {
        headline: cleanText(scene.overlay?.headline || overlayFor(scene.roomType, context.listingDetails, index).headline, 70),
        subline: cleanText(scene.overlay?.subline || overlayFor(scene.roomType, context.listingDetails, index).subline, 90)
      },
      rawNarration: cleanText(scene.narrationLine || "", 240)
      };
    });

  // v44.1: when the cadence was stretched (photo-limited long render), lift
  // each planned duration to the stretched cadence BEFORE snapping — the AI
  // Director writes 3-3.5s durations, and without the lift the snapper's
  // round() can land them back on a short grid point. Also covers tracks
  // with no measured beat grid (no snap pass at all).
  if (cadenceStretched) {
    for (const s of baseScenes) {
      s.duration = clamp(Math.max(s.duration, targetCadence * 0.95), 1.2, maxDuration);
    }
  }
  // v29 beat-timed transitions: snap each scene's CUT to the music beat grid so
  // transitions land on the beat. Done BEFORE narration sizing so the voice
  // still fits its (snapped) scene. Fail-safe: durations unchanged if no grid.
  let snappedDurations = beatGrid && snapUnit > 0
    ? snapDurationsToBeat(baseScenes.map((s) => s.duration), beatGrid, snapUnit)
    : baseScenes.map((s) => s.duration);
  // v31 pipeline-audit guard: on a few grid/cadence combos (e.g. a fast piano
  // track whose chosen unit sits just under the scene length) round() pushes
  // most scenes up a whole extra unit and a 60s target renders ~80s at ~1.5x
  // COGS. If the snapped total overshoots the requested duration by >20%,
  // rescale the pre-snap durations toward the target and re-snap ONCE —
  // still fully on-grid, just biased down. (1 of 456 simulated configs.)
  const targetTotal = Number(context.targetDurationSec) || 0;
  if (targetTotal > 0 && beatGrid && snapUnit > 0) {
    const total = snappedDurations.reduce((a, b) => a + b, 0);
    if (total > targetTotal * 1.2) {
      const scale = targetTotal / total;
      snappedDurations = snapDurationsToBeat(
        baseScenes.map((s) => Math.max(1.2, s.duration * scale)),
        beatGrid,
        snapUnit
      );
    }
  }

  // v31.1 flowing narration: dense plans on some beat grids alternate long
  // (~4s) and short (~2s) scenes. Short scenes can't hold a spoken line, so
  // instead of leaving choppy silent gaps, each short scene's airtime is
  // DONATED to the preceding narrated line — lines are written longer and the
  // voice flows across quick cuts. The worker's voice-mixer extends each
  // line's window to the next narrated scene with the same rule.
  // v34.2 WINDOW-DRIVEN coverage (test-11): the old gate was per-scene
  // (duration >= 2.8s), which collapses deterministically on fast beat
  // grids — a track that snaps every scene to ~2.5s fails EVERY scene,
  // leaving only the forced opener + forced CTA. Test-11: 9 scenes, 2
  // lines, 15s of dead air in the middle. Coverage is a property of the
  // WINDOW (a line's scene plus the silent scenes that donate airtime to
  // it), not of any single scene's duration: walk forward, start a line,
  // grow its window until it can hold a sentence, then start the next.
  // A 2.5s grid now narrates every other scene (~5s windows); a 4s grid
  // narrates every scene — same behavior as before on slow grids.
  // v45.12 (m43/m46 "voiceover cut off" — the ending): the beat grid hands
  // the FINAL scene whatever remainder is left (~2s on 9-photo renders),
  // the CTA needs ~2.5s of speech, and the mixer's last-line grace spills
  // the difference onto the outro card — audible as a cutoff under music.
  // Guarantee the CTA a stage: the final scene gets at least
  // MIN_LAST_SCENE_SEC, funded proportionally by earlier scenes (each
  // floored at 2.2s). Total duration is unchanged; the small off-grid
  // shift on donors is the price of an ending that lands.
  // v50.4 (m61 line-1 TRIM): the OPENER needs a stage too. A dense grid
  // dealt scene 1 ~3.2s while the property-naming opener ran 4.6s — the
  // very first words of the video shipped atempo-1.15 + trimmed mid-word.
  // Same machinery as the CTA guarantee below: scene 1 gets at least
  // MIN_FIRST_SCENE_SEC, funded proportionally by scenes 2..n-1 (each
  // floored at 2.2s), total duration unchanged.
  const MIN_FIRST_SCENE_SEC = 4.2;
  {
    const n = snappedDurations.length;
    if (n >= 3 && snappedDurations[0] < MIN_FIRST_SCENE_SEC) {
      const before0 = snappedDurations[0];
      const need = MIN_FIRST_SCENE_SEC - before0;
      const donorTotal = snappedDurations.slice(1).reduce((a, b) => a + b, 0);
      let funded = 0;
      for (let i = 1; i < n; i++) {
        const share = Math.min(need * (snappedDurations[i] / donorTotal), Math.max(0, snappedDurations[i] - 2.2));
        if (share > 0) {
          snappedDurations[i] = Math.round((snappedDurations[i] - share) * 1000) / 1000;
          funded += share;
        }
      }
      snappedDurations[0] = Math.round((snappedDurations[0] + funded) * 1000) / 1000;
      if (funded > 0.05) {
        console.info(`[plan] opening scene stretched ${before0.toFixed(2)}s → ${snappedDurations[0].toFixed(2)}s so the opener fits its stage.`);
      }
    }
  }

  const MIN_LAST_SCENE_SEC = 3.4;
  {
    const n = snappedDurations.length;
    if (n >= 2 && snappedDurations[n - 1] < MIN_LAST_SCENE_SEC) {
      const before = snappedDurations[n - 1];
      const need = MIN_LAST_SCENE_SEC - before;
      const donorTotal = snappedDurations.slice(0, -1).reduce((a, b) => a + b, 0);
      let funded = 0;
      for (let i = 0; i < n - 1; i++) {
        const share = Math.min(need * (snappedDurations[i] / donorTotal), Math.max(0, snappedDurations[i] - 2.2));
        if (share > 0) {
          snappedDurations[i] = Math.round((snappedDurations[i] - share) * 1000) / 1000;
          funded += share;
        }
      }
      snappedDurations[n - 1] = Math.round((snappedDurations[n - 1] + funded) * 1000) / 1000;
      if (funded > 0.05) {
        console.info(`[plan] final scene stretched ${before.toFixed(2)}s → ${snappedDurations[n - 1].toFixed(2)}s so the CTA fits inside the video.`);
      }
    }
  }

  const MIN_WINDOW_SEC = 3.2;
  // v50.3 (m59 "carries over too much scene to scene"): a narration window
  // may only absorb FOLLOWING scenes in the same room family — merging the
  // bathroom's window across the patio made the tile line narrate the
  // grill, and the exterior's window across a person-photo scene put
  // "backyard lawn" over a face. exterior/outdoor pool together; everything
  // else must match exactly. A cross-family neighbor starts its own window
  // (and its own, scene-sized line) instead of donating airtime.
  const OUTDOOR_FAM = /exterior|outdoor|backyard|front|yard|patio|pool|garden|deck/;
  const sameNarrationFamily = (a, b) => {
    const ra = String(a || "").toLowerCase();
    const rb = String(b || "").toLowerCase();
    if (OUTDOOR_FAM.test(ra) && OUTDOOR_FAM.test(rb)) return true;
    return ra === rb;
  };
  const isNarrated = new Array(snappedDurations.length).fill(false);
  {
    let i = 0;
    while (i < snappedDurations.length) {
      isNarrated[i] = true; // i=0 first pass → the opener always speaks
      let w = snappedDurations[i];
      let j = i + 1;
      while (
        j < snappedDurations.length &&
        w < MIN_WINDOW_SEC &&
        sameNarrationFamily(baseScenes[i]?.roomType, baseScenes[j]?.roomType)
      ) {
        w += snappedDurations[j];
        j += 1;
      }
      i = j;
    }
  }
  // v33.2 (test-9): the FINAL scene always speaks too — it carries the CTA.
  // Without this, a run of short trailing scenes donated all their airtime
  // forward and the video's last third played in dead silence.
  if (isNarrated.length > 1) isNarrated[isNarrated.length - 1] = true;
  const narrationWindows = snappedDurations.map((d, i) => {
    if (!isNarrated[i]) return 0;
    let w = d;
    for (let j = i + 1; j < snappedDurations.length && !isNarrated[j]; j++) {
      w += snappedDurations[j];
    }
    return w;
  });

  const scenes = baseScenes.map((s, index) => {
    const duration = snappedDurations[index];
    // Size narration to the line's full WINDOW (its scene + any following
    // silent short scenes) — never chopped, never bleeding into the next
    // line or the brand-outro card. v31.3: budget at 1.9 words/s — the v27
    // "natural read" ElevenLabs settings speak slower than the old 2.3
    // assumption, which wrote lines ~20% longer than their windows and got
    // them chopped mid-sentence. The mixer also measures each MP3 and
    // absorbs residual overruns with ≤1.15x atempo, so budget + measurement
    // together make truncation rare instead of routine.
    // v53.2 (m67: 3 lines / 16 words on a 9-scene luxury): the budget model
    // sat exactly on a cliff. Overhead 0.95s (0.35 lead + 0.6 tail guard) at
    // 1.9 w/s meant any window under ~3.06s went SILENT via the v35.3
    // going-silent rule — and v49's denser scenes put typical 30s windows at
    // ~3.0s, so one render narrated 8/9 scenes and the next 3/9 on ±0.1s of
    // beat-snap. Recalibrated to MEASURED TTS (m66/m67 transcripts: ~2.0-2.05
    // w/s spoken; release ~0.3s): overhead 0.65s, rate 2.1. Cliff moves to
    // ~2.55s — below every v49 window. Overshoot is guarded by the v53.1
    // stack (1.22 ladder, release-aware fit, caption-trim sync, WARN log).
    const speakSec = narrationWindows[index] - 0.35 - 0.3;
    // v33.2: the final scene's CTA gets a small floor even when the scene
    // is short — a brief CTA reads fine and a silent ending reads broken.
    // v35.3 (test-19): floor lowered 6 → 4. On Investor Tour's alternating
    // grid the last window is ~2.0s; six words + lead-in physically don't
    // fit even with the mixer's 0.8s grace, so the CTA got atempo'd and
    // TRIMMED mid-word ("Experience this bright home with large—"). Four
    // words ("Schedule your tour today") fit the worst-case window.
    const isLastScene = index === baseScenes.length - 1;
    const wordBudget = Math.max(Math.floor(speakSec * 2.1), isLastScene ? 4 : 0);
    const narrationLine = isNarrated[index] && wordBudget >= 3
      ? clampNarrationSentenceSafe(s.rawNarration, wordBudget)
      : "";
    const { rawNarration, ...rest } = s;
    // narrationWindowSec rides along on the scene (v34.2): the verify-and-
    // repair pass needs each line's window to recompute word budgets when
    // it rewrites a line, and the worker/debugging benefit from seeing the
    // plan's window math. 0 = scene is silent (airtime donated backward).
    return { ...rest, duration, narrationLine, narrationWindowSec: Math.round(narrationWindows[index] * 100) / 100 };
  });
  // v26.0: AI engines ("runway" legacy or "veo") get BOTH prompts on every
  // scene. veoPrompt drives production (Veo 3.1 Fast); runwayPrompt is kept
  // for the VEO_PRODUCTION=false rollback path. Cost: bytes in the manifest.
  const isAiEngine = engine === "runway" || engine === "veo";
  const finalScenes = isAiEngine
    ? scenes.map((scene) => ({
        ...scene,
        runwayPrompt: buildRunwayPrompt(scene, photos, context),
        veoPrompt: buildVeoPrompt(scene, photos, context)
      }))
    : scenes;
  return {
    id: `motion-director-${Date.now()}`,
    source: plan.source || context.source || "openai-motion-director",
    promptVersion: PROMPT_VERSION,
    engine,
    heroPhotoId: photoIds.has(plan.heroPhotoId) ? plan.heroPhotoId : finalScenes[0]?.photoId,
    exportFormat: context.exportFormat || plan.exportFormat || "vertical",
    selectedStyle: context.selectedStyle || plan.selectedStyle || "Cinematic Luxury",
    musicMood: cleanText(plan.musicMood || musicMoodFor(context.selectedStyle), 80),
    introCard: {
      headline: cleanText(plan.introCard?.headline || context.listingDetails.address || "Featured listing", 80),
      subline: cleanText(plan.introCard?.subline || "", 100)
    },
    outroCard: {
      headline: cleanText(plan.outroCard?.headline || context.listingDetails.agentName || "Schedule a private tour", 80),
      subline: cleanText(plan.outroCard?.subline || context.listingDetails.brokerage || "", 100)
    },
    runwayConfig: isAiEngine ? defaultRunwayConfig(context.exportFormat) : null,
    // v32 CONTINUOUS NARRATION: one flowing voiceover for the whole tour,
    // synthesized in a single TTS pass and laid over the full photo section.
    // Kills the per-scene window model that chopped lines mid-sentence (or
    // forced robotic 3-word fragments) — rounds 1-4 of the July smoke tests.
    // Per-scene narrationLine fields remain for Edit Studio regen + fallback.
    // v32.3 LENGTH FLOOR (test-6 regression): the model once returned an
    // 8-word script (opener + CTA, 34s of silence). If the script is under
    // 60% of target words, rebuild it from the per-scene lines — always
    // grounded, always full-coverage. Loud in the logs either way.
    narrationScript: enforceScriptFloor(
      cleanText(
        plan.narrationScript || "",
        Math.max(400, Math.round((Number(context.targetDurationSec) || 30) * 2.2 * 7))
      ),
      scenes,
      Number(context.targetDurationSec) || 30
    ),
    scenes: finalScenes
  };
}

function buildRunwayPrompt(scene, photos, context = {}) {
  const photo = photos.find((p) => p.id === scene.photoId) || {};
  const motionClause = RUNWAY_MOTION_PROMPTS[scene.cameraMotion] || RUNWAY_MOTION_PROMPTS.push_in;
  const styleClause = RUNWAY_STYLE_PROMPTS[context.selectedStyle] || RUNWAY_STYLE_PROMPTS["Cinematic Luxury"];
  // Room-specific anchoring — only kitchens, bathrooms, and bedrooms get
  // an additional named-object constraint. Other room types use only the
  // universal constraint clause.
  const roomClause = RUNWAY_ROOM_CONSTRAINTS[scene.roomType] || "";

  const subject = describeSubject(scene, photo);
  const visibleClause = scene.visibleFeatures && scene.visibleFeatures.length
    ? ` Visible elements include: ${scene.visibleFeatures.slice(0, 3).join(", ")}.`
    : "";

  // Order matters: motion first (most important to Runway), then subject,
  // then visible elements (anchoring), then style, then universal
  // constraint, then the room-specific clause LAST so it has the most
  // weight in the model's attention.
  const parts = [
    motionClause,
    `Subject: ${subject}.`,
    visibleClause.trim(),
    styleClause,
    RUNWAY_CONSTRAINT_CLAUSE,
    roomClause
  ].filter(Boolean);

  let combined = parts.join(" ").replace(/\s+/g, " ").trim();
  // Hard cap at 1000 chars — Runway's API rejects longer prompts. If we
  // exceed it, drop room-specific clause first (universal constraint is
  // the safety net), then drop visible elements.
  if (combined.length > 1000 && roomClause) {
    combined = parts.filter((p) => p !== roomClause).join(" ").replace(/\s+/g, " ").trim();
  }
  if (combined.length > 1000) {
    combined = combined.slice(0, 990) + " ...";
  }
  return combined;
}

function describeSubject(scene, photo) {
  const roomDescriptors = {
    exterior: "the exterior of a residential property",
    kitchen: "a residential kitchen",
    living: "a residential living space",
    bedroom: "a bedroom interior",
    bathroom: "a bathroom interior",
    outdoor: "an outdoor residential space",
    amenity: "a residential amenity space",
    detail: "an architectural detail"
  };
  return roomDescriptors[scene.roomType] || "a residential interior";
}

function defaultRunwayConfig(exportFormat) {
  const format = String(exportFormat || "vertical").toLowerCase();
  // Runway Gen-4 Turbo accepts these aspect ratios for image_to_video.
  // Our worker translates these to the actual API pixel-pair strings.
  const ratio = format === "wide" || format === "16:9" ? "16:9"
    : format === "square" || format === "1:1" ? "1:1"
    : "9:16";
  return {
    // Default Gen-4 Turbo — significantly better object/shape preservation
    // than Gen-3a Turbo. Roughly 60% more expensive per second of output
    // ($0.08/sec vs $0.05/sec on Runway's developer pricing) but the
    // hallucination drop is the difference between MLS-compliant and not.
    // Override via RUNWAY_MODEL env var if you need to test gen3a_turbo.
    model: process.env.RUNWAY_MODEL || "gen4_turbo",
    ratio,
    duration: 5,
    seed: null,
    motionStrength: 0.4
  };
}

function normalizeInputPhotos(photos) {
  return photos
    .map((photo, index) => {
      const url = String(photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || photo.imageUrl || photo.url || "");
      return {
        id: String(photo.id || photo.photoId || `photo-${index + 1}`),
        url,
        fileName: String(photo.fileName || photo.filename || `photo-${index + 1}.jpg`),
        width: Number(photo.width || 0),
        height: Number(photo.height || 0),
        category: String(photo.category || "")
      };
    })
    .filter((photo) => photo.id && photo.url && !isLocalOnlyUrl(photo.url));
}

function invalidInputPhotos(photos) {
  return photos
    .map((photo, index) => {
      const url = String(photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || photo.imageUrl || photo.url || "");
      return {
        id: String(photo.id || photo.photoId || `photo-${index + 1}`),
        url
      };
    })
    .filter((photo) => !photo.url || isLocalOnlyUrl(photo.url));
}

async function validateRemotePhotos(photos) {
  const invalidPhotos = [];
  for (const photo of photos) {
    const result = await validateRemotePhoto(photo);
    if (!result.valid) invalidPhotos.push({ id: photo.id, urlHost: safeUrlHost(photo.url), reason: result.reason, status: result.status || 0 });
  }
  if (invalidPhotos.length) {
    return {
      valid: false,
      reason: `${invalidPhotos.length} uploaded photo URL${invalidPhotos.length === 1 ? " is" : "s are"} not publicly reachable by the render/AI worker.`,
      invalidPhotos
    };
  }
  return { valid: true, reason: "", invalidPhotos: [] };
}

async function validateRemotePhoto(photo) {
  if (!photo.url || isLocalOnlyUrl(photo.url)) return { valid: false, reason: "local_or_temporary_url" };
  if (!/^https:\/\//i.test(photo.url)) return { valid: false, reason: "url_must_be_https" };
  try {
    const head = await fetchWithTimeout(photo.url, { method: "HEAD" }, 6000);
    if (head.ok) return validateImageContentType(head.headers.get("content-type"), photo.url);
    if (![403, 405].includes(head.status)) return { valid: false, reason: `http_${head.status}`, status: head.status };
  } catch (error) {
    logMotionDirector("warn", "photo HEAD validation failed; trying range GET", {
      photoId: photo.id,
      urlHost: safeUrlHost(photo.url),
      reason: error.message || error.name || "HEAD failed"
    });
  }
  try {
    const get = await fetchWithTimeout(photo.url, { method: "GET", headers: { Range: "bytes=0-0" } }, 7000);
    if (!get.ok && get.status !== 206) return { valid: false, reason: `http_${get.status}`, status: get.status };
    return validateImageContentType(get.headers.get("content-type"), photo.url);
  } catch (error) {
    return { valid: false, reason: error.name === "AbortError" ? "url_validation_timeout" : (error.message || "url_validation_failed") };
  }
}

function validateImageContentType(contentType, url) {
  const type = String(contentType || "").toLowerCase();
  if (!type) return { valid: true };
  if (type.startsWith("image/")) return { valid: true };
  if (/\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(url)) return { valid: true };
  return { valid: false, reason: `unsupported_content_type:${type}` };
}

function normalizeBrandKitForPrompt(brandKit) {
  return {
    fullName: cleanText(brandKit.fullName || brandKit.name || "", 80),
    brokerage: cleanText(brandKit.brokerage || "", 80),
    voiceLabel: cleanText(brandKit.voiceLabel || "", 80),
    voiceId: cleanText(brandKit.voiceId || "", 64)
  };
}

// Fallback narration for the deterministic edit plan (only used when OpenAI
// is unavailable). Keeps it terse and grounded in user-supplied facts so we
// never hallucinate. Only narrates 4-5 key beats per video.
function fallbackNarrationFor(roomType, details, index, isLast) {
  const address = details.address || "this listing";
  const city = details.city || "";
  const beds = details.beds ? `${details.beds}-bed` : "";
  const baths = details.baths ? `${details.baths}-bath` : "";
  const sqft = details.squareFeet ? `${details.squareFeet} square feet` : "";
  const facts = [beds, baths, sqft].filter(Boolean).join(", ");
  if (index === 0) {
    const intro = city ? `Welcome to ${address} in ${city}.` : `Welcome to ${address}.`;
    return facts ? `${intro} ${facts}.` : intro;
  }
  if (isLast) {
    const cta = details.cta || "Schedule your private tour today.";
    const agent = details.agentName ? `Reach out to ${details.agentName}.` : "";
    return [cta, agent].filter(Boolean).join(" ");
  }
  if (roomType === "kitchen") return "The kitchen anchors the home — open, bright, and built for the way real life happens.";
  if (roomType === "outdoor") return "Step outside. The desert light hits this space differently every hour of the day.";
  if (roomType === "bedroom" && index < 6) return "The primary suite — quiet, private, and finished with care.";
  return "";
}

function normalizeListingDetails(details) {
  return {
    address: cleanText(details.address || details.propertyAddress || "", 120),
    price: cleanText(details.price || "", 40),
    beds: cleanText(details.beds || "", 20),
    baths: cleanText(details.baths || "", 20),
    squareFeet: cleanText(details.squareFeet || details.sqft || "", 30),
    city: cleanText(details.city || "", 60),
    neighborhood: cleanText(details.neighborhood || "", 60),
    agentName: cleanText(details.agentName || "", 80),
    brokerage: cleanText(details.brokerage || "", 80),
    cta: cleanText(details.cta || "", 80)
  };
}

function inferRoomType(photo = {}, index = 0) {
  const haystack = `${photo.fileName || ""} ${photo.category || ""}`.toLowerCase();
  if (/exterior|front|facade|house|home|curb/.test(haystack) || index === 0) return "exterior";
  if (/kitchen|island|cabinet|counter/.test(haystack)) return "kitchen";
  if (/living|family|great|room/.test(haystack)) return "living";
  if (/bed|primary|master/.test(haystack)) return "bedroom";
  if (/bath|shower|tub|vanity/.test(haystack)) return "bathroom";
  if (/yard|backyard|pool|patio|outdoor/.test(haystack)) return "outdoor";
  if (/gym|club|amenity|garage|view/.test(haystack)) return "amenity";
  return "detail";
}

function roomRank(roomType) {
  return { exterior: 0, kitchen: 1, living: 2, bedroom: 3, bathroom: 4, outdoor: 5, amenity: 6, detail: 7 }[roomType] ?? 99;
}

function qualityScore(photo, index) {
  const pixels = Number(photo.width || 0) * Number(photo.height || 0);
  const resolution = pixels ? Math.min(18, Math.round(pixels / 180000)) : 8;
  return clamp(92 - index * 3 + resolution - roomRank(inferRoomType(photo, index)), 45, 98);
}

function durationFor(roomType, style, index, engine = "remotion") {
  // v31 (720p pivot): Veo scenes plan at 3-4s. Hero (scene 1) gets 4s, big
  // showcase rooms 3.5s, everything else 3s — the beat snapper then nudges
  // each to the track's grid. Keeps most scenes inside the cheap 4s bucket.
  if (engine === "veo") {
    if (index === 0) return 4;
    if (roomType === "kitchen" || roomType === "living" || roomType === "exterior") return 3.5;
    return 3;
  }
  // v24.1: Cinematic AI scene durations depend on whether the scene
  // will fall back to Ken Burns. Predicted-fallback scenes (kitchens,
  // bathrooms) get 2.8s — Ken Burns motion is more interesting at
  // shorter durations. Runway scenes stay at 5s (the model's native
  // clip length). This way the final video duration math works out
  // even with mixed-engine scenes.
  if (engine === "runway") {
    return predictKenBurnsFallback(roomType) ? 2.8 : 5;
  }
  const fast = /social|modern/i.test(style || "");
  if (index === 0) return fast ? 2.1 : 3.0;
  if (roomType === "kitchen" || roomType === "living") return fast ? 1.8 : 2.7;
  if (roomType === "detail" || roomType === "bathroom") return fast ? 1.4 : 2.0;
  return fast ? 1.65 : 2.35;
}

function motionFor(roomType, style, index) {
  if (index === 0) return "parallax_zoom";
  if (roomType === "kitchen" || roomType === "living") return "lateral_pan";
  if (roomType === "bathroom") return "vertical_reveal";
  if (roomType === "detail") return "detail_sweep";
  if (/mls/i.test(style || "")) return "push_in";
  if (roomType === "outdoor" || roomType === "amenity") return "push_in"; // v46: pull_out retired (m50 invented street)
  return "push_in";
}

function transitionFor(roomType, style, index) {
  if (index === 0) return "crossfade";
  if (/social|modern/i.test(style || "")) return roomType === "kitchen" ? "whip_pan" : "match_cut";
  if (/luxury/i.test(style || "")) return index % 3 === 0 ? "light_leak" : "blur_wipe";
  return "crossfade";
}

function overlayFor(roomType, details, index) {
  if (index === 0) return { headline: details.address || "Featured listing", subline: [details.price, details.city].filter(Boolean).join(" · ") };
  const labels = {
    exterior: "Curb appeal",
    kitchen: "Kitchen",
    living: "Living space",
    bedroom: "Bedroom",
    bathroom: "Bath",
    outdoor: "Outdoor living",
    amenity: "Amenity",
    detail: "Design detail"
  };
  return {
    headline: labels[roomType] || "Property detail",
    subline: [details.beds ? `${details.beds} bed` : "", details.baths ? `${details.baths} bath` : "", details.squareFeet ? `${details.squareFeet} sq ft` : ""].filter(Boolean).join(" · ")
  };
}

function fallbackVisibleFeatures(photo, roomType) {
  const name = String(photo.fileName || "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  return [name || roomType, roomType].filter(Boolean).slice(0, 3);
}

function musicMoodFor(style) {
  if (/social|modern/i.test(style || "")) return "upbeat social";
  if (/mls/i.test(style || "")) return "subtle ambient";
  if (/investor/i.test(style || "")) return "confident minimal";
  return "slow cinematic luxury";
}

function cleanStringArray(items) {
  return Array.isArray(items) ? items.map((item) => cleanText(item, 60)).filter(Boolean) : [];
}

function cleanText(value, maxLength = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

// v23: word-count clamp for narration. The Motion Director prompt asks for
// 8-22 words per scene but OpenAI occasionally returns 60+ word run-ons.
// Without enforcement, ElevenLabs synthesizes the entire monologue and
// the scene runs short — voice trails off mid-sentence into the next scene.
//
// We truncate at the last word boundary before maxWords. If the result is
// extremely short (<3 words), we drop the line entirely rather than ship
// something that sounds clipped.
function clampNarrationToWords(text, maxWords = 22) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  const truncated = words.slice(0, maxWords).join(" ");
  // Land on punctuation if there's any in the kept window — much smoother.
  const lastSentence = truncated.match(/^(.+[.!?])\s+/);
  return (lastSentence ? lastSentence[1] : truncated).trim();
}

// v33.2 SENTENCE-SAFE clamp (test-9: hard word cuts shipped amputated speech —
// "nestled in a serene." / "boasts peaceful."). The aligned mixer absorbs
// moderate overruns (flow into donated windows + ≤1.15x atempo), so integrity
// beats budget: keep the whole line up to 1.35x budget; otherwise cut at the
// last sentence end, else at the last clause boundary (comma/and/with), and
// only hard-cut as a last resort — always ending with a period.
function clampNarrationSentenceSafe(text, maxWords) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  // v35.5 (test-21): the model invented "For more information visit
  // www.realestate.com" — a fake URL, spoken over the brand outro card.
  // URLs, domains, and phone patterns are banned from narration outright:
  // a line carrying one is REJECTED (every caller treats "" as no-line,
  // so the scene goes silent / keeps its previous line instead).
  if (/\b(?:www\.\S+|https?:\/\/\S+|\S+\.(?:com|net|org|io|ai|co)\b|\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/i.test(trimmed)) {
    return "";
  }
  const words = trimmed.split(/\s+/);
  // v53.5 (m71 line 1): "356A" is one TEXT token but ~four SPOKEN words —
  // ElevenLabs reads addresses and numerals long, the fit math counted 1,
  // and the mixer hard-trimmed the sentence's final noun at 1.22x
  // ("…County Road 7's welcoming—" faded mid-thought). Every budget
  // comparison below now counts spoken length: a digit-bearing token costs
  // its digit count, +1 for a letter suffix ("356A" → "three fifty-six A"
  // ≈ 4), clamped to 2..5.
  const spokenCost = (w) => {
    const digits = (String(w).match(/\d/g) || []).length;
    if (!digits) return 1;
    return Math.max(2, Math.min(5, digits + (/\d[a-z]/i.test(w) ? 1 : 0)));
  };
  const spokenLen = (arr) => arr.reduce((n, w) => n + spokenCost(w), 0);
  const sliceBySpoken = (arr, cap) => {
    const out = [];
    let used = 0;
    for (const w of arr) {
      used += spokenCost(w);
      if (used > cap) break;
      out.push(w);
    }
    return out;
  };
  // v41: += of/in/on/at + articles (a/an/the) — masters 20/22 produced
  // "…reveals a warm." and "…charm of vaulted." because the scan couldn't
  // see those phrase-boundary words; cutting BEFORE an article or
  // preposition always ends on a complete grammatical unit.
  const CONNECTIVES = /^(and|or|with|by|plus|featuring|that|which|where|while|as|creating|offering|framing|overlooking|providing|including|showcasing|boasting|to|for|from|near|beside|beneath|under|above|amid|among|along|across|behind|beyond|atop|against|around|over|into|through|toward|towards|of|in|on|at|a|an|the)$/i;
  // v53.1: the list carried singular verb forms only ("provides") — a
  // plural subject left the bare form dangling ("bedrooms provide." — the
  // m66 clamp path). Bare forms added for every listed verb.
  // v53.5 (m70/71/72, one night): "roof crowns." / "light fills." /
  // "exterior adds." / "countertops blend." / "tile work complements." /
  // "cabinetry beneath." all shipped — every one a transitive verb or
  // preposition the list didn't carry. The polish prompt already bans verb
  // endings; the model ignores it under budget pressure, so THIS list is the
  // enforcement layer and must carry every verb the planner likes. Preps
  // from CONNECTIVES are mirrored here too (the strip never consulted them).
  const FUNCTION_WORDS = /^(and|with|plus|featuring|while|as|the|a|an|of|in|on|at|to|for|or|by|from|near|its|is|are|this|that|which|where|framing|overlooking|offering|showcasing|providing|creating|boasting|surrounding|complementing|including|features?|showcases?|captures?|offers?|includes?|invites?|inviting|provides?|delivers?|highlights?|reveals?|enjoys?|creates?|boasts?|has|have|filled|streaming|flowing|lined|topped|wrapped|bathed|drenched|paired|surrounded|defines?|continues?|extends?|crowns?|fills?|adds?|blends?|complements?|compliments?|frames?|anchors?|greets?|welcomes?|enhances?|commands?|graces?|completes?|elevates?|warms?|opens?|beneath|under|above|below|along|across|beyond|behind|toward|towards|throughout|amid|among|beside|upon|onto|into|over)$/i;
  const HANGING_ADJ = /^(elegant|beautiful|stunning|spacious|bright|modern|warm|cozy|generous|gorgeous|luxurious|inviting|expansive|abundant|ample|natural|vaulted|large|open|airy|sunlit|charming|impressive|exceptional|serene|breathtaking|exposed|custom|updated|upgraded|oversized|covered|heated|finished|polished|refined|manicured|landscaped|soaring|dramatic|private|premium|restful|comfortable|soft|clean|fresh|quiet|peaceful|stylish|graceful|welcoming|outdoor|indoor|sleek|timeless|durable|gleaming|functional|versatile|pristine|immaculate|seamless)$/i;
  // v45.6 (m38): a predicate adjective after a copula is a COMPLETE ending —
  // "…is bright." reads fine and must survive the strip; "…and bright." must
  // not. Without this guard the junk strip gutted grammatical sentences like
  // "The office is bright." all the way down to silence.
  const COPULA = /^(is|are|was|were|feels|looks|stays|remains|sits|stands)$/i;
  const stripTrailingJunk = (arr) => {
    const out = arr.slice();
    while (out.length > 0) {
      const last = out[out.length - 1].replace(/[.,;:]+$/, "");
      if (HANGING_ADJ.test(last)) {
        const prev = out.length >= 2 ? out[out.length - 2].replace(/[.,;:]+$/, "") : "";
        if (COPULA.test(prev)) break; // "…is bright." — complete, keep it
        out.pop();
      } else if (FUNCTION_WORDS.test(last)) {
        out.pop();
      } else {
        break;
      }
    }
    return out;
  };
  // v41 (pipeline audit, masters 20+22): slack was 1.35x on the theory that
  // "the mixer absorbs it" — but the mixer's ceiling was atempo 1.15x, so
  // every line in the 1.15-1.35x band shipped clamp-legal and GUARANTEED to
  // be speed-warped and TRIMMED in the final audio (m22 line 1: budget 6,
  // 9 words = exactly ceil(6*1.35); m20 line 6: budget 4, 6 words = exactly
  // ceil(4*1.35) — one clipped line per render, every render).
  // v53.1 (m66 line 7 "provide rest—"): the 1.15x slack was STILL double-
  // spending. The mixer's soft 1.15x is already consumed by ElevenLabs pace
  // variance (v31.3: natural reads run 15-20% long at honest budgets), so a
  // slack-legal line arrives needing ~1.32x — and beat-snap can shrink the
  // runtime window below the plan's on top of that. Slack now spends only
  // the NEW mixer headroom (1.22/1.15 ≈ 1.06), and short budgets — where
  // ceil() would grant a proportionally huge +1 word — get floor():
  // budget 4 stays 4, budget 6 stays 6; long lines (≥8) may round up one.
  const slackCap = maxWords < 8 ? Math.floor(maxWords * 1.06) : Math.ceil(maxWords * 1.06);
  if (spokenLen(words) <= slackCap) {
    // v42.2 (m27 "The kitchen boasts."): within-budget lines used to skip
    // ALL quality checks — a model-written fragment ending on a dangling
    // transitive verb shipped as the entire spoken line. Strip trailing
    // junk here too; if fewer than 3 real words remain, the line is an
    // unfixable fragment — silence beats "The kitchen boasts."
    const cleaned = stripTrailingJunk(words);
    if (cleaned.length === words.length) return trimmed;
    if (cleaned.length < 3) return "";
    return `${cleaned.join(" ").replace(/[,;:\s]+$/, "")}.`;
  }
  // v53.5b: never cut THROUGH an address or numeral — an overweight line
  // carrying a digit token cuts BEFORE the digit run instead of inside it
  // ("Experience 356A County." must never ship). If what remains is too
  // short, the line goes silent: the title card already shows the address,
  // and silence beats a chopped one. (Edge accepted: a rare multi-sentence
  // line whose first sentence precedes the digits loses that sentence too —
  // planner lines are single sentences.)
  const digitIdx = words.findIndex((w) => /\d/.test(w));
  if (digitIdx !== -1) {
    const before = stripTrailingJunk(words.slice(0, digitIdx));
    if (before.length >= 3) return `${before.join(" ").replace(/[,;:\s]+$/, "")}.`;
    return "";
  }
  const slack = sliceBySpoken(words, slackCap).join(" ");
  // 1) A full sentence inside the slack window — best cut.
  const lastSentence = slack.match(/^(.+[.!?])(?:\s|$)/);
  if (lastSentence) return lastSentence[1].trim();
  // 2) Cut at the LAST comma inside the slack window — clause stays whole.
  const lastComma = slack.lastIndexOf(",");
  if (lastComma > slack.length * 0.4) {
    return `${slack.slice(0, lastComma).trim()}.`;
  }
  // 3) Use the whole slack window (≤1.35x budget — the aligned mixer absorbs
  //    that), stripped of any dangling function words so it ends on content:
  //    "…peaceful views and" → "…peaceful views."
  // v34.4 (test-13: "…exterior that captures." / "…features inviting."):
  // a budget cut lands mid-phrase, and no strip-list of dangling words can
  // enumerate every adjective it might leave hanging ("…and generous
  // open."). Instead, cut BEFORE the last connective/preposition — it is
  // the word that STARTS the phrase the budget is about to sever, so
  // ending ahead of it always ends on a complete grammatical unit:
  // "features inviting warmth AND generous open ▍" → "features inviting
  // warmth." The old dangler strip stays as a backstop (now including
  // transitive verbs + relative pronouns).
  // v35.5: += "by" — test-21's "front entry surrounded by natural—" cut
  // after an adjective, and the dangler cascade can't pop non-list words.
  // Cutting BEFORE "by" lands the whole prepositional phrase cleanly.
  let slackWords = slack.replace(/[,;:\s]+$/, "").split(/\s+/);
  // Keep at least half the slack — cutting at an EARLY connective guts the
  // sentence ("A curved walkway leads." after cutting at "to").
  const minKeep = Math.max(3, Math.ceil(slackWords.length * 0.5));
  for (let k = slackWords.length - 1; k >= minKeep; k--) {
    if (CONNECTIVES.test(slackWords[k])) {
      slackWords = slackWords.slice(0, k);
      break;
    }
  }
  // v41.3 (master-24): pop hanging adjectives too (defs hoisted v42.2).
  // v45.6 (m38 "The office is."): the pop loop used a `> 3` length floor, so
  // it stopped popping even when word 3 was itself junk — "The office is
  // bathed in warm natural light" (budget 6) cut before "in", popped
  // "bathed", and the floor shipped "The office is." as the ENTIRE spoken
  // line: 1.2s of audio, then 3s of dead air (Troy heard it at 31s). Pop
  // with NO floor — a cut that can't end on content is an unfixable
  // fragment, and the v42.2 doctrine applies at this exit too: silence
  // beats "The office is." (stripTrailingJunk carries the copula guard, so
  // complete predicates like "…is bright." still survive.)
  slackWords = stripTrailingJunk(slackWords);
  if (slackWords.length >= 3) {
    return `${slackWords.join(" ").replace(/[,;:\s]+$/, "")}.`;
  }
  // 4) Last resort: hard cut at budget — held to the same fragment standard
  //    (v45.6: this exit used to ship ANY residue, fragments included).
  const within = stripTrailingJunk(sliceBySpoken(words, maxWords));
  if (within.length < 3) return "";
  return `${within.join(" ").replace(/[,;:\s]+$/, "")}.`;
}

// v23: structural validation of an edit plan. Returns { ok: bool, errors: [] }.
// Renamed from validateEditPlan (which is the original lighter validator at
// line 534) to avoid the duplicate-declaration SyntaxError that took down
// every /api/create-edit-plan request with HTTP 500 on first deploy.
// The original `validateEditPlan` checks the OpenAI response shape;
// this one checks the normalized plan + clamped narration lengths.
function validateNormalizedPlan(plan, photos) {
  const errors = [];
  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["plan is not an object"] };
  }
  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    errors.push("scenes array is empty or missing");
  }
  const photoIds = new Set((photos || []).map((p) => p.id));
  for (const [i, scene] of (plan.scenes || []).entries()) {
    const label = `scene ${i + 1}`;
    if (!scene.photoId) {
      errors.push(`${label}: missing photoId`);
    } else if (!photoIds.has(scene.photoId)) {
      errors.push(`${label}: photoId "${scene.photoId}" not in input photos`);
    }
    if (scene.narrationLine != null) {
      const wc = String(scene.narrationLine).trim().split(/\s+/).filter(Boolean).length;
      if (wc > 30) errors.push(`${label}: narrationLine too long (${wc} words)`);
    }
    if (scene.runwayPrompt && scene.runwayPrompt.length > 1000) {
      errors.push(`${label}: runwayPrompt exceeds 1000 chars (${scene.runwayPrompt.length})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Exported for tests + the worker — useful debugging when a render
// produces unexpected output.
export { clampNarrationToWords, validateNormalizedPlan };

function parseOpenAIJson(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return parseBody(payload.output_text);
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

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function extractOpenAIError(openaiResponse, payload) {
  const error = payload?.error || {};
  const status = openaiResponse.status;
  const type = String(error.type || "");
  const code = String(error.code || "");
  const message = String(error.message || `OpenAI returned ${status}.`);
  const requestId = openaiResponse.headers?.get?.("x-request-id") || payload.request_id || error.request_id || "";
  return {
    category: categorizeOpenAIError({ status, type, code, message }),
    status,
    type,
    code,
    message,
    requestId,
    model: motionModel()
  };
}

function categorizeOpenAIError({ status, type, code, message }) {
  const haystack = `${type} ${code} ${message}`.toLowerCase();
  if (status === 404 || haystack.includes("model") && (haystack.includes("not found") || haystack.includes("does not exist") || haystack.includes("invalid"))) return "invalid_model";
  if (status === 429 || haystack.includes("rate limit")) return "rate_limit";
  if (status === 402 || haystack.includes("billing") || haystack.includes("quota") || haystack.includes("insufficient_quota")) return "billing_or_quota";
  if (haystack.includes("image") && (haystack.includes("url") || haystack.includes("download") || haystack.includes("fetch") || haystack.includes("access"))) return "inaccessible_image_url";
  if (haystack.includes("schema") || haystack.includes("json_schema") || haystack.includes("structured")) return "schema_validation";
  if (status >= 500) return "openai_server_error";
  return "openai_request_failed";
}

function userFacingOpenAIReason(error) {
  const requestText = error.requestId ? ` Request ID: ${error.requestId}.` : "";
  const messages = {
    invalid_model: `Motion Director unavailable: invalid OpenAI model "${error.model}". Set OPENAI_MOTION_MODEL to a vision-capable model such as ${DEFAULT_MODEL}.${requestText}`,
    inaccessible_image_url: `Motion Director unavailable: OpenAI could not access one or more uploaded image URLs. Use public or long-lived signed Supabase URLs.${requestText}`,
    schema_validation: `Motion Director unavailable: OpenAI rejected or could not satisfy the edit-plan JSON schema.${requestText}`,
    rate_limit: `Motion Director unavailable: OpenAI rate limit reached. Try again shortly.${requestText}`,
    billing_or_quota: `Motion Director unavailable: OpenAI billing or quota issue. Check the project billing settings.${requestText}`,
    timeout: `Motion Director unavailable: OpenAI timed out.${requestText}`,
    openai_server_error: `Motion Director unavailable: OpenAI server error.${requestText}`
  };
  return messages[error.category] || `Motion Director unavailable: ${error.message}${requestText}`;
}

function safeUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function logMotionDirector(level, message, details = {}) {
  const safeDetails = {
    ...details,
    at: new Date().toISOString()
  };
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  logger(`[Vistalia Motion Director] ${message}`, safeDetails);
}

function isLocalOnlyUrl(url = "") {
  const value = String(url || "").toLowerCase();
  return value.startsWith("blob:") || value.startsWith("data:") || value.includes("localhost") || value.includes("127.0.0.1");
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
