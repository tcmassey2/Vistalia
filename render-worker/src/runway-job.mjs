// Vistalia — Runway Gen-3 Turbo image-to-video render engine.
// Selected when manifest.engine === "runway". Generates one Runway clip per
// photo scene (parallelized), downloads them, stitches with FFmpeg into the
// final MP4, then uploads to Supabase Storage.
//
// Cost guardrails (Runway Gen-3 Turbo, image_to_video, ~$0.05/sec billed):
//   12 scenes * 5s = 60s of generated video = ~$3.00 per render
//   25 scenes * 5s = 125s = ~$6.25 per render
// MAX_SCENES caps a single job at $7.50 to prevent runaway billing.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { deriveAspectVariants, buildSocialShorts } from "./aspect-variants.mjs";
import { applyVoiceNarration } from "./voice-mixer.mjs";
import { writeRenderAudit } from "./audit-log.mjs";
import { runFFmpeg, timed } from "./ffmpeg-runner.mjs";
import { stitchWithCrossfades, stitchWithSimpleConcat } from "./stitch.mjs";

const RUNWAY_API_BASE = process.env.RUNWAY_API_BASE || "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = process.env.RUNWAY_API_VERSION || "2024-11-06";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per clip
const DEFAULT_CONCURRENCY = 4;
const MAX_SCENES = 30;
const NON_PHOTO_TYPES = new Set(["intro", "outro", "stat", "card", "title", "stats"]);

/* =================================================================
   Encode quality knobs — v19 (clarity + memory safety)
   =================================================================
   v18 jumped from preset=ultrafast → veryfast + crf=21 → 19 for visibly
   sharper renders. On Render Standard's 2GB ceiling that pushed peak
   ffmpeg memory past the OOM-killer threshold (x264's veryfast preset
   keeps ~3-5 reference frames + a 25-frame lookahead window in flight,
   easily 150-250 MB per encoder). v19 dials back to `superfast` (still
   sharper than v17's ultrafast but ~40% less encoder RAM) AND adds
   explicit x264 buffer caps so even worst-case CPUs can't blow the
   memory ceiling.

   Stays at crf=19 — that's where the visible sharpness gain came from,
   and CRF doesn't materially change memory footprint.

   X264_PARAMS — explicit limits on the parameters that drive encoder
                 memory: ref frames, lookahead window, b-frame chain
                 depth, GOP size. Without these x264 picks profile-
                 default values that can be 4-8× larger than we need
                 for short cinematic clips.
   BUFSIZE_MB — bitrate buffer cap. ffmpeg defaults to unbounded which
                under high-detail-frame stress can grow indefinitely.
   COLOR_GRADE — unchanged from v18.
*/
const ENCODE_PRESET = "superfast";
const ENCODE_CRF_MASTER = "19";
const ENCODE_CRF_DERIVED = "20";
const X264_PARAMS = "rc-lookahead=10:ref=2:bframes=2:keyint=60:scenecut=0";
const BUFSIZE = "2M";
// v28.2: output is now NATIVE 1080p (8s Veo @ 1080p, trimmed) — no upscale. The
// heavy unsharp added for the old 720p→1080p path was over-sharpening already-
// sharp footage and amplifying Veo's fine grain, which read as "grainy". So:
// (1) a light hqdn3d denoise FIRST to knock grain down, then (2) a much gentler
// unsharp (0.9→0.4 luma, 0.4→0.2 chroma) to re-crisp without re-introducing
// noise. Both kept light to avoid a smeared/plastic look.
const COLOR_GRADE =
  "hqdn3d=1.5:1.2:4:4,eq=contrast=1.08:saturation=0.95:gamma=1.03,colorbalance=rs=0.05:bs=-0.025,unsharp=5:5:0.4:3:3:0.2";

export async function renderRunwayJob(body, options = {}) {
  const { manifest, requestedFormat } = body || {};
  validateRunwayManifest(manifest);

  // v26.3 (Phase 2): this orchestrator is now engine-agnostic. engine "veo"
  // generates per-scene clips via Veo 3.1 Fast on fal.ai; everything else
  // (stitch, voice, variants, uploads) is unchanged. Runway path preserved
  // for rollback via VEO_PRODUCTION=false on the dispatcher.
  const isVeo = String(manifest?.engine || "runway").toLowerCase() === "veo";

  if (isVeo && !process.env.FAL_KEY) {
    throw new Error("FAL_KEY is required for Veo rendering. Set it on the render-worker host.");
  }
  if (!isVeo && !process.env.RUNWAY_API_KEY) {
    throw new Error("RUNWAY_API_KEY is required for Runway rendering. Set it on the render-worker host.");
  }

  const jobId = options.jobId || createJobId(manifest);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "estatemotion-runway-"));
  const photoScenes = manifest.scenes
    .filter((scene) => !NON_PHOTO_TYPES.has(String(scene.type || "photo").toLowerCase()))
    .slice(0, MAX_SCENES);

  if (photoScenes.length === 0) {
    throw new Error("Runway render manifest has no photo scenes.");
  }

  options.onProgress?.({ phase: "Submitting Runway clips", progress: 6, scenesTotal: photoScenes.length });

  const concurrency = Math.min(
    Number(process.env.RUNWAY_CONCURRENCY || DEFAULT_CONCURRENCY),
    photoScenes.length
  );

  // Compliance Mode: every scene uses Ken Burns instead of Runway.
  // Zero hallucination risk, no Runway credits used.
  const complianceMode = Boolean(manifest?.complianceMode);
  if (complianceMode) {
    console.info(`[runway] complianceMode=true — bypassing Runway, using Ken Burns for all ${photoScenes.length} scenes.`);
  }

  // Hallucination Guard — content-aware protection that goes beyond simple
  // roomType matching. Three levels:
  //   "off"      — pure Runway, no protection (legacy behavior)
  //   "balanced" — default. Kitchens + bathrooms + any scene with a risk
  //                score above 60 get Ken Burns. Everything else: Runway.
  //   "strict"   — All kitchens. Plus risk > 35 forces Ken Burns. Use this
  //                for MLS-grade reliability when AI hallucinations would
  //                be a liability (legally or commercially).
  // Backwards compat: legacy manifest.protectHighRiskRooms=true maps to
  // "balanced"; protectHighRiskRooms=false maps to "off".
  const guardLevel = resolveGuardLevel(manifest);
  if (guardLevel !== "off" && !complianceMode) {
    console.info(`[runway] hallucinationGuard=${guardLevel} — content-aware protection active.`);
  }

  let scenesCompleted = 0;
  let fallbackCount = 0;
  let guardForcedCount = 0;
  // Per-scene failure recovery: when Runway fails on a single scene we
  // generate a Ken-Burns–style fallback clip from the same photo using
  // ffmpeg locally. The render completes with mixed Cinematic AI and
  // Ken-Burns scenes rather than dying with one bad apple. Daily-cap
  // errors still propagate up — those need user action, not a fallback.
  const clipResults = await pMap(
    photoScenes,
    async (scene, index) => {
      let result;
      // The Hallucination Guard decision is logged with reasoning so we can
      // tune thresholds based on real-world data.
      const guardDecision = decideUseKenBurns(scene, guardLevel);

      if (isVeo) {
        // v26.3: NO Ken Burns on the Veo path — ever. The guard's risk
        // scoring is repurposed: risky scenes (kitchens, baths, laundry,
        // pools, signage) get a CONSTRAINED locked-tripod prompt instead of
        // a different engine. Validated June 9 bake-off: constrained
        // prompts eliminated hallucination on the failure scenes across
        // Veo 3/3.1, Kling, and Seedance. complianceMode = constrained
        // for every scene.
        const constrained = complianceMode || guardDecision.useKenBurns;
        if (constrained && !complianceMode) {
          guardForcedCount++;
          console.info(
            `[veo] guard:${guardLevel} scene ${index + 1} (${scene.roomType || "unknown"}) ` +
            `→ constrained prompt. risk=${guardDecision.risk}/100, reason="${guardDecision.reason}"`
          );
        }
        try {
          result = await generateVeoSceneClip(scene, manifest, tempDir, index, { constrained });
        } catch (error) {
          // Auto-retry ONCE, always constrained (a failed cinematic attempt
          // most often means the motion asked too much of the source photo).
          console.warn(`[veo] scene ${index + 1} failed (${error.message}). Retrying once, constrained.`);
          try {
            result = await generateVeoSceneClip(scene, manifest, tempDir, index, { constrained: true });
            fallbackCount++; // counted as "retried", surfaces in phase text
          } catch (retryError) {
            // No partial videos, no silent quality downgrades. Fail the
            // render with a typed error; the API layer refunds the credit
            // (render_credit_refunds helper — Phase 2 remainder).
            const err = new Error(
              `Scene ${index + 1} failed twice on Veo (${retryError.message}). Render aborted — your render credit will be refunded.`
            );
            err.code = "VEO_SCENE_FAILED";
            throw err;
          }
        }
      } else if (complianceMode || guardDecision.useKenBurns) {
        if (!complianceMode && guardDecision.useKenBurns) {
          guardForcedCount++;
          console.info(
            `[runway] guard:${guardLevel} scene ${index + 1} (${scene.roomType || "unknown"}) ` +
            `→ Ken Burns. risk=${guardDecision.risk}/100, reason="${guardDecision.reason}"`
          );
        }
        // Legacy Runway path only: skip Runway for this scene.
        result = await generateKenBurnsFallback(scene, manifest, tempDir, index);
      } else {
        try {
          result = await generateClip(scene, manifest, tempDir, index);
        } catch (error) {
          if (error.code === "RUNWAY_DAILY_CAP") throw error; // surface to user
          console.warn(`[runway] scene ${index + 1} failed (${error.message}). Falling back to Ken Burns.`);
          result = await generateKenBurnsFallback(scene, manifest, tempDir, index);
          fallbackCount++;
        }
      }
      scenesCompleted++;
      const phaseText = complianceMode
        ? `MLS-safe render: scene ${scenesCompleted}/${photoScenes.length}`
        : fallbackCount > 0
          ? `Rendering scene ${scenesCompleted}/${photoScenes.length} (${fallbackCount} fallback${fallbackCount > 1 ? "s" : ""})`
          : `Rendering scene ${scenesCompleted}/${photoScenes.length}`;
      options.onProgress?.({
        // Reserve 78–100% for stitch + derive + shorts + upload, so the
        // Runway phase tops out at ~74% rather than overrunning the bar.
        phase: phaseText,
        progress: 10 + Math.floor((scenesCompleted / photoScenes.length) * 64),
        scenesCompleted,
        scenesTotal: photoScenes.length
      });
      return result;
    },
    { concurrency }
  );

  if (!complianceMode && guardLevel !== "off") {
    console.info(
      `[runway] Hallucination Guard summary — guard=${guardLevel}, ` +
      `${guardForcedCount}/${photoScenes.length} scene${photoScenes.length === 1 ? "" : "s"} locked to Ken Burns by risk score, ` +
      `${fallbackCount} additional scene${fallbackCount === 1 ? "" : "s"} fell back due to Runway errors.`
    );
  }

  options.onProgress?.({ phase: "Stitching final video", progress: 76 });
  const finalMp4 = path.join(tempDir, `${jobId}.mp4`);
  const thumbnailPath = path.join(tempDir, `${jobId}.png`);

  const { normalizedClips } = await stitchClipsAndOverlays(clipResults, manifest, finalMp4, thumbnailPath, options);

  // Voice narration — synthesize per-scene narration via ElevenLabs and mix
  // it into the master with music ducking. Wrapped in fail-soft try/catch
  // with a 2-minute time budget: if ElevenLabs is slow / errored / the
  // ffmpeg mix gets stuck, we fall back to the silent master and ship the
  // render with music-only audio. The render completing trumps the
  // narration. Bypassable entirely via manifest.skipNarration: true.
  options.onProgress?.({ phase: "Adding voice narration", progress: 80 });
  let narration = { narrationApplied: false, reason: "skipped" };
  if (manifest?.skipNarration) {
    console.info("[runway] skipNarration=true on manifest — skipping voice step.");
  } else {
    const NARRATION_TIME_BUDGET_MS = 120 * 1000; // 2 minutes hard cap
    try {
      // v26.9 reliability: pass the ACTUAL per-scene clip durations (keyed by
      // photoId) so narration timing tracks the real video, not the plan's
      // stated durations. Eliminates the drift that made voice desync /
      // "stop after 5 seconds" when manifest duration != rendered clip length.
      const actualDurationsByPhoto = {};
      for (const c of clipResults) {
        if (c && c.photoId) actualDurationsByPhoto[c.photoId] = Number(c.duration) || 0;
      }
      narration = await Promise.race([
        applyVoiceNarration({
          masterMp4: finalMp4,
          scenes: manifest.scenes,
          sceneDurationsByPhoto: actualDurationsByPhoto,
          brandKit: manifest.brandKit || {},
          tempDir,
          jobId,
          onProgress: (info) => {
            options.onProgress?.({ phase: info.phase, progress: 80 + Math.floor((info.fraction || 0) * 4) });
          }
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Narration step exceeded 2-minute time budget — shipping music-only audio.")), NARRATION_TIME_BUDGET_MS)
        )
      ]);
    } catch (err) {
      console.warn(`[runway] narration step failed (${err.message}). Continuing with music-only audio.`);
      narration = { narrationApplied: false, reason: err.message || "narration_failed" };
    }
  }
  // If narration was applied, the mixed file replaces our master going
  // forward. Otherwise the original (silent or music-only) master is used.
  const masterForVariants = narration.narrationApplied ? narration.masterMp4 : finalMp4;

  // ONE-MASTER simplification: previously this step produced 9:16 +
  // 16:9 + 1:1 variants + a 4K upscale + 3 social shorts (~8 files).
  // Troy's call to simplify: ship a single vertical 9:16 master per
  // render. Saves 30-90s of compute, cuts upload bandwidth, removes
  // a long tail of per-variant failure modes. Users who want a
  // different aspect can re-render with exportFormat changed.
  // deriveAspectVariants + buildSocialShorts modules retained in
  // tree for the future-tier 'Pro Pack' SKU, but no longer called.
  options.onProgress?.({ phase: "Finalizing master", progress: 88 });
  const variants = {
    vertical: { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } }
  };
  const shorts = [];

  options.onProgress?.({ phase: "Uploading deliverables", progress: 94 });
  // Per-file upload progress so the bar moves through 94 → 99 as each
  // file actually finishes uploading. Without this, the bar sits at ~99%
  // (soft-creep maxed out) for 30-90 seconds during multi-file Supabase
  // uploads — and the user reasonably interprets that as "stuck at 100%".
  const upload = await uploadRunwayAssets({
    manifest,
    jobId,
    variants,
    shorts,
    thumbnailPath,
    onProgress: (info) => {
      options.onProgress?.({
        phase: info.phase || `Uploading ${info.fileLabel || "deliverables"}`,
        progress: 94 + Math.floor((info.fraction || 0) * 5)
      });
    }
  });

  // Upload per-scene clips for regenerate-scene support. Each clip is
  // 2-5 MB; 24 of them = ~50-120 MB extra upload. Worth it because
  // single-scene regen is the production-grade fix. Each clip gets a
  // predictable URL inside the same Supabase folder as master/variants.
  const scenesMeta = await uploadPerSceneClips({
    manifest,
    jobId,
    normalizedClips,
    clipResults,
    pathPrefix: "runway"
  });

  // Cleanup per-scene local files now that they're uploaded.
  for (const clip of normalizedClips) {
    await fs.unlink(clip.clipPath).catch(() => {});
  }

  options.onProgress?.({ phase: "Ready to download", progress: 100 });

  // Audit log — TRULY fire-and-forget (no await). A slow Supabase REST
  // call here must never block the render from being marked complete.
  // The helper has its own try/catch so this can't throw on the floor.
  writeRenderAudit({
    manifest,
    jobId,
    // v26.9: record the engine actually used (was hardcoded "runway", which
    // mislabeled every Veo render in the library + audit log).
    engine: isVeo ? "veo" : "runway",
    upload,
    narration,
    scenes: scenesMeta
  }).catch(() => {});

  return {
    status: "complete",
    mock: false,
    engine: "runway",
    jobId,
    // Primary deliverable (vertical) — kept at top level for backward compat.
    mp4Url: upload.formats.vertical?.mp4Url || "",
    thumbnailUrl: upload.thumbnailUrl,
    storagePath: upload.formats.vertical?.storagePath,
    thumbnailPath: upload.thumbnailStoragePath,
    localMp4Path: upload.storageSkipped ? finalMp4 : "",
    localThumbnailPath: upload.storageSkipped ? thumbnailPath : "",
    storageSkipped: upload.storageSkipped,
    storageWarning: upload.storageWarning || "",
    formats: upload.formats,
    socialShorts: upload.socialShorts,
    narration: narration.narrationApplied
      ? { applied: true, voiceId: narration.voiceId, lineCount: narration.narrationLineCount }
      : { applied: false, reason: narration.reason },
    scenesGenerated: clipResults.length,
    sceneClips: clipResults.map((c) => ({
      photoId: c.photoId,
      durationSec: c.duration,
      runwayTaskId: c.runwayTaskId
    })),
    // v27 Edit Studio: surface the full per-scene metadata (durable clip URL,
    // photo URL, room, prompt, storage path) to the frontend so the Edit Studio
    // can list each scene and target a single one for re-render. Previously
    // this rich array only went to the audit log.
    scenes: scenesMeta
  };
}

/* =================================================================
   Per-scene Runway generation
   ================================================================= */

export async function generateClip(scene, manifest, tempDir, sceneIndex) {
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) throw new Error(`Scene ${sceneIndex + 1} (${scene.photoId}) missing durable image URL.`);
  const prompt = scene.runwayPrompt || scene.runway_prompt;
  if (!prompt) throw new Error(`Scene ${sceneIndex + 1} missing runwayPrompt. Regenerate edit plan with engine=runway.`);

  const config = manifest.runwayConfig || {};
  // Default Gen-4 Turbo for new renders. Better shape preservation, fewer
  // morphed surfaces. The ratio resolver picks the right pixel-pair based
  // on which model we're hitting (Gen-4 uses 1280:720, Gen-3 uses 1280:768).
  const model = config.model || process.env.RUNWAY_MODEL || "gen4_turbo";
  const ratio = ratioForRunway(config.ratio, model);
  const duration = clamp(Number(scene.duration || 5) > 5.5 ? 10 : 5, 5, 10);

  // Submit task — with 429 / 5xx resilience.
  // Runway's task-submit endpoint hits us with three failure modes worth
  // distinguishing:
  //   1. 429 "rate limit" — short-window throttle. Backoff + retry.
  //   2. 429 "daily task limit reached" — terminal until tomorrow or
  //      until the user upgrades. No point retrying. Surface a clear
  //      error so the frontend can prompt for an upgrade.
  //   3. 5xx — transient Runway side. Retry with backoff.
  const submitResponse = await submitRunwayTaskWithRetry({
    body: {
      model,
      promptImage: imageUrl,
      promptText: prompt,
      ratio,
      duration,
      watermark: false,
      ...(config.seed != null ? { seed: Number(config.seed) } : {})
    },
    sceneIndex,
    maxAttempts: 5
  });

  if (!submitResponse.ok) {
    const errBody = await safeText(submitResponse);
    const isDailyCap = /daily.*(task|limit|cap|quota)/i.test(errBody);
    const message = isDailyCap
      ? `Cinematic AI is at its daily render cap. Upgrade your Runway plan to Unlimited ($95/mo) to remove the cap, or wait until tomorrow.`
      : `Runway submit failed for scene ${sceneIndex + 1} (HTTP ${submitResponse.status}): ${errBody.slice(0, 240)}`;
    const error = new Error(message);
    error.code = isDailyCap ? "RUNWAY_DAILY_CAP" : "RUNWAY_SUBMIT_FAILED";
    error.httpStatus = submitResponse.status;
    throw error;
  }

  const submitData = await submitResponse.json();
  const taskId = submitData.id;
  if (!taskId) throw new Error(`Runway submit returned no task id for scene ${sceneIndex + 1}.`);

  // Poll until completion
  const outputUrl = await pollRunwayTask(taskId, sceneIndex);

  // Download clip
  const clipPath = path.join(tempDir, `clip-${String(sceneIndex).padStart(3, "0")}.mp4`);
  await downloadFile(outputUrl, clipPath);

  return {
    sceneIndex,
    photoId: scene.photoId,
    clipPath,
    duration,
    transition: scene.transition || "crossfade",
    overlay: scene.overlay || null,
    runwayTaskId: taskId
  };
}

/* =================================================================
   v26.3 — Veo 3.1 Fast per-scene clip (Phase 2 production path)
   ================================================================= */

// Room types whose constrained prompt needs special handling beyond the
// generic locked-tripod language. Pools get a water-shimmer allowance
// (a fully frozen pool looks like a photo, defeating the point).
// v27 hallucination fix: the opening used to read "Locked tripod shot" — Veo
// 3.1 rendered the word "tripod" as a literal object (a tripod, and an operator
// to use it) into the room. Describe the camera STATE only, never equipment.
const CONSTRAINED_PROMPTS = {
  generic:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Preserve every surface, fixture, appliance, label, and object exactly as photographed. " +
    "Nothing in the scene moves.",
  pool:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Water surface may shimmer gently, but pool shape, tile, coping, deck, and all " +
    "surroundings stay exactly as photographed. Nothing else moves.",
  exterior:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Trees, foliage, leaves, and branches stay completely still and hold their exact shape — " +
    "no swaying, morphing, rippling, or regenerating. The structure, roofline, windows, and " +
    "all hardscape stay exactly as photographed."
};

function buildConstrainedVeoPrompt(scene) {
  const room = String(scene.roomType || "").toLowerCase();
  if (/pool|spa/.test(room)) return CONSTRAINED_PROMPTS.pool;
  if (/exterior|backyard|outdoor|front|yard|patio/.test(room)) return CONSTRAINED_PROMPTS.exterior;
  return CONSTRAINED_PROMPTS.generic;
}

// MLS-compliance suffix appended to EVERY Veo prompt, cinematic or
// constrained. Listing videos legally must not misrepresent the property —
// this is the per-scene guardrail, independent of the edit plan.
const VEO_FIDELITY_SUFFIX =
  " Photorealistic. Do not add, remove, or alter any object, surface, fixture, or " +
  "architectural feature. No people, no animals. Absolutely NO text, captions, words, " +
  "letters, numbers, signage, watermarks, on-screen UI, or graphic overlays of any kind " +
  "anywhere in the frame. The scene must remain exactly as photographed apart from the " +
  "camera motion described.";

// Per-scene Veo generation, mapped to the same clipResults shape that
// generateClip / generateKenBurnsFallback return so the stitch pipeline
// downstream is untouched.
export async function generateVeoSceneClip(scene, manifest, tempDir, sceneIndex, { constrained = false } = {}) {
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) throw new Error(`Scene ${sceneIndex + 1} (${scene.photoId}) missing durable image URL.`);

  // Prompt priority: explicit veoPrompt from a v26 edit plan → legacy
  // runwayPrompt (older plans; plain text, works on Veo) → constrained.
  const basePrompt = constrained
    ? buildConstrainedVeoPrompt(scene)
    : (scene.veoPrompt || scene.veo_prompt || scene.runwayPrompt || scene.runway_prompt || buildConstrainedVeoPrompt(scene));
  // v28: exteriors are where Veo morphs worst — it "animates" foliage under any
  // camera move (leaves rippling, branches growing/regenerating). For outdoor
  // scenes, append an explicit foliage lock + minimal-motion bias on top of the
  // universal fidelity suffix. Applies to ALL four modes.
  const roomStr = String(scene.roomType || "").toLowerCase();
  const isExteriorScene = /exterior|backyard|outdoor|front|yard|patio|pool|garden|landscap|deck/.test(roomStr);
  const foliageLock = isExteriorScene
    ? " Trees, plants, hedges, leaves, and branches must hold their exact shape, count, and position — foliage must NOT morph, ripple, shimmer, multiply, grow, or regenerate. Keep camera movement minimal so foliage stays perfectly stable."
    : "";
  const prompt = basePrompt + foliageLock + VEO_FIDELITY_SUFFIX;

  const config = manifest.runwayConfig || {};
  const ratio = config.ratio === "16:9" || config.ratio === "wide" ? "16:9" : "9:16";
  // Veo 3.1 Fast buckets to 4s/6s/8s; our 5s scenes round up to 6s.
  // v28 native 1080p: Veo 3.1 Fast only emits 1080p at an 8s duration. Always
  // generate 8s @ 1080p, then trim back to the scene's intended length
  // (targetDuration) in the normalize step. targetDuration keeps the EXACT prior
  // pacing (6s default / 8s for long scenes) — only resolution changes: the clip
  // now maps 1:1 onto the 1080x1920 master instead of being upscaled from 720p.
  const targetDuration = clamp(Number(scene.duration || 5) > 6.5 ? 8 : 6, 4, 8);

  const { generateVeoClip } = await import("./veo-job.mjs");
  const result = await generateVeoClip({
    imageUrl,
    prompt,
    aspectRatio: ratio,
    duration: "8s",
    resolution: "1080p",
    sceneIndex,
    photoId: scene.photoId,
    tempDir
  });

  return {
    sceneIndex,
    photoId: scene.photoId,
    clipPath: result.clipPath,
    duration: targetDuration,
    transition: scene.transition || "crossfade",
    overlay: scene.overlay || null,
    runwayTaskId: null,
    veoRequestId: result.requestId || "",
    veoModel: result.model || "",
    constrained
  };
}

// Per-scene safety net: when Runway fails, generate a Ken-Burns–style
// 5-second clip from the same photo using ffmpeg's zoompan filter. The
// motion direction is selected from the original scene's cameraMotion so
// the visual intent matches what the AI was supposed to do. Visually less
// dramatic than Runway image-to-video but indistinguishable to a casual
// viewer, and crucially, the render completes.
export async function generateKenBurnsFallback(scene, manifest, tempDir, sceneIndex) {
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) throw new Error(`Fallback impossible — scene ${sceneIndex + 1} has no image URL.`);

  const config = manifest.runwayConfig || {};
  const ratio = config.ratio || "9:16";
  const dimensions = ratio === "16:9" || ratio === "wide" ? { width: 1920, height: 1080 }
                  : ratio === "1:1" || ratio === "square" ? { width: 1080, height: 1080 }
                  : { width: 1080, height: 1920 };
  const duration = clamp(Number(scene.duration || 5) > 5.5 ? 10 : 5, 5, 10);
  const totalFrames = duration * 30;

  // Map the camera motion to a zoompan expression. The motion vocabulary is
  // a strict subset of what Quick Reel does, kept conservative so the
  // fallback never looks worse than a still photo.
  const motion = String(scene.cameraMotion || "push_in").toLowerCase();
  const zoompanExpr = buildZoompanExpr(motion, totalFrames, dimensions);

  const clipPath = path.join(tempDir, `fallback-${String(sceneIndex).padStart(3, "0")}.mp4`);
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-loop", "1",
    "-i", imageUrl,
    "-t", String(duration),
    "-vf", zoompanExpr,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", ENCODE_PRESET,
    "-crf", ENCODE_CRF_MASTER,
    "-x264-params", X264_PARAMS,
    "-bufsize", BUFSIZE,
    "-r", "30",
    clipPath
  ], { timeoutMs: 120000, label: `runway:fallback-scene-${sceneIndex + 1}` });

  return {
    sceneIndex,
    photoId: scene.photoId,
    clipPath,
    duration,
    transition: scene.transition || "crossfade",
    overlay: scene.overlay || null,
    runwayTaskId: null,
    fallback: true
  };
}

function buildZoompanExpr(motion, totalFrames, dim) {
  // v24.2 cinematic upgrade for Ken Burns scenes.
  //
  // What changed vs the linear version:
  //   1. SMOOTHSTEP EASING. Old version used linear `1.0+0.0008*on` —
  //      mechanical look (motion starts/stops abruptly). New version
  //      uses `s*s*(3-2*s)` where s=on/N — slow start, full speed in
  //      the middle, slow end. Standard cinematography easing curve.
  //   2. BIGGER ZOOM RANGE. Max zoom bumped 1.12 → 1.20. More
  //      perceptible motion without exposing edges (1.5× pre-scale
  //      gives the headroom).
  //   3. COMBINED ZOOM+PAN. Every motion type now drifts framing
  //      slightly alongside the zoom — that's what makes real
  //      cinematography feel like motion-through-space instead of
  //      just zoom-in-place.
  //   4. PRE-SCALE 1.3× → 1.5×. Better Lanczos resampling, sharper
  //      output. Per-frame buffer goes from ~14 MB to ~19 MB —
  //      comfortable on Pro 4 GB.
  const s = `${dim.width}x${dim.height}`;
  const fps = 30;
  const PRE_W = Math.round(dim.width * 1.5);
  const PRE_H = Math.round(dim.height * 1.5);
  const PRE = `scale=${PRE_W}:${PRE_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${PRE_W}:${PRE_H}`;

  // Smoothstep helper as ffmpeg expression: t = on/N, smoothstep = t*t*(3-2*t)
  // Inline because ffmpeg expressions don't have named variables.
  const N = totalFrames;
  const t = `(on/${N})`;
  const smoothT = `(${t}*${t}*(3-2*${t}))`; // 0→1 with ease-in-out

  // Common framing centers
  const cx = `iw/2-(iw/zoom/2)`;
  const cy = `ih/2-(ih/zoom/2)`;

  if (motion === "pull_out") {
    // 1.20 → 1.0 over the shot. Slight downward drift to reveal sky/ceiling.
    const zoom = `1.20-0.20*${smoothT}`;
    const yDrift = `${cy}+5*${smoothT}`;
    return `${PRE},zoompan=z='${zoom}':d=${N}:s=${s}:fps=${fps}:x='${cx}':y='${yDrift}'`;
  }
  if (motion === "lateral_pan") {
    // Hold zoom at 1.10, sweep x from -10% to +10% of crop width with easing.
    // Smooth lateral motion that mimics a gimbal track.
    const zoom = `1.10`;
    const xPan = `iw/2-(iw/zoom/2)+(iw*0.10)*(${smoothT}*2-1)`;
    return `${PRE},zoompan=z='${zoom}':d=${N}:s=${s}:fps=${fps}:x='${xPan}':y='${cy}'`;
  }
  if (motion === "vertical_reveal") {
    // Hold zoom at 1.10, sweep y from bottom-third upward. Tilt-up reveal.
    const zoom = `1.10`;
    const yTilt = `ih*0.65-(ih*0.30)*${smoothT}`;
    return `${PRE},zoompan=z='${zoom}':d=${N}:s=${s}:fps=${fps}:x='${cx}':y='${yTilt}'`;
  }
  if (motion === "parallax_zoom") {
    // Zoom 1.0 → 1.20 with slight diagonal drift for depth-feel.
    // Diagonal motion + zoom = strongest faux-parallax with a 2D image.
    const zoom = `1.0+0.20*${smoothT}`;
    const xDrift = `iw/2-(iw/zoom/2)+8*${smoothT}`;
    const yDrift = `ih/2-(ih/zoom/2)-6*${smoothT}`;
    return `${PRE},zoompan=z='${zoom}':d=${N}:s=${s}:fps=${fps}:x='${xDrift}':y='${yDrift}'`;
  }
  if (motion === "detail_sweep") {
    // Tighter zoom (1.15) holding steady, slow lateral sweep across detail.
    const zoom = `1.15`;
    const xSweep = `iw/2-(iw/zoom/2)+(iw*0.08)*(${smoothT}*2-1)`;
    return `${PRE},zoompan=z='${zoom}':d=${N}:s=${s}:fps=${fps}:x='${xSweep}':y='${cy}'`;
  }
  // Default push_in: 1.0 → 1.20 zoom with subtle downward drift.
  // Downward drift mimics a real dolly-in (camera approaches at eye level,
  // floor/foreground rises in frame).
  const zoom = `1.0+0.20*${smoothT}`;
  const yDrift = `ih/2-(ih/zoom/2)+8*${smoothT}`;
  return `${PRE},zoompan=z='${zoom}':d=${N}:s=${s}:fps=${fps}:x='${cx}':y='${yDrift}'`;
}

async function pollRunwayTask(taskId, sceneIndex) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const pollResponse = await fetch(`${RUNWAY_API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
      headers: runwayHeaders()
    });
    if (!pollResponse.ok) {
      const errText = await safeText(pollResponse);
      // 404 right after submit can happen for ~1s; retry a few times before giving up.
      if (pollResponse.status === 404) continue;
      throw new Error(`Runway poll failed for scene ${sceneIndex + 1}: HTTP ${pollResponse.status} ${errText.slice(0, 200)}`);
    }
    const data = await pollResponse.json();
    const status = String(data.status || "").toUpperCase();
    if (status === "SUCCEEDED") {
      const output = Array.isArray(data.output) ? data.output[0] : data.output;
      if (!output) throw new Error(`Runway task ${taskId} succeeded but returned no output URL.`);
      return output;
    }
    if (status === "FAILED" || status === "CANCELLED") {
      const reason = data.failure || data.failureCode || "unknown";
      throw new Error(`Runway task ${taskId} ${status}: ${reason}`);
    }
    // Still PENDING / RUNNING / THROTTLED — keep polling.
  }
  throw new Error(`Runway task ${taskId} timed out after ${POLL_TIMEOUT_MS / 1000}s.`);
}

/* =================================================================
   FFmpeg stitching
   ================================================================= */

export async function stitchClipsAndOverlays(clipResults, manifest, outputPath, thumbnailPath, options = {}) {
  clipResults.sort((a, b) => a.sceneIndex - b.sceneIndex);
  const tempDir = path.dirname(outputPath);
  const dimensions = runwayDimensions(manifest);
  const brand = normalizeBrandKitForFFmpeg(manifest.brandKit || {});

  // Step 1: normalize each clip to a uniform codec / framerate / resolution,
  // bake in the persistent brand watermark + color grade + corner headshot.
  //
  // v20 OOM fix: corner headshot is baked HERE per-clip instead of in a
  // separate post-stitch pass. The post-stitch approach (v19) ran a single
  // big ffmpeg overlay over ~120s of stitched video — peak memory was
  // ~250MB just for that step on top of the existing pipeline, which
  // tipped Render Standard's 2GB ceiling. Per-clip overlay is ~50MB peak
  // and runs serially, never accumulating.
  const watermarkFilter = buildWatermarkDrawtext(brand, dimensions);
  const colorGrade = COLOR_GRADE;
  // Pre-render the small corner headshot ONCE. Reused as a 2nd input on
  // every normalize call below. Falls back to null if the user has no
  // headshot URL or the pre-render fails — in that case we use -vf and
  // skip the overlay entirely.
  const cornerHeadshotSize = Math.round(dimensions.width * 0.12);
  const cornerHeadshotPath = brand.headshotUrl
    ? await buildHeadshotCircle(brand.headshotUrl, cornerHeadshotSize, tempDir).catch(() => null)
    : null;
  const cornerOverlayX = dimensions.width - cornerHeadshotSize - 24;
  const cornerOverlayY = 24;

  const normalizedClips = [];
  // Per-clip granular progress so the bar visibly moves through this step
  // instead of sitting at 76%. We split the 76→80 range across the clips.
  const NORMALIZE_PROGRESS_START = 76;
  const NORMALIZE_PROGRESS_RANGE = 4;
  for (let i = 0; i < clipResults.length; i++) {
    const clip = clipResults[i];
    const normalized = path.join(tempDir, `norm-${String(clip.sceneIndex).padStart(3, "0")}.mp4`);
    // v28: trim the 8s native-1080p Veo clip back to its intended length here —
    // free, since this normalize pass already re-encodes. Guarded so a missing
    // duration can never produce an empty (-t 0) clip.
    const trimArgs = Number(clip.duration) > 0 ? ["-t", String(clip.duration)] : [];
    const baseFilters = [
      `fps=30`,
      `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${dimensions.width}:${dimensions.height}`,
      colorGrade,
      ...(watermarkFilter ? [watermarkFilter] : [])
    ].join(",");

    if (cornerHeadshotPath) {
      // Two-input filter_complex: base video → grade + watermark → overlay headshot.
      const filterComplex =
        `[0:v]${baseFilters}[bg];` +
        `[bg][1:v]overlay=${cornerOverlayX}:${cornerOverlayY}[vout]`;
      await runFFmpeg([
        "-y",
        "-threads", "1",
        "-i", clip.clipPath,
        "-i", cornerHeadshotPath,
        "-filter_complex", filterComplex,
        "-map", "[vout]",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", ENCODE_PRESET,
        "-crf", ENCODE_CRF_MASTER,
        "-x264-params", X264_PARAMS,
        "-bufsize", BUFSIZE,
        ...trimArgs,
        "-an",
        normalized
      ], { timeoutMs: 180000, label: `runway:normalize-${clip.sceneIndex}` });
    } else {
      // No headshot — simpler single-input -vf chain.
      await runFFmpeg([
        "-y",
        "-threads", "1",
        "-i", clip.clipPath,
        "-vf", baseFilters,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", ENCODE_PRESET,
        "-crf", ENCODE_CRF_MASTER,
        "-x264-params", X264_PARAMS,
        "-bufsize", BUFSIZE,
        ...trimArgs,
        "-an",
        normalized
      ], { timeoutMs: 180000, label: `runway:normalize-${clip.sceneIndex}` });
    }

    normalizedClips.push({ ...clip, clipPath: normalized });
    options.onProgress?.({
      phase: `Polishing scene ${i + 1}/${clipResults.length}`,
      progress: NORMALIZE_PROGRESS_START + Math.floor(((i + 1) / clipResults.length) * NORMALIZE_PROGRESS_RANGE)
    });
  }
  // Clean up the corner headshot asset — every normalize call already
  // consumed it. Keeping it around just hogs disk.
  if (cornerHeadshotPath) await fs.unlink(cornerHeadshotPath).catch(() => {});

  // Step 2: prepare brand assets (headshot circle + brokerage logo) for the
  // outro card. These ffmpeg calls are tiny — fractions of a second each.
  // The outro is the final-impression real-estate card; this is where the
  // composited headshot + logo + license + Equal Housing footer earns the
  // "MLS-compliant" claim.
  options.onProgress?.({ phase: "Building outro card", progress: 80 });
  const headshotSize = Math.round(dimensions.width * 0.32);
  const logoMaxHeight = Math.round(dimensions.height * 0.07);
  const [headshotCirclePath, logoAssetPath] = await Promise.all([
    buildHeadshotCircle(brand.headshotUrl, headshotSize, tempDir),
    buildLogoAsset(brand.brokerageLogoUrl, logoMaxHeight, tempDir)
  ]);
  const outroClip = await buildBrandOutroClip(brand, dimensions, tempDir, {
    headshotCirclePath,
    logoAssetPath,
    headshotSize,
    logoMaxHeight
  });

  // Step 3: stitch.
  // ============================================================================
  // CRITICAL DESIGN DECISION: simple concat is the DEFAULT, not the fallback.
  // ============================================================================
  // The previous default (xfade with 0.5s crossfades) was a single ffmpeg
  // call that re-encoded all 24+ clips through a long filter_complex graph.
  // On Render Standard's 2GB plan that ate 3-8 minutes of CPU and routinely
  // OOM-killed the worker mid-stitch. The user sees this as "stuck at 80%".
  //
  // Simple concat with -c copy is a 1-2 second demuxer pass — no re-encode,
  // no filter graph, no RAM pressure. Hard cuts between scenes instead of
  // crossfades, but the render reliably ships.
  //
  // xfade is now opt-in via manifest.runwayConfig.useCrossfades. We can
  // re-enable it as the default once the worker has more RAM (Render
  // Standard Plus, 4GB) or once we batch the stitch into smaller groups.
  // ============================================================================
  const stitched = path.join(tempDir, "stitched.mp4");
  options.onProgress?.({ phase: "Stitching final video", progress: 81 });
  // Crossfades are the product. Default ON unless the manifest explicitly
  // opts out (e.g. some MLS regions reject any blended frames). If the
  // batched xfade pipeline throws, we still fall through to simple concat
  // below — so the render always ships, just with hard cuts.
  const useCrossfades = manifest?.runwayConfig?.useCrossfades !== false;
  if (useCrossfades) {
    try {
      await stitchWithCrossfades({
        clips: normalizedClips,
        outroClip,
        output: stitched,
        crossfadeDurationSec: 0.5
      });
    } catch (err) {
      console.warn(`[runway] xfade stitch failed (${err.message}). Falling back to simple concat.`);
      await stitchWithSimpleConcat({
        clips: normalizedClips,
        outroClip,
        output: stitched,
        tempDir
      });
    }
  } else {
    await stitchWithSimpleConcat({
      clips: normalizedClips,
      outroClip,
      output: stitched,
      tempDir
    });
  }

  // v20: corner headshot is baked into each clip during normalize above —
  // no separate post-stitch ffmpeg pass needed. The v19 approach OOM'd
  // Render Standard 2GB. Per-clip overlay distributes the work and never
  // accumulates more than one ffmpeg process worth of memory at a time.

  // Step 4: optional audio mix from manifest.musicMood mapping. We honor a
  // RUNWAY_MUSIC_<MOOD>_URL env var pointing to a remote MP3. If no music
  // configured, the final video has no audio (acceptable for v1).
  // v24.1: dropped music bed from 0.35 to 0.22 (~ -13 dB) because the
  // first real render had music dominating voice. Lower bed means:
  //   - music alone (narration missing/skipped): -13 dB — quiet background
  //   - music under voice: 0.22 × 0.30 = 0.066 → ~ -24 dB, voice
  //     clearly cuts through at +3 dB (VOICE_WEIGHT 1.4 in voice-mixer)
  // Trade-off: when there's no narration the video feels quieter. But
  // it's much better than music drowning a working narration. Bump back
  // up via env MUSIC_BED_LEVEL or manifest.musicBedLevel if needed.
  const musicBedLevel = Number(
    manifest?.musicBedLevel ?? process.env.MUSIC_BED_LEVEL ?? 0.22
  );
  // v24.2: respect manifest.skipMusic (set by webapp Audio panel toggle).
  // Even when a track is bundled, skip the mix step entirely so the
  // master ships with only voice (or silence).
  const musicUrl = manifest?.skipMusic ? null : pickMusicUrl(manifest);
  if (musicUrl) {
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", stitched,
      "-i", musicUrl,
      "-filter_complex", `[1:a]volume=${musicBedLevel.toFixed(3)}[mus]`,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-map", "0:v:0",
      "-map", "[mus]",
      outputPath
    ], { timeoutMs: 120000, label: "runway:music-mix" });
  } else {
    await fs.copyFile(stitched, outputPath);
  }

  // Free the stitched intermediate (already concatenated into outputPath).
  if (outroClip) await fs.unlink(outroClip).catch(() => {});
  await fs.unlink(stitched).catch(() => {});

  // NOTE: We do NOT delete the per-scene normalized clips here anymore.
  // The caller needs them for the per-scene regenerate flow — each clip
  // is uploaded to Supabase Storage so a single bad scene can be swapped
  // without re-rendering the entire video. Caller deletes them after upload.

  // Step 5: extract a thumbnail from ~10% in.
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-i", outputPath,
    "-ss", "1.5",
    "-vframes", "1",
    "-q:v", "3",
    thumbnailPath
  ], { timeoutMs: 30000, label: "runway:thumbnail" });

  // Return the normalized clips so the caller can upload them for regen support.
  return { normalizedClips };
}

// stitchWithCrossfades / stitchWithSimpleConcat were extracted into
// ./stitch.mjs so the depth engine and the runway engine can share
// the exact same crossfade/concat logic. See that file for the v22
// batched-xfade rationale and tuning constants.
//
// Local helpers below are runway-specific things that don't need to
// be shared (brand outro, etc.).

/* =================================================================
   Brand outro + persistent watermark
   ================================================================= */

const FFMPEG_FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";
const FFMPEG_FONT_REGULAR = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";

function normalizeBrandKitForFFmpeg(brandKit = {}) {
  return {
    name: ffEscape(brandKit.fullName || brandKit.name || ""),
    brokerage: ffEscape(brandKit.brokerage || ""),
    phone: ffEscape(brandKit.phone || ""),
    email: ffEscape(brandKit.email || ""),
    licenseNumber: ffEscape(brandKit.licenseNumber || ""),
    cta: ffEscape(brandKit.ctaText || "Schedule a private tour"),
    // Raw URLs preserved (not ff-escaped) for ffmpeg image inputs.
    headshotUrl: brandKit.headshotUrl || "",
    brokerageLogoUrl: brandKit.brokerageLogoUrl || ""
  };
}

// Pre-render the agent's headshot as a circular alpha-masked PNG for use
// in ffmpeg overlay calls (watermark + outro). Generated once per render
// at the chosen pixel size, then reused across compositions. Returns null
// if no headshot URL is configured.
async function buildHeadshotCircle(headshotUrl, sizePx, tempDir) {
  if (!headshotUrl) return null;
  try {
    const sourcePath = path.join(tempDir, "headshot-source.jpg");
    await downloadFile(headshotUrl, sourcePath);
    const circlePath = path.join(tempDir, `headshot-circle-${sizePx}.png`);
    const radius = sizePx / 2;
    const radiusInner = radius - 1;
    // geq=...a='if(gt(distance,radius),0,255)' produces a hard-edged
    // circular alpha mask. Combined with format=yuva420p so we have an
    // alpha channel to mask against.
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", sourcePath,
      "-vf",
      `scale=${sizePx}:${sizePx}:force_original_aspect_ratio=increase,crop=${sizePx}:${sizePx},format=yuva420p,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(pow(X-${radius},2)+pow(Y-${radius},2),pow(${radiusInner},2)),0,255)'`,
      "-frames:v", "1",
      circlePath
    ], { timeoutMs: 30000, label: "runway:headshot-circle" });
    await fs.unlink(sourcePath).catch(() => {});
    return circlePath;
  } catch (err) {
    console.warn(`[runway] headshot circle failed (${err.message}). Outro will fall back to text-only.`);
    return null;
  }
}

// Pre-render the brokerage logo scaled to fit a target height (preserving
// aspect ratio and transparent background). Returns null on failure.
async function buildLogoAsset(logoUrl, maxHeightPx, tempDir) {
  if (!logoUrl) return null;
  try {
    const sourcePath = path.join(tempDir, "logo-source");
    await downloadFile(logoUrl, sourcePath);
    const outPath = path.join(tempDir, `logo-${maxHeightPx}.png`);
    await runFFmpeg([
      "-y", "-threads", "1",
      "-i", sourcePath,
      // Scale to fit the height, preserve aspect, keep alpha if present.
      "-vf", `scale=-1:${maxHeightPx}:flags=lanczos,format=rgba`,
      "-frames:v", "1",
      outPath
    ], { timeoutMs: 30000, label: "runway:logo-asset" });
    await fs.unlink(sourcePath).catch(() => {});
    return outPath;
  } catch (err) {
    console.warn(`[runway] logo asset prep failed (${err.message}). Outro will skip logo.`);
    return null;
  }
}

// drawtext expects backslash-escaped colons, single quotes, and percent signs.
function ffEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

function runwayDimensions(manifest) {
  const ratio = String(manifest?.runwayConfig?.ratio || manifest?.exportFormat || "vertical").toLowerCase();
  if (ratio === "16:9" || ratio === "wide") return { width: 1920, height: 1080 };
  if (ratio === "1:1" || ratio === "square") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

// Lower-left tinted plate with name + brokerage. drawtext box is the closest
// ffmpeg-native equivalent of the Reel-e.ai persistent identity badge.
function buildWatermarkDrawtext({ name, brokerage }, dimensions) {
  if (!name && !brokerage) return "";
  const baseY = dimensions.height - 130;
  const fontSize = Math.max(22, Math.round(dimensions.width / 50));
  const subSize = Math.max(18, Math.round(dimensions.width / 64));
  const filters = [];
  if (name) {
    filters.push(
      `drawtext=fontfile='${FFMPEG_FONT}'` +
      `:text='${name}'` +
      `:fontcolor=white:fontsize=${fontSize}` +
      `:x=36:y=${baseY}` +
      `:box=1:boxcolor=black@0.55:boxborderw=12`
    );
  }
  if (brokerage) {
    const subY = name ? baseY + fontSize + 10 : baseY;
    filters.push(
      `drawtext=fontfile='${FFMPEG_FONT_REGULAR}'` +
      `:text='${brokerage}'` +
      `:fontcolor=white@0.85:fontsize=${subSize}` +
      `:x=36:y=${subY}` +
      `:box=1:boxcolor=black@0.55:boxborderw=10`
    );
  }
  return filters.join(",");
}

// Build a 5-second outro card via ffmpeg lavfi: solid background, agent name
// large + centered, brokerage below, contact line below. No headshot in v1
// (circular masks via geq are slow on the worker; Quick Reel renders the
// headshot circle the proper way via Remotion).
// Brand outro card, fully composited.
// Layers from back to front:
//   1. dark vignette background
//   2. circular headshot at top-center (if available)
//   3. brokerage logo to the right of the headshot (if available)
//   4. CTA eyebrow → agent name → brokerage → license → contact
//   5. Equal Housing footer + Vistalia attribution
// All optional pieces gracefully omit when not provided.
async function buildBrandOutroClip(
  { name, brokerage, phone, email, licenseNumber, cta },
  dimensions,
  tempDir,
  assets = {}
) {
  if (!name && !brokerage) return null;
  const outroPath = path.join(tempDir, "brand-outro.mp4");
  const { headshotCirclePath, logoAssetPath, headshotSize = 0, logoMaxHeight = 0 } = assets;

  // Layout — compute Y positions sequentially so the card adapts to which
  // optional pieces are present.
  const W = dimensions.width;
  const H = dimensions.height;
  const padTop = Math.round(H * 0.12);
  const headshotY = headshotCirclePath ? padTop : 0;
  const logoY = padTop + Math.round(headshotSize * 0.5) - Math.round(logoMaxHeight / 2);
  const headerBlockBottom = headshotCirclePath
    ? padTop + headshotSize
    : padTop;
  const ctaY = headerBlockBottom + Math.round(H * 0.04);
  const ctaSize = Math.max(20, Math.round(W / 48));
  const nameSize = Math.max(56, Math.round(W / 13));
  const brokerSize = Math.max(28, Math.round(W / 32));
  const licenseSize = Math.max(20, Math.round(W / 50));
  const contactSize = Math.max(22, Math.round(W / 44));
  const footerSize = Math.max(16, Math.round(W / 60));

  const nameY = ctaY + ctaSize + Math.round(H * 0.025);
  const brokerY = nameY + nameSize + Math.round(H * 0.02);
  const licenseY = brokerY + brokerSize + Math.round(H * 0.012);
  const contactY = licenseY + licenseSize + Math.round(H * 0.022);
  const accentRuleY = contactY + contactSize + Math.round(H * 0.018);
  const footerY = H - Math.round(H * 0.06);

  // Inputs: lavfi background + optional headshot + optional logo. Indices
  // in the filter graph: [0:v] = bg, [1:v] = headshot (if present),
  // [2:v] = logo (if both present), or [1:v] = logo (if only logo).
  const inputs = [
    "-f", "lavfi",
    "-i", `color=c=0x0A0A0A:size=${W}x${H}:rate=30:duration=5`
  ];
  let nextInputIndex = 1;
  let headshotInputIdx = -1;
  let logoInputIdx = -1;
  if (headshotCirclePath) {
    inputs.push("-i", headshotCirclePath);
    headshotInputIdx = nextInputIndex++;
  }
  if (logoAssetPath) {
    inputs.push("-i", logoAssetPath);
    logoInputIdx = nextInputIndex++;
  }

  // Build the filter graph step by step. Each step labels its output for
  // the next step to consume.
  const graphSteps = [];
  let lastLabel = "0:v";
  graphSteps.push(`[${lastLabel}]vignette=PI/4[bg0]`);
  lastLabel = "bg0";

  if (headshotInputIdx >= 0) {
    const headshotX = logoAssetPath
      ? Math.round(W / 2 - headshotSize - 30)
      : Math.round((W - headshotSize) / 2);
    graphSteps.push(`[${lastLabel}][${headshotInputIdx}:v]overlay=${headshotX}:${headshotY}[withhead]`);
    lastLabel = "withhead";
  }
  if (logoInputIdx >= 0) {
    const logoX = headshotCirclePath
      ? Math.round(W / 2 + 30)
      : Math.round((W - logoMaxHeight * 3) / 2); // centered when no headshot
    graphSteps.push(`[${lastLabel}][${logoInputIdx}:v]overlay=${logoX}:${logoY}[withlogo]`);
    lastLabel = "withlogo";
  }

  // Text overlays — chained as drawtext filters.
  const drawtextChain = [];
  // CTA eyebrow (gold uppercase, manually spaced for tracking)
  if (cta) {
    const spacedCta = cta.toUpperCase().split("").join(" ").replace(/  +/g, "  ");
    drawtextChain.push(
      `drawtext=fontfile='${FFMPEG_FONT}':text='${spacedCta}':fontcolor=0xC7A76C:fontsize=${ctaSize}:x=(w-text_w)/2:y=${ctaY}`
    );
  }
  // Agent name — the primary line
  drawtextChain.push(
    `drawtext=fontfile='${FFMPEG_FONT}':text='${name || "Your Local Agent"}':fontcolor=white:fontsize=${nameSize}:x=(w-text_w)/2:y=${nameY}`
  );
  // Brokerage
  if (brokerage) {
    drawtextChain.push(
      `drawtext=fontfile='${FFMPEG_FONT_REGULAR}':text='${brokerage}':fontcolor=white@0.85:fontsize=${brokerSize}:x=(w-text_w)/2:y=${brokerY}`
    );
  }
  // License number — the MLS-compliance signal
  if (licenseNumber) {
    drawtextChain.push(
      `drawtext=fontfile='${FFMPEG_FONT_REGULAR}':text='${licenseNumber}':fontcolor=0xC7A76C:fontsize=${licenseSize}:x=(w-text_w)/2:y=${licenseY}`
    );
  }
  // Contact line
  const contact = [phone, email].filter(Boolean).join("   ·   ");
  if (contact) {
    drawtextChain.push(
      `drawtext=fontfile='${FFMPEG_FONT_REGULAR}':text='${contact}':fontcolor=white@0.92:fontsize=${contactSize}:x=(w-text_w)/2:y=${contactY}`
    );
  }
  // Bottom accent rule
  drawtextChain.push(
    `drawbox=x=(w-280)/2:y=${accentRuleY}:w=280:h=2:color=0xC7A76C:t=fill`
  );
  // Equal Housing + Vistalia attribution footer (MLS compliance)
  const footerText = ffEscape("Equal Housing Opportunity  ·  Made with Vistalia");
  drawtextChain.push(
    `drawtext=fontfile='${FFMPEG_FONT_REGULAR}':text='${footerText}':fontcolor=white@0.55:fontsize=${footerSize}:x=(w-text_w)/2:y=${footerY}`
  );
  // Fade in / out so xfade can blend cleanly
  drawtextChain.push(`fade=t=in:st=0:d=0.6:alpha=0`);
  drawtextChain.push(`fade=t=out:st=4.4:d=0.6:alpha=0`);

  graphSteps.push(`[${lastLabel}]${drawtextChain.join(",")}[vout]`);
  const filterComplex = graphSteps.join(";");

  await runFFmpeg([
    "-y",
    "-threads", "1",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", ENCODE_PRESET,
    "-crf", ENCODE_CRF_MASTER,
    "-x264-params", X264_PARAMS,
    "-bufsize", BUFSIZE,
    "-r", "30",
    "-t", "5",
    "-an",
    outroPath
  ], { timeoutMs: 90000, label: "runway:outro-card" });

  // Free the asset PNGs now that the outro is on disk.
  if (headshotCirclePath) await fs.unlink(headshotCirclePath).catch(() => {});
  if (logoAssetPath) await fs.unlink(logoAssetPath).catch(() => {});

  return outroPath;
}

async function downloadFile(url, destPath) {
  // 60-second timeout — Runway clip downloads should be fast (~5MB), but
  // a hung CDN connection without a timeout would lock the whole pipeline.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destPath, buffer);
  } finally {
    clearTimeout(timer);
  }
}

/* =================================================================
   Supabase upload
   ================================================================= */

// Per-scene clip uploader for regenerate-scene support. Pushes each
// normalized per-scene MP4 to Supabase Storage with a deterministic
// filename (scene-000.mp4 → scene-023.mp4) inside the job folder, and
// returns the scene metadata array that goes into the audit log.
// Failures here are warned-and-skipped; regen for that one scene will
// fall back to "not available" in the UI but the rest of the render
// still ships.
export async function uploadPerSceneClips({ manifest, jobId, normalizedClips, clipResults, pathPrefix }) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const bucket = process.env.SUPABASE_GENERATED_VIDEOS_BUCKET || "generated-videos";
  if (!supabaseUrl || !serviceRoleKey) {
    return [];
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const ownerId = slug(manifest.project?.userId || manifest.project?.id || "demo");
  const basePath = `${ownerId}/${pathPrefix}/${jobId}`;

  // Cross-reference normalizedClips against clipResults so we have full
  // per-scene metadata (photoId, runwayPrompt, fallback flag, etc).
  const resultsByIndex = new Map(clipResults.map((c) => [c.sceneIndex, c]));
  const sceneMeta = [];
  for (const clip of normalizedClips) {
    const original = resultsByIndex.get(clip.sceneIndex) || {};
    const sceneIndex = clip.sceneIndex;
    const filename = `scene-${String(sceneIndex).padStart(3, "0")}.mp4`;
    const storagePath = `${basePath}/${filename}`;
    let clipUrl = "";
    try {
      const buffer = await fs.readFile(clip.clipPath);
      const result = await supabase.storage.from(bucket).upload(storagePath, buffer, {
        contentType: "video/mp4",
        upsert: true
      });
      if (!result.error) {
        clipUrl = supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;
      } else {
        console.warn(`[upload] scene ${sceneIndex} clip upload failed: ${result.error.message}`);
      }
    } catch (err) {
      console.warn(`[upload] scene ${sceneIndex} clip read/upload failed: ${err.message || err}`);
    }
    // Even if upload failed, still include the metadata — clipUrl will
    // just be empty and the regen UI will show that scene as "not regenerable".
    sceneMeta.push({
      sceneIndex,
      photoId: original.photoId || "",
      photoUrl: pickSceneImageUrl(original, manifest),
      clipUrl,
      storagePath: clipUrl ? storagePath : "",
      roomType: original.roomType || inferRoomTypeFromScene(original, manifest) || "",
      cameraMotion: original.cameraMotion || "",
      duration: Number(clip.duration || original.duration || 5),
      runwayPrompt: original.runwayPrompt || "",
      wasFallback: Boolean(original.fallback)
    });
  }
  return sceneMeta;
}

// Look up the durable photo URL for a scene from the manifest's
// orderedPhotos. Used to build the scenes audit metadata.
function pickSceneImageUrl(sceneOrResult, manifest) {
  if (!sceneOrResult) return "";
  const photoId = sceneOrResult.photoId;
  if (!photoId) return "";
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === photoId);
  if (!photo) return "";
  return photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || "";
}

function inferRoomTypeFromScene(sceneOrResult, manifest) {
  if (sceneOrResult?.roomType) return sceneOrResult.roomType;
  const manifestScene = (manifest.scenes || []).find((s) => s.photoId === sceneOrResult?.photoId);
  return manifestScene?.roomType || "";
}

async function uploadRunwayAssets({ manifest, jobId, variants, shorts, thumbnailPath, onProgress }) {
  return uploadDeliverables({
    manifest,
    jobId,
    variants,
    shorts,
    thumbnailPath,
    pathPrefix: "runway",
    onProgress
  });
}

// Shared multi-format uploader — used by both Runway and Remotion pipelines.
// Uploads:
//   <owner>/<prefix>/<jobId>/master.mp4           (vertical, kept as the
//                                                  primary deliverable)
//   <owner>/<prefix>/<jobId>/square.mp4
//   <owner>/<prefix>/<jobId>/wide.mp4
//   <owner>/<prefix>/<jobId>/short-1.mp4..short-N.mp4
//   <owner>/<prefix>/<jobId>/thumbnail.png
export async function uploadDeliverables({ manifest, jobId, variants, shorts, thumbnailPath, pathPrefix, onProgress }) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const bucket = process.env.SUPABASE_GENERATED_VIDEOS_BUCKET || "generated-videos";

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      storageSkipped: true,
      storageWarning: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required to upload generated videos.",
      formats: {},
      socialShorts: [],
      thumbnailUrl: ""
    };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const ownerId = slug(manifest.project?.userId || manifest.project?.id || "demo");
  const basePath = `${ownerId}/${pathPrefix}/${jobId}`;

  const VARIANT_FILENAMES = {
    vertical: "master.mp4",
    square: "square.mp4",
    wide: "wide.mp4"
  };

  // Per-file upload helper with one retry — Supabase upload occasionally
  // 502s on large files due to network blips; one retry resolves >95%
  // of those without escalating to a job failure.
  const uploadOneFile = async (storagePath, localPath, contentType, label) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buffer = await fs.readFile(localPath);
        const result = await supabase.storage.from(bucket).upload(storagePath, buffer, {
          contentType,
          upsert: true
        });
        if (result.error) throw new Error(result.error.message);
        return supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;
      } catch (err) {
        if (attempt === 1) {
          console.warn(`[upload] ${label} failed after retry: ${err.message}`);
          return null;
        }
        console.warn(`[upload] ${label} attempt 1 failed (${err.message}), retrying...`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return null;
  };

  // Compute total file count up front so we can emit accurate per-file
  // progress (94 → 99 distributed across all uploads).
  const variantEntries = Object.entries(variants || {}).filter(([, info]) => info?.path);
  const shortsToUpload = (shorts || []).filter((s) => s?.path);
  const totalFiles = variantEntries.length + shortsToUpload.length + 1; // +1 thumbnail
  let filesDone = 0;
  const tickProgress = (label) => {
    filesDone += 1;
    onProgress?.({
      phase: `Uploaded ${filesDone}/${totalFiles} — ${label}`,
      fileLabel: label,
      fraction: filesDone / totalFiles
    });
  };

  // Upload format variants (vertical / square / wide) — per-variant isolation.
  // If wide upload fails, vertical and square still ship. The vertical is
  // the primary deliverable; if even that fails, the response will reflect it.
  const uploadedFormats = {};
  for (const [variantKey, info] of variantEntries) {
    const filename = VARIANT_FILENAMES[variantKey] || `${variantKey}.mp4`;
    const storagePath = `${basePath}/${filename}`;
    const mp4Url = await uploadOneFile(storagePath, info.path, "video/mp4", `${variantKey} variant`);
    if (mp4Url) {
      uploadedFormats[variantKey] = {
        mp4Url,
        storagePath,
        dimensions: info.dimensions || null
      };
    }
    tickProgress(`${variantKey} variant`);
  }

  // Upload social shorts — per-short isolation. Worst case we ship 1 of 3
  // rather than zero of three.
  const uploadedShorts = [];
  for (const short of shortsToUpload) {
    const storagePath = `${basePath}/short-${short.clipNumber}.mp4`;
    const mp4Url = await uploadOneFile(storagePath, short.path, "video/mp4", `short ${short.clipNumber}`);
    if (mp4Url) {
      uploadedShorts.push({
        clipNumber: short.clipNumber,
        mp4Url,
        storagePath,
        durationSec: short.durationSec,
        sourceSceneOrder: short.sourceSceneOrder,
        roomType: short.roomType
      });
    }
    // Free the local file regardless of upload outcome.
    await fs.unlink(short.path).catch(() => {});
    tickProgress(`hero short ${short.clipNumber}`);
  }

  // Thumbnail — non-fatal if it fails.
  const thumbnailStoragePath = `${basePath}/thumbnail.png`;
  const thumbnailUrl = await uploadOneFile(thumbnailStoragePath, thumbnailPath, "image/png", "thumbnail");
  if (!thumbnailUrl) {
    console.warn("[upload] thumbnail upload failed; agents will see a black poster image. Render still ships.");
  }
  tickProgress("thumbnail");

  // Free the derived format files (the master is owned by the caller and may
  // still be needed for cleanup).
  for (const [variantKey, info] of Object.entries(variants || {})) {
    if (variantKey === "vertical") continue; // master stays — caller cleans up
    if (info?.path) await fs.unlink(info.path).catch(() => {});
  }

  return {
    storageSkipped: false,
    formats: uploadedFormats,
    socialShorts: uploadedShorts,
    thumbnailUrl,
    thumbnailStoragePath
  };
}

/* =================================================================
   Helpers
   ================================================================= */

function validateRunwayManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error("Runway render manifest must include scenes.");
  }
  const photos = manifest.orderedPhotos || [];
  if (!photos.length) throw new Error("Runway render manifest must include orderedPhotos.");

  const photosById = new Map(photos.map((p) => [p.id, p]));
  for (const scene of manifest.scenes) {
    const type = String(scene.type || "photo").toLowerCase();
    if (NON_PHOTO_TYPES.has(type)) continue;
    if (!scene.photoId) throw new Error(`Runway scene missing photoId.`);
    if (!photosById.has(scene.photoId)) throw new Error(`Runway scene ${scene.photoId} not in orderedPhotos.`);
    const photo = photosById.get(scene.photoId);
    const imageUrl = pickImageUrl(scene, photo);
    if (!imageUrl) throw new Error(`Runway scene ${scene.photoId} missing durable image URL.`);
    if (String(imageUrl).startsWith("blob:") || String(imageUrl).startsWith("data:")) {
      throw new Error(`Scene ${scene.photoId} has browser-only URL (blob:/data:). Re-upload first.`);
    }
    // v26.9: this validator runs for BOTH the veo and runway paths (the job is
    // engine-agnostic now). The Veo per-scene generator uses veoPrompt, falls
    // back to runwayPrompt, and finally to a constrained prompt — so a scene is
    // valid as long as it has ANY prompt (and even none is recoverable). Only
    // hard-require a prompt; never demand the legacy runwayPrompt specifically.
    if (!scene.veoPrompt && !scene.veo_prompt && !scene.runwayPrompt && !scene.runway_prompt) {
      throw new Error(`Scene ${scene.photoId} has no motion prompt — regenerate the edit plan.`);
    }
  }
}

function pickImageUrl(scene, photo) {
  return (
    scene?.durableUrl ||
    scene?.durable_url ||
    scene?.publicUrl ||
    scene?.public_url ||
    scene?.imageUrl ||
    photo?.durableUrl ||
    photo?.durable_url ||
    photo?.publicUrl ||
    photo?.public_url ||
    photo?.imageUrl ||
    photo?.uri ||
    ""
  );
}

function ratioForRunway(ratio, model = "gen4_turbo") {
  // Runway expects WxH pixel pairs for image_to_video, not aspect strings.
  // Gen-3a Turbo and Gen-4 Turbo use slightly different pixel pairs.
  // Picking the right pair per model so the API doesn't reject the request.
  const value = String(ratio || "9:16").toLowerCase();
  const isGen4 = String(model || "").toLowerCase().includes("gen4");

  if (value === "16:9" || value === "wide") {
    return isGen4 ? "1280:720" : "1280:768";
  }
  if (value === "1:1" || value === "square") {
    return "960:960"; // both Gen-3 and Gen-4 accept this
  }
  // 9:16 default
  return isGen4 ? "720:1280" : "768:1280";
}

// Music selection — checks the bundled local files first, then falls back
// to env-var URLs, then nothing. Bundled files live at
// /render-worker/music/{slug}.mp3. See render-worker/music/README.md for
// the curated track recommendations and how to drop them in.
function pickMusicUrl(manifest) {
  // Resolve absolute paths for the bundled music directory.
  const musicDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "music");

  // 0. Music selector: if the manifest explicitly names a track filename
  //    (set by the webapp's MusicSelector component from the typed catalog),
  //    use exactly that file. Strip any leading path so a malicious or
  //    misformed payload can't escape the music dir.
  const explicitTrack = String(manifest?.musicTrack || "").trim();
  if (explicitTrack) {
    const safeName = path.basename(explicitTrack);
    const explicitPath = path.join(musicDir, safeName);
    if (existsSync(explicitPath)) return explicitPath;
    console.warn(`[music] manifest.musicTrack="${safeName}" not found on disk — falling back to style default.`);
  }

  // Determine which style "slot" this mood belongs to.
  const mood = String(manifest.musicMood || manifest.selectedStyle || "").toLowerCase();
  let slot;
  if (mood.includes("social") || mood.includes("upbeat") || mood.includes("modern") || mood.includes("viral")) {
    slot = "social";
  } else if (mood.includes("mls") || mood.includes("ambient") || mood.includes("clean")) {
    slot = "mls";
  } else if (mood.includes("investor") || mood.includes("minimal")) {
    slot = "investor";
  } else {
    slot = "luxury"; // default for "Cinematic Luxury" or unrecognized
  }

  // Per-style default filenames — all Pixabay Content License (verified
  // source). The webapp normally sends an explicit manifest.musicTrack
  // (handled above); this slot path only fires for legacy/empty manifests.
  const SLOT_DEFAULT_FILE = {
    luxury:   "luxury-poradovskyi.mp3",
    social:   "the_mountain-pop-490010.mp3",
    mls:      "nastelbom-corporate-soft-488321.mp3",
    investor: "the_mountain-corporate-455905.mp3"
  };

  // 1. Slot default local file.
  const slotPath = path.join(musicDir, SLOT_DEFAULT_FILE[slot] || SLOT_DEFAULT_FILE.luxury);
  if (existsSync(slotPath)) return slotPath;

  // 2. Ultimate local fallback: the verified luxury track (always bundled),
  //    so every render still gets music even if a slot file is missing.
  const fallbackPath = path.join(musicDir, "luxury-poradovskyi.mp3");
  if (existsSync(fallbackPath)) return fallbackPath;

  // 3. Env-var-configured URLs (legacy fallback path).
  const envSlotMap = {
    luxury: ["RUNWAY_MUSIC_LUXURY_URL", "MUSIC_LUXURY_URL"],
    social: ["RUNWAY_MUSIC_VIRAL_URL", "MUSIC_VIRAL_URL"],
    mls: ["RUNWAY_MUSIC_MLS_URL", "MUSIC_MLS_CLEAN_URL"],
    investor: ["RUNWAY_MUSIC_INVESTOR_URL", "MUSIC_INVESTOR_URL"]
  };
  for (const envName of envSlotMap[slot] || []) {
    if (process.env[envName]) return process.env[envName];
  }

  // 4. Last-resort default URL.
  return process.env.RUNWAY_MUSIC_DEFAULT_URL || "";
}

function runwayHeaders() {
  return {
    Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
    "X-Runway-Version": RUNWAY_API_VERSION,
    "Content-Type": "application/json"
  };
}

// Submit a Runway image_to_video task with exponential-backoff retry on
// 429 (short-window rate limit) and 5xx (transient server error). Stops
// retrying immediately on a 429 that contains "daily" — that's a terminal
// quota error, retrying just wastes time and floods their logs.
//
// Backoff: 2s, 5s, 12s, 25s — total worst-case 44s before giving up. With
// concurrency=4 across 24 scenes, the per-minute rate-limit window
// usually clears within the first or second backoff cycle.
async function submitRunwayTaskWithRetry({ body, sceneIndex, maxAttempts = 5 }) {
  let lastResponse = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${RUNWAY_API_BASE}/image_to_video`, {
      method: "POST",
      headers: runwayHeaders(),
      body: JSON.stringify(body)
    });
    if (response.ok) return response;

    // Read body once so we can both inspect for "daily" and propagate it.
    const errBody = await response.clone().text().catch(() => "");
    const isDailyCap = response.status === 429 && /daily/i.test(errBody);
    const isShortRateLimit = response.status === 429 && !isDailyCap;
    const isTransientServerError = response.status >= 500 && response.status < 600;

    if (isDailyCap || (!isShortRateLimit && !isTransientServerError)) {
      // Terminal — no point retrying.
      return response;
    }

    lastResponse = response;
    if (attempt === maxAttempts - 1) break;

    const delayMs = Math.min(25000, 2000 * Math.pow(2.2, attempt));
    console.warn(`[runway] scene ${sceneIndex + 1} got ${response.status}, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})`);
    await sleep(delayMs);
  }
  return lastResponse;
}

async function safeText(response) {
  try { return await response.text(); } catch { return ""; }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pMap(items, fn, { concurrency = 4 } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  const errors = [];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        errors.push({ index: i, error });
        throw error;
      }
    }
  });
  try {
    await Promise.all(workers);
  } catch {
    // Surface the first error with full context. Preserve the structured
    // error.code from the underlying call (e.g. RUNWAY_DAILY_CAP) so the
    // worker's status endpoint and the frontend can surface upgrade prompts
    // instead of a generic failure.
    const first = errors[0];
    const wrapped = new Error(first.error.message || `Runway scene ${first.index + 1} failed.`);
    wrapped.code = first.error.code;
    wrapped.httpStatus = first.error.httpStatus;
    throw wrapped;
  }
  return results;
}

function createJobId(manifest) {
  const projectId = manifest.project?.id || manifest.project?.title || "estate-motion";
  return `runway-${slug(projectId)}-${Date.now()}`;
}

function slug(value) {
  return String(value || "render").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "render";
}

/* =================================================================
   Hallucination Guard — content-aware Runway-vs-Ken-Burns routing
   =================================================================

   The user's repeated production-blocker has been kitchens: split
   countertops, phantom microwave doors, phantom ceiling fans, morphed
   cabinet faces. These failures happen because Gen-4 Turbo, when shown
   parallel-edge surfaces (cabinets, counters, tile grids, blinds) or
   reflective panels (granite, marble, glass, polished steel), tends to
   invent motion in them — splitting one edge into two, or "completing"
   a partial circle by adding a fan.

   The pre-existing protectHighRiskRooms toggle only matched the
   roomType field. That misses two failure modes:
     1. Misclassified kitchens (labeled "living" or "amenity") still run
        through Runway and still hallucinate.
     2. Living rooms with bookshelves or windows with shutters have the
        same parallel-edge failure profile but aren't covered.

   The Hallucination Guard fixes both by scoring each scene's risk based
   on roomType AND on the visibleFeatures list AND on the prompt itself.
*/

// Risk-additive keywords. Each match adds points to the scene's risk
// score. Higher score → more likely Runway invents motion.
const RISK_KEYWORDS = {
  // Parallel-edge surfaces — Runway's #1 failure mode (splits or duplicates).
  high: [
    "cabinet", "cabinetry", "countertop", "counter", "shelves", "shelf",
    "bookshelf", "bookcase", "blinds", "shutters", "slats", "louver",
    "tile", "grout", "grid", "mullion", "wainscot"
  ],
  // Appliances — frequently morphed (microwave door on fridge, etc).
  appliance: [
    "appliance", "appliances", "microwave", "fridge", "refrigerator",
    "freezer", "oven", "range", "stove", "cooktop", "dishwasher",
    "washer", "dryer", "hood", "vent", "vent hood", "sink", "faucet"
  ],
  // Round/spinning shapes — Runway hallucinates fans / pendant motion.
  rotational: [
    "fan", "ceiling fan", "blade", "blades", "pendant", "chandelier",
    "wheel", "spinner", "turbine", "propeller", "globe"
  ],
  // Reflective surfaces — Runway invents reflections that morph the room.
  reflective: [
    "granite", "marble", "quartz", "polished", "mirror", "mirrors",
    "glass", "stainless", "chrome", "lacquer"
  ],
  // Text or signage — frequently mangled into gibberish.
  text: [
    "sign", "logo", "label", "text", "writing", "lettering", "menu",
    "address", "number", "license plate"
  ]
};

// Per-room baseline risk. Picked from observed failure rates over
// hundreds of test renders. Kitchen is intentionally pinned at 80 so a
// kitchen with ANY appliance feature crosses the "balanced" threshold (60).
const ROOM_BASE_RISK = {
  kitchen: 80,
  bathroom: 60,
  bedroom: 25,
  living: 20,
  detail: 15,
  amenity: 10,
  exterior: 8,
  outdoor: 5
};

// Resolve hallucinationGuard from manifest, with backwards-compat for the
// legacy protectHighRiskRooms boolean.
function resolveGuardLevel(manifest) {
  const raw = String(manifest?.hallucinationGuard || "").toLowerCase();
  if (["off", "balanced", "strict"].includes(raw)) return raw;
  // Legacy: protectHighRiskRooms true → balanced, false → off.
  // (Default for new clients: "balanced" — see the next line.)
  if (manifest?.protectHighRiskRooms === false) return "off";
  if (manifest?.protectHighRiskRooms === true) return "balanced";
  // Default when neither is specified: balanced. This is the new production
  // default — Runway hallucinations were the #1 quality complaint.
  return "balanced";
}

// Decide whether a given scene should go through Runway or Ken Burns,
// returning the risk score and a human-readable reason for logging.
function decideUseKenBurns(scene, guardLevel) {
  if (guardLevel === "off") {
    return { useKenBurns: false, risk: 0, reason: "guard off" };
  }
  const risk = computeHallucinationRisk(scene);
  const room = String(scene?.roomType || "").toLowerCase();

  // v27 AUDIT FIX: rotational objects (ceiling fans, chandeliers, pendants) are
  // the single most damaging hallucination — they SPIN or morph. The old risk
  // math let a living-room/bedroom ceiling fan (~35-55) sail under the 90
  // balanced threshold straight onto the cinematic path. Now ANY scene naming a
  // rotational object is forced safe regardless of score. On the Veo path this
  // maps to the CONSTRAINED "nothing moves" prompt; on legacy Runway, Ken Burns.
  const riskBlob = [
    Array.isArray(scene?.visibleFeatures) ? scene.visibleFeatures.join(" ") : "",
    scene?.runwayPrompt || "", scene?.veoPrompt || "", scene?.runway_prompt || ""
  ].join(" ").toLowerCase();
  if (RISK_KEYWORDS.rotational.some((kw) => riskBlob.includes(kw))) {
    return { useKenBurns: true, risk, reason: `rotational object (fan/pendant) → constrained (risk ${risk})` };
  }

  // STRICT: lock all kitchens regardless of features. Aggressive lower threshold.
  if (guardLevel === "strict") {
    if (room === "kitchen") {
      return { useKenBurns: true, risk, reason: "strict: all kitchens locked" };
    }
    if (risk >= 35) {
      return { useKenBurns: true, risk, reason: `strict: risk≥35 (${risk})` };
    }
  }

  // v24.5: dramatically softened balanced default. Troy's user-test
  // hit 6/8 KB on a normal 8-photo listing — way too many. The new
  // contract for BALANCED:
  //   - Kitchens: ALWAYS fall back. The morphed-appliance failure is
  //     the most common AND most damaging hallucination on real estate
  //     content. Cost of falling back: one Ken Burns scene. Cost of
  //     Runway-on-kitchen: agent loses a listing because the fridge
  //     has the wrong door count.
  //   - Bathrooms: fall back ONLY at risk ≥85 (was ≥60). Most
  //     bathrooms render fine on Runway; only the heavy-mirror,
  //     heavy-tile shots are risky.
  //   - Everything else: fall back ONLY at risk ≥90 (was ≥80). Effectively
  //     never trips on a normal listing — would need multi-category
  //     keyword stacking PLUS aggressive motion. The goal is at most
  //     ONE fallback per typical listing (the kitchen).
  if (room === "kitchen") {
    return { useKenBurns: true, risk, reason: `kitchen always falls back (risk ${risk})` };
  }
  if (room === "bathroom" && risk >= 85) {
    return { useKenBurns: true, risk, reason: `bathroom risk≥85 (${risk})` };
  }
  if (risk >= 90) {
    return { useKenBurns: true, risk, reason: `risk≥90 (${risk}, ${room || "unknown"})` };
  }

  return { useKenBurns: false, risk, reason: `risk ${risk} below threshold` };
}

// Compute a 0-100 risk score for a single scene based on its room + features
// + prompt. Higher = more likely Runway hallucinates. Bounded so a perfectly
// safe exterior never crosses thresholds and a kitchen with multiple risk
// keywords saturates well above the "strict" threshold.
function computeHallucinationRisk(scene) {
  const room = String(scene?.roomType || "").toLowerCase();
  let score = ROOM_BASE_RISK[room] ?? 15;

  // Build a lowercase search blob from visibleFeatures + runwayPrompt. The
  // prompt is included because Motion Director sometimes names risky
  // features that the visibleFeatures array missed.
  const blobParts = [];
  if (Array.isArray(scene?.visibleFeatures)) blobParts.push(scene.visibleFeatures.join(" "));
  if (scene?.runwayPrompt) blobParts.push(scene.runwayPrompt);
  if (scene?.runway_prompt) blobParts.push(scene.runway_prompt);
  const blob = blobParts.join(" ").toLowerCase();

  // v24.3: halved per-category bumps so non-kitchen/bath scenes rarely
  // hit the 80 threshold. Previous values (25/20/30/15/10) sent a
  // bedroom-with-ceiling-fan to 55 (25 base + 30 rotational), and
  // adding parallax motion (+8) tipped many scenes to KB unnecessarily.
  // New values let normal scenes pass; only multi-category-stacking
  // worst-cases (e.g. living + cabinet + appliance + reflective +
  // rotational) hit 80.
  if (RISK_KEYWORDS.high.some((kw) => blob.includes(kw))) score += 12;
  if (RISK_KEYWORDS.appliance.some((kw) => blob.includes(kw))) score += 10;
  if (RISK_KEYWORDS.rotational.some((kw) => blob.includes(kw))) score += 15;
  if (RISK_KEYWORDS.reflective.some((kw) => blob.includes(kw))) score += 8;
  if (RISK_KEYWORDS.text.some((kw) => blob.includes(kw))) score += 5;

  // Camera motion modulation — parallax/lateral_pan add risk because they
  // sweep across more pixels, giving Runway more surface area to invent on.
  const motion = String(scene?.cameraMotion || "").toLowerCase();
  if (motion === "parallax_zoom" || motion === "lateral_pan") score += 4;
  if (motion === "detail_sweep") score += 3;

  // Long clips are riskier — more frames = more chances to drift.
  const duration = Number(scene?.duration || 5);
  if (duration > 5.5) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}
