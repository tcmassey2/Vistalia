const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 35000;
// Number of photos sent to OpenAI Vision for actual visual analysis.
// Cost-controlled: at gpt-4.1-mini "low" detail, ~$0.002/image so 12 images =
// ~$0.024 per render. Photos beyond this cap are still INCLUDED in the edit
// plan — OpenAI just orders them via metadata (filename, upload order, etc.)
// instead of visual quality scoring.
const OPENAI_VISION_PHOTO_LIMIT = 12;
// Max scenes the edit plan can contain. Each scene in Cinematic AI = ~5 sec
// of Runway-rendered video, so 24 scenes ≈ 2-minute output (the target).
const MAX_PLAN_SCENES = 24;

const ROOM_TYPES = ["exterior", "kitchen", "living", "bedroom", "bathroom", "outdoor", "amenity", "detail"];
const CAMERA_MOTIONS = ["push_in", "pull_out", "lateral_pan", "vertical_reveal", "parallax_zoom", "detail_sweep"];
const TRANSITIONS = ["crossfade", "blur_wipe", "whip_pan", "match_cut", "light_leak"];
const RENDER_ENGINES = ["remotion", "runway"];

// Runway Gen-3 Turbo image-to-video prompt templates. These map our internal
// camera-motion taxonomy onto natural-language prompts that Runway responds well
// to. Every template ENDS with a hallucination-blocking constraint clause —
// real estate is one of the few AI-video use cases where any element morphing
// or imagined feature is a legal liability, not just an aesthetic problem.
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
const RUNWAY_CONSTRAINT_CLAUSE =
  "STRICT FIDELITY: photorealistic, faithful to source. Apply ONLY the described camera motion. " +
  "DO NOT add, remove, or move any objects, furniture, plants, vegetation, people, animals, vehicles, signage, or text. " +
  "DO NOT add water ripples, fire, smoke, fog, or particles. " +
  "Preserve original lighting, time of day, weather, and sky exactly. " +
  "Real estate documentary style, MLS compliant.";

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
  const exportFormat = String(body.exportFormat || "vertical");
  const engine = RENDER_ENGINES.includes(String(body.engine || "")) ? String(body.engine) : "remotion";
  // Narration is requested when ElevenLabs is configured server-side. The
  // worker uses the agent's voiceId if set, otherwise a stock voice — but
  // either way, we want narration lines in the plan so the worker has
  // something to synthesize.
  const includeNarration = Boolean(process.env.ELEVENLABS_API_KEY);

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
      editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, exportFormat, engine, includeNarration })
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
        editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, exportFormat, engine, includeNarration })
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
      body: JSON.stringify(buildOpenAIRequest({ allPhotos: photos, visionPhotos, listingDetails, selectedStyle, exportFormat, engine, brandKit, includeNarration }))
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
        editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, exportFormat, engine, includeNarration })
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
        editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, exportFormat, engine, includeNarration })
      });
      return;
    }

    logMotionDirector("info", "OpenAI request succeeded", {
      sceneCount: parsed.scenes?.length || 0,
      heroPhotoId: parsed.heroPhotoId
    });
    response.status(200).json({
      status: "complete",
      editPlan: normalizeEditPlan(parsed, photos, { listingDetails, selectedStyle, exportFormat, engine, includeNarration })
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
      editPlan: deterministicEditPlan({ photos, listingDetails, selectedStyle, exportFormat, engine, includeNarration })
    });
  }
}

function buildOpenAIRequest({ allPhotos, visionPhotos, listingDetails, selectedStyle, exportFormat, engine = "remotion", brandKit = {}, includeNarration = false }) {
  // Target scene count: use every photo, capped at MAX_PLAN_SCENES.
  // The AI will be instructed to use ALL provided photos as scenes (no skipping).
  const targetSceneCount = Math.min(allPhotos.length, MAX_PLAN_SCENES);
  const isCinematicAI = engine === "runway";

  // Narration guidance: how many scenes should get a line, and how to write
  // them. Real estate narration that converts is conversational, agent-led,
  // and references concrete listing facts — never generic ("This stunning
  // home features..."). When `includeNarration` is on we ask for ~6 lines
  // out of `targetSceneCount` so most scenes still let the photo + music
  // breathe.
  const narrationTargetCount = Math.min(8, Math.max(4, Math.round(targetSceneCount * 0.35)));
  const narrationGuidance = includeNarration
    ? [
        `Add narrationLine to about ${narrationTargetCount} of the ${targetSceneCount} scenes — the ones that gain from a spoken beat. Always include narration on scene 1 (intro), the kitchen, primary bedroom, the strongest outdoor/view shot, and the final scene (outro/CTA). Leave detail shots and repeat-room shots silent.`,
        `Each narrationLine is 8-22 words, conversational, in the agent's voice. Example tone: "Welcome to 9828 East Pinnacle Peak — five bedrooms across 5,640 square feet of modern desert living."`,
        `The agent's name is "${brandKit.fullName || "the listing agent"}", brokerage "${brandKit.brokerage || "their brokerage"}". Refer to them naturally only on scene 1 and the outro CTA. Don't repeat the agent name on every scene.`,
        `Narration MUST stay grounded in the listing facts provided (price, beds, baths, sq ft, address) and what is visible in the photo. Never invent features, views, schools, or neighborhoods.`,
        `Scenes without narration: omit the narrationLine field entirely OR set it to an empty string. Do NOT pad silence with filler text.`
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
              "You are EstateMotion Motion Director, a professional real estate video editor.",
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
                ? "Engine is Cinematic AI (Runway image-to-video). Set scene duration to 5 seconds. Pick subtle motion that won't induce hallucination."
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
              detail: "low"
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

function deterministicEditPlan({ photos, listingDetails, selectedStyle, exportFormat, engine = "remotion", includeNarration = false }) {
  const ranked = photos
    .map((photo, index) => ({
      ...photo,
      roomType: inferRoomType(photo, index),
      qualityScore: qualityScore(photo, index)
    }))
    .sort((a, b) => roomRank(a.roomType) - roomRank(b.roomType) || b.qualityScore - a.qualityScore);
  // Use ALL photos as scenes (was capped at 10). The cap was hiding 60–70%
  // of the user's uploads from the final video.
  const unique = [];
  const used = new Set();
  ranked.forEach((photo) => {
    if (unique.length < MAX_PLAN_SCENES && !used.has(photo.id)) {
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
  }, photos, { listingDetails, selectedStyle, exportFormat, engine });
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

function normalizeEditPlan(plan, photos, context) {
  const photoIds = new Set(photos.map((photo) => photo.id));
  const engine = RENDER_ENGINES.includes(context.engine) ? context.engine : "remotion";
  // Cinematic AI: clip duration up to 10 (worker decides 5 vs 10 based on >5.5 boundary).
  // Quick Reel: clip duration capped at 5 (Ken Burns shouldn't sit on one photo longer).
  const maxDuration = engine === "runway" ? 10 : 5;
  const defaultDuration = engine === "runway" ? 5 : 2.4;
  const scenes = [...(plan.scenes || [])]
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
      // Narration: only include if non-empty. Treat null / "" / whitespace
      // as silent. This becomes the source-of-truth for the worker's
      // synthesizer.
      narrationLine: cleanText(scene.narrationLine || "", 240) || ""
    }));
  const finalScenes = engine === "runway"
    ? scenes.map((scene) => ({
        ...scene,
        runwayPrompt: buildRunwayPrompt(scene, photos, context)
      }))
    : scenes;
  return {
    id: `motion-director-${Date.now()}`,
    source: plan.source || context.source || "openai-motion-director",
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
    runwayConfig: engine === "runway" ? defaultRunwayConfig(context.exportFormat) : null,
    scenes: finalScenes
  };
}

function buildRunwayPrompt(scene, photos, context = {}) {
  const photo = photos.find((p) => p.id === scene.photoId) || {};
  const motionClause = RUNWAY_MOTION_PROMPTS[scene.cameraMotion] || RUNWAY_MOTION_PROMPTS.push_in;
  const styleClause = RUNWAY_STYLE_PROMPTS[context.selectedStyle] || RUNWAY_STYLE_PROMPTS["Cinematic Luxury"];

  const subject = describeSubject(scene, photo);
  const visibleClause = scene.visibleFeatures && scene.visibleFeatures.length
    ? ` Visible elements include: ${scene.visibleFeatures.slice(0, 3).join(", ")}.`
    : "";

  // Order matters: motion first (most important to Runway), then subject,
  // then visible elements (anchoring), then style, then constraints (last so
  // they override style if conflict).
  return [
    motionClause,
    `Subject: ${subject}.`,
    visibleClause.trim(),
    styleClause,
    RUNWAY_CONSTRAINT_CLAUSE
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
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
  // Runway Gen-3 Turbo accepts these aspect ratios for image_to_video.
  // Our worker translates these to the actual API ratio strings.
  const ratio = format === "wide" || format === "16:9" ? "16:9"
    : format === "square" || format === "1:1" ? "1:1"
    : "9:16";
  return {
    model: process.env.RUNWAY_MODEL || "gen3a_turbo",
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
  // Cinematic AI: every scene is exactly one Runway Gen-3 Turbo clip.
  // Runway returns 5s clips natively. 24 photos × 5s = 120s = the 2-minute
  // target output. The worker reads duration > 5.5 as a signal to upgrade to
  // a 10s clip — keep us at exactly 5 so cost stays predictable.
  if (engine === "runway") return 5;
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
  logger(`[EstateMotion Motion Director] ${message}`, safeDetails);
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
