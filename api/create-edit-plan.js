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
const DEFAULT_TIMEOUT_MS = 60000; // bumped from 35s to 60s (matches the longer function ceiling)
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
const VEO_MOTION_PROMPTS = {
  push_in:
    "The camera moves slowly and smoothly forward toward the focal point of the room, " +
    "about 6% total travel. Perfectly stable, no handheld sway, no vertical drift.",
  pull_out:
    "The camera moves slowly backward to reveal the full space, about 6% total travel. " +
    "Perfectly stable, constant speed, no drift.",
  lateral_pan:
    "The camera moves slowly sideways from left to right, level horizon throughout. " +
    "No rotation, no vertical movement.",
  vertical_reveal:
    "The view tilts gently upward from the lower foreground to reveal the full height of " +
    "the space. Slow, constant speed, perfectly stable.",
  parallax_zoom:
    "The camera moves slowly forward with natural depth parallax between foreground and " +
    "background. About 6% travel. Stable, deliberate, no shake.",
  detail_sweep:
    "The camera moves slowly across the architectural detail at close range, shallow depth " +
    "of field, tight framing. Constant speed."
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

    const openaiResponse = await fetchWithTimeout(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildOpenAIRequest({ allPhotos: photos, visionPhotos, listingDetails, selectedStyle, exportFormat, engine, brandKit, includeNarration, targetDurationSec }))
    }, Number(process.env.OPENAI_MOTION_DIRECTOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));

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
        editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec })
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
        editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec })
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
    const reason = error.name === "AbortError" ? "Motion Director unavailable: OpenAI timed out." : `Motion Director unavailable: ${error.message || "OpenAI request failed."}`;
    logMotionDirector("error", "OpenAI request exception; fallback used", {
      category,
      message: error.message || "",
      name: error.name || ""
    });
    response.status(200).json({
      status: "fallback",
      reason,
      errorCategory: category,
      editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, musicTrack, exportFormat, engine, includeNarration, targetDurationSec })
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
        `MOST IMPORTANT: also return a top-level field "narrationScript" — ONE continuous spoken voiceover for the ENTIRE tour, approximately ${scriptWordTarget} words (hard maximum ${Math.round(scriptWordTarget * 1.15)}). Write it as flowing spoken prose in the same order as the scenes: open by naming the property, walk through the spaces with natural transitions ("Through the entry…", "Out back…"), and end with a short call to action. No scene numbers, no headings, no stage directions — only words to be read aloud. It will be read continuously over the whole video, so it must read as one connected piece, not disconnected captions.`,
        `Add narrationLine to EVERY scene — all ${targetSceneCount} of them. Continuous narration sounds more professional than sparse voice with long silent gaps.`,
        `Keep EVERY line SHORT — the narrator reads slowly and deliberately (~1.9 words/sec): a 3s scene fits ~3-4 words, a 4s scene ~5-6, a 5-6s hero scene ~8-9 max. A line must finish with a beat of breathing room before its scene ends — never write a line that would run past its scene. When in doubt, write FEWER words. Vary cadence: mix 3-5 word observations ("Crown molding throughout", "Quartz counters, soft-close") with slightly longer lines only on the longest hero scenes.`,
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
                ? "Engine is Cinematic AI (Veo image-to-video). Set scene duration to 3-3.5 seconds for most scenes; the exterior hero and one or two showcase rooms may run 4-6 seconds; never exceed 6. Camera motion: strongly prefer push_in and pull_out (most stable). Use lateral_pan or parallax_zoom ONLY for wide, open, deep spaces (large great rooms, exteriors with long sightlines) — never in furnished rooms shot at close or medium range. Use detail_sweep only on true close-up detail shots."
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
    required: ["heroPhotoId", "exportFormat", "selectedStyle", "musicMood", "introCard", "outroCard", "scenes"]
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
  const targetCadence = STYLE_TARGET_CADENCE[context.selectedStyle] || DEFAULT_TARGET_CADENCE;
  const snapUnit = chooseSnapUnitSec(beatGrid, targetCadence);

  const baseScenes = [...(plan.scenes || [])]
    .filter((scene) => photoIds.has(scene.photoId))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    // Cap at MAX_PLAN_SCENES (24) — was hard-capped at 12, which is why
    // 2-minute renders silently turned into 1-minute renders.
    .slice(0, MAX_PLAN_SCENES)
    .map((scene, index) => ({
      photoId: scene.photoId,
      order: index + 1,
      roomType: ROOM_TYPES.includes(scene.roomType) ? scene.roomType : inferRoomType(photos.find((photo) => photo.id === scene.photoId), index),
      visibleFeatures: cleanStringArray(scene.visibleFeatures).slice(0, 5),
      qualityScore: clamp(Number(scene.qualityScore || 70), 0, 100),
      duration: clamp(Number(scene.duration || defaultDuration), 1.2, maxDuration),
      cameraMotion: CAMERA_MOTIONS.includes(scene.cameraMotion) ? scene.cameraMotion : "parallax_zoom",
      transition: TRANSITIONS.includes(scene.transition) ? scene.transition : "crossfade",
      overlay: {
        headline: cleanText(scene.overlay?.headline || overlayFor(scene.roomType, context.listingDetails, index).headline, 70),
        subline: cleanText(scene.overlay?.subline || overlayFor(scene.roomType, context.listingDetails, index).subline, 90)
      },
      rawNarration: cleanText(scene.narrationLine || "", 240)
    }));

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
  const MIN_NARRATABLE_SEC = 2.8;
  const isNarrated = snappedDurations.map((d) => d >= MIN_NARRATABLE_SEC);
  if (isNarrated.length > 0) isNarrated[0] = true; // the opener always speaks
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
    const speakSec = narrationWindows[index] - 0.35 - 0.6;
    const wordBudget = Math.floor(speakSec * 1.9);
    const narrationLine = isNarrated[index] && wordBudget >= 3
      ? clampNarrationToWords(s.rawNarration, wordBudget)
      : "";
    const { rawNarration, ...rest } = s;
    return { ...rest, duration, narrationLine };
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
    narrationScript: cleanText(
      plan.narrationScript || "",
      Math.max(400, Math.round((Number(context.targetDurationSec) || 30) * 2.2 * 7))
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
  if (roomType === "outdoor" || roomType === "amenity") return "pull_out";
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
