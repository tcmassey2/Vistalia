// EstateMotion — Runway Gen-3 Turbo image-to-video render engine.
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
import { applyTransitionSfx } from "./sfx-mixer.mjs";
import { buildAddressCardClip } from "./address-card.mjs";
import { getBrollSuggestions, prepareBrollClips } from "./broll-library.mjs";
import { getBpmForMusic, beatGridFromBpm, snapScenesToBeats } from "./beat-detect.mjs";
import { validateMasterMp4 } from "./output-validator.mjs";
import { writeRenderAudit } from "./audit-log.mjs";
import { runFFmpeg, timed } from "./ffmpeg-runner.mjs";
import { buildColorGradeFilter, describeColorGrade } from "./color-grade.mjs";
import { preprocessPhotosForRender } from "./photo-preprocess.mjs";

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

   v23 — color grade moved to per-style 3D LUTs. See ./color-grade.mjs.
*/
const ENCODE_PRESET = "superfast";
const ENCODE_CRF_MASTER = "19";
const ENCODE_CRF_DERIVED = "20";
const X264_PARAMS = "rc-lookahead=10:ref=2:bframes=2:keyint=60:scenecut=0";
const BUFSIZE = "2M";

export async function renderRunwayJob(body, options = {}) {
  // `manifest` is `let` (not const) because the photo-preprocess pass below
  // returns a mutated version with normalized photo URLs that downstream
  // code (photoScenes filter, generateClip, generateKenBurnsFallback) needs
  // to see.
  let { manifest, requestedFormat } = body || {};
  validateRunwayManifest(manifest);

  if (!process.env.RUNWAY_API_KEY) {
    throw new Error("RUNWAY_API_KEY is required for Runway rendering. Set it on the render-worker host.");
  }

  const jobId = options.jobId || createJobId(manifest);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "estatemotion-runway-"));

  // v23: photo preprocessing pass (gray-world WB + gentle exposure).
  // Skipped automatically for regenerate-scene calls — those reuse the
  // original render's already-preprocessed photo URLs from Supabase, so
  // re-processing would compound the corrections AND waste 30-60s of
  // download/process/upload. The skip is detected by whether the manifest
  // already carries a photoPreprocess marker from a prior pass.
  const isRegenCall = Boolean(manifest?.photoPreprocess?.processed);
  if (!isRegenCall) {
    options.onProgress?.({ phase: "Normalizing photos", progress: 4, scenesTotal: 0 });
    const preprocessResult = await preprocessPhotosForRender({ manifest, jobId });
    manifest = preprocessResult.manifest;
  }

  // v23: beat-aware Viral pacing. Snaps photo scene durations to a beat
  // grid derived from the music's BPM. Only fires for selectedStyle="viral"
  // — Luxury/MLS/Investor stay smooth.
  try {
    const styleSlug = String(manifest?.selectedStyle || manifest?.template?.style || "").toLowerCase();
    if (styleSlug === "viral") {
      const musicSlot = String(manifest?.musicMood || manifest?.selectedStyle || "").toLowerCase();
      const bpm = getBpmForMusic({
        musicUrl: manifest?.music?.url,
        musicSlot,
        manifest
      });
      // Estimate total duration from current scene durations
      const estimatedTotal = (manifest.scenes || []).reduce((acc, s) => acc + (Number(s.duration) || 3), 0) + 8;
      const beats = beatGridFromBpm(bpm, estimatedTotal);
      manifest.scenes = snapScenesToBeats({
        scenes: manifest.scenes,
        beats,
        styleSlug: "viral",
        beatsPerScene: 2 // 2 beats per scene at 122 BPM ≈ 0.98s/scene — punchy
      });
      console.info(`[runway] beat-aware Viral pacing applied (bpm=${bpm}, beatsPerScene=2)`);
    }
  } catch (err) {
    console.warn(`[runway] beat-snap failed (${err.message}). Using original scene durations.`);
  }

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
      // v23: per-scene engine + reason tracking. Stamped onto the result
      // object so uploadPerSceneClips can persist it to the audit log.
      let engineUsed = "cinematic_ai";
      let fallbackReason = null;
      const sceneStartedAt = Date.now();

      // The Hallucination Guard decision is logged with reasoning so we can
      // tune thresholds based on real-world data. Every Ken-Burns-by-design
      // scene gets a line in the logs explaining WHY.
      const guardDecision = decideUseKenBurns(scene, guardLevel);
      const useKenBurnsForScene = complianceMode || guardDecision.useKenBurns;
      if (useKenBurnsForScene) {
        if (!complianceMode && guardDecision.useKenBurns) {
          guardForcedCount++;
          console.info(
            `[runway] guard:${guardLevel} scene ${index + 1} (${scene.roomType || "unknown"}) ` +
            `→ Ken Burns. risk=${guardDecision.risk}/100, reason="${guardDecision.reason}"`
          );
          engineUsed = "ken_burns";
          fallbackReason = `hallucination_guard:${guardDecision.reason}`;
        } else if (complianceMode) {
          engineUsed = "ken_burns";
          fallbackReason = "compliance_mode";
        }
        // Skip Runway entirely for this scene — guaranteed shape preservation.
        result = await generateKenBurnsFallback(scene, manifest, tempDir, index);
      } else {
        try {
          result = await generateClip(scene, manifest, tempDir, index);
          engineUsed = "cinematic_ai";
        } catch (error) {
          if (error.code === "RUNWAY_DAILY_CAP") throw error; // surface to user
          console.warn(`[runway] scene ${index + 1} failed (${error.message}). Falling back to Ken Burns.`);
          result = await generateKenBurnsFallback(scene, manifest, tempDir, index);
          fallbackCount++;
          engineUsed = "ken_burns";
          fallbackReason = `runway_error:${(error.message || "unknown").slice(0, 120)}`;
        }
      }
      // Stamp the per-scene metadata onto the result so the audit-log path
      // can persist it. uploadPerSceneClips reads these fields.
      result.engineUsed = engineUsed;
      result.fallbackReason = fallbackReason;
      result.guardRisk = guardDecision.risk ?? null;
      result.guardLevel = guardLevel;
      result.durationMs = Date.now() - sceneStartedAt;
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

  // v23: stitchClipsAndOverlays now returns addressCardIncluded so the
  // downstream voice/SFX/validation steps know whether to apply a 3.5s
  // pre-roll offset. The address card may be skipped if the hero image
  // fails to download or manifest.disableAddressCard is set.
  const { normalizedClips, addressCardIncluded } = await stitchClipsAndOverlays(clipResults, manifest, finalMp4, thumbnailPath, options);

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
      narration = await Promise.race([
        applyVoiceNarration({
          masterMp4: finalMp4,
          scenes: manifest.scenes,
          brandKit: manifest.brandKit || {},
          manifest,
          tempDir,
          jobId,
          // v23: 3.5s pre-roll shift if address card was prepended.
          preRollSeconds: addressCardIncluded ? 3.5 : 0,
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
  const postNarrationMaster = narration.narrationApplied ? narration.masterMp4 : finalMp4;

  // v23: transition SFX layered on top of (music + narration) at -18dB.
  // Fail-soft: if SFX mixing fails, use the post-narration master untouched.
  options.onProgress?.({ phase: "Adding transition SFX", progress: 84 });
  let sfxResult = { masterMp4: postNarrationMaster, applied: false };
  try {
    sfxResult = await applyTransitionSfx({
      masterMp4: postNarrationMaster,
      scenes: manifest.scenes,
      tempDir,
      jobId,
      manifest,
      preRollSeconds: addressCardIncluded ? 3.5 : 0
    });
    if (sfxResult.applied) {
      console.info(`[runway] transition SFX applied (${sfxResult.sfxCount} cues)`);
    }
  } catch (err) {
    console.warn(`[runway] SFX step failed (${err.message}). Continuing without SFX.`);
    sfxResult = { masterMp4: postNarrationMaster, applied: false, reason: err.message };
  }
  const masterForVariants = sfxResult.masterMp4;

  options.onProgress?.({ phase: "Deriving aspect variants", progress: 86 });
  const wants4K = Boolean(
    manifest?.runwayConfig?.is4K ||
    manifest?.runwayConfig?.upscale4K ||
    manifest?.export4K ||
    String(manifest?.exportFormat || "").toLowerCase().includes("4k")
  );
  let variants = {};
  try {
    variants = await deriveAspectVariants({
      masterMp4: masterForVariants,
      tempDir,
      jobId,
      upscale4K: wants4K
    });
  } catch (err) {
    console.warn(`[runway] aspect variants failed entirely (${err.message}). Falling back to vertical-only.`);
    variants = { vertical: { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } } };
  }
  if (!variants.vertical?.path) {
    variants.vertical = { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } };
  }

  options.onProgress?.({ phase: "Cutting social shorts", progress: 90 });
  let shorts = [];
  try {
    shorts = await buildSocialShorts({
      // Use the narrated master (if any) so social shorts also have voice.
      masterMp4: masterForVariants,
      scenes: manifest.scenes,
      tempDir,
      jobId,
      count: 3
    });
  } catch (err) {
    console.warn(`[runway] social shorts failed entirely (${err.message}). Continuing without shorts.`);
    shorts = [];
  }

  // v23: validation gate — ffprobe the master before upload. Catches
  // "rendered successfully but file is corrupt" failures so we never
  // ship a broken video to the user. Throws on hard fail with code
  // OUTPUT_VALIDATION_FAILED, which the caller surfaces as a job failure.
  options.onProgress?.({ phase: "Validating final video", progress: 92 });
  try {
    const expectedSec = (() => {
      const sceneSec = (manifest.scenes || [])
        .filter((s) => String(s.type || "photo").toLowerCase() === "photo")
        .reduce((acc, s) => acc + Number(s.duration || 5), 0);
      const cardSec = addressCardIncluded ? 3.5 : 0;
      const outroSec = 5; // composited outro card duration (see buildBrandOutroClip)
      return sceneSec + cardSec + outroSec;
    })();
    await validateMasterMp4({
      filePath: variants.vertical?.path || finalMp4,
      expectedDurationSec: expectedSec,
      expectedDimensions: dimensions,
      label: "runway"
    });
  } catch (err) {
    if (err.code === "OUTPUT_VALIDATION_FAILED") {
      // Mark this as a structured job failure so the API can return a
      // distinct status to the client.
      err.jobPhase = "validation";
      throw err;
    }
    throw err;
  }

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
    engine: "runway",
    upload,
    narration,
    scenes: scenesMeta
  }).catch(() => {});

  // Render-complete email — fire-and-forget POST to the Vercel notify
  // endpoint. Worker doesn't hold Resend keys; Vercel does. Same secret
  // guards both directions.
  notifyRenderComplete({
    userId: manifest?.project?.userId || "",
    jobId,
    mp4Url: upload?.formats?.vertical?.mp4Url || "",
    thumbnailUrl: upload?.thumbnailUrl || "",
    listingTitle: manifest?.project?.address || manifest?.project?.title || ""
  }).catch((err) => {
    console.warn("[runway] notify-render-complete failed:", err.message || err);
  });

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
    }))
  };
}

/* =================================================================
   Per-scene Runway generation
   ================================================================= */

/* ----------------------------------------------------------------
   Per-tier Runway model resolver (v23 follow-up)
   ----------------------------------------------------------------
   Cinematic AI 4K customers pay $299/mo and get Runway's premium model
   (Gen-4.5) by default. Everyone else uses Gen-4 Turbo. The resolution
   order is:
     1. manifest.runwayConfig.model      (explicit per-render override)
     2. process.env.RUNWAY_MODEL          (env-level override — for testing)
     3. tier-based default (4k → gen4_5, all others → gen4_turbo)

   Why gate Gen-4.5 behind the 4K tier:
   - Gen-4.5 costs ~2.5x more per credit than Gen-4 Turbo
   - On the $149 Cinematic AI tier, default Gen-4.5 would push Runway
     spend to ~$190/mo per active customer — negative gross margin
   - The $299 4K tier absorbs that cost and still leaves room
   - Below $299: opt-out of premium AI, accept Gen-4 Turbo (still
     industry-best quality for the price)

   Override knob: set process.env.RUNWAY_PREMIUM_MODEL to swap out the
   premium model name (e.g. when Gen-5 launches). Defaults to "gen4_5".
*/
function resolveRunwayModel(manifest) {
  const config = manifest?.runwayConfig || {};
  if (config.model) return config.model;
  if (process.env.RUNWAY_MODEL) return process.env.RUNWAY_MODEL;
  const tier = String(manifest?.userTier || "").toLowerCase().trim();
  if (tier === "cinematic_4k") {
    return process.env.RUNWAY_PREMIUM_MODEL || "gen4_5";
  }
  return "gen4_turbo";
}

// Detect Runway error responses that mean "this model isn't available
// for this account" — usually a 400 or 403 mentioning "model" or "access".
// When that happens on Gen-4.5 we silently fall back to Gen-4 Turbo so
// the render still completes (worst case: customer gets a Turbo render
// they thought would be 4.5; we log it for billing reconciliation).
function isModelUnavailableError(httpStatus, errBody) {
  if (httpStatus !== 400 && httpStatus !== 403 && httpStatus !== 404) return false;
  const lower = String(errBody || "").toLowerCase();
  return /model|access|not.*available|unsupported|invalid.*model/.test(lower);
}

export async function generateClip(scene, manifest, tempDir, sceneIndex) {
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) throw new Error(`Scene ${sceneIndex + 1} (${scene.photoId}) missing durable image URL.`);
  const prompt = scene.runwayPrompt || scene.runway_prompt;
  if (!prompt) throw new Error(`Scene ${sceneIndex + 1} missing runwayPrompt. Regenerate edit plan with engine=runway.`);

  const config = manifest.runwayConfig || {};
  // v23.1: per-tier model resolution. cinematic_4k → gen4_5, else gen4_turbo.
  // Falls back to gen4_turbo automatically if gen4_5 is unavailable on this
  // Runway account (so a misconfigured account doesn't black-hole renders).
  const requestedModel = resolveRunwayModel(manifest);
  const fallbackModel = "gen4_turbo";
  const ratio = ratioForRunway(config.ratio, requestedModel);
  const duration = clamp(Number(scene.duration || 5) > 5.5 ? 10 : 5, 5, 10);

  // Submit task — with 429 / 5xx resilience.
  // Runway's task-submit endpoint hits us with three failure modes worth
  // distinguishing:
  //   1. 429 "rate limit" — short-window throttle. Backoff + retry.
  //   2. 429 "daily task limit reached" — terminal until tomorrow or
  //      until the user upgrades. No point retrying. Surface a clear
  //      error so the frontend can prompt for an upgrade.
  //   3. 5xx — transient Runway side. Retry with backoff.
  let modelUsed = requestedModel;
  let submitResponse = await submitRunwayTaskWithRetry({
    body: {
      model: requestedModel,
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

  // Fallback path: requested premium model but it's not available on this
  // account. Re-submit with Gen-4 Turbo so the render completes.
  if (!submitResponse.ok && requestedModel !== fallbackModel) {
    const errBody = await safeText(submitResponse);
    if (isModelUnavailableError(submitResponse.status, errBody)) {
      console.warn(
        `[runway] scene ${sceneIndex + 1}: ${requestedModel} not available ` +
        `(HTTP ${submitResponse.status}). Falling back to ${fallbackModel}.`
      );
      modelUsed = fallbackModel;
      submitResponse = await submitRunwayTaskWithRetry({
        body: {
          model: fallbackModel,
          promptImage: imageUrl,
          promptText: prompt,
          ratio: ratioForRunway(config.ratio, fallbackModel),
          duration,
          watermark: false,
          ...(config.seed != null ? { seed: Number(config.seed) } : {})
        },
        sceneIndex,
        maxAttempts: 5
      });
    }
  }

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
    runwayTaskId: taskId,
    // v23.1: track which model actually ran (may differ from requested if
    // the premium model fell back to Turbo). Surfaced via per-scene audit
    // for cost reconciliation + UI badge ("Generated with Gen-4.5 Premium").
    modelRequested: requestedModel,
    modelUsed
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
  // ffmpeg zoompan: zoom from 1.0 to 1.12 over the duration, with x/y
  // offsets to drift the framing. Output size matches target dimensions
  // exactly to slot into the same concat chain as Runway clips.
  // The s= argument MUST equal the final scene dimensions or concat fails.
  const s = `${dim.width}x${dim.height}`;
  const fps = 30;
  // v21 memory fix: pre-scale at 1.3× output instead of 2×. The previous
  // 2× pre-scale held a 2160×3840×4 ≈ 33 MB frame buffer in zoompan's
  // internal state, which OOM'd the Ken Burns fallback on Render Standard
  // 2GB the moment Runway dropped a scene and we re-encoded the photo.
  // Max zoompan zoom is 1.12× (see expressions below), so 1.3× headroom
  // is plenty for crisp motion. Per-frame buffer drops to ~14 MB.
  const PRE_W = Math.round(dim.width * 1.3);
  const PRE_H = Math.round(dim.height * 1.3);
  const PRE = `scale=${PRE_W}:${PRE_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${PRE_W}:${PRE_H}`;
  if (motion === "pull_out") {
    // Start zoomed in, pull back to neutral.
    return `${PRE},zoompan=z='1.12-0.0008*on':d=${totalFrames}:s=${s}:fps=${fps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  }
  if (motion === "lateral_pan") {
    return `${PRE},zoompan=z='1.08':d=${totalFrames}:s=${s}:fps=${fps}:x='if(gte(on,1),x+1.5,iw/2-(iw/zoom/2))':y='ih/2-(ih/zoom/2)'`;
  }
  if (motion === "vertical_reveal") {
    return `${PRE},zoompan=z='1.08':d=${totalFrames}:s=${s}:fps=${fps}:x='iw/2-(iw/zoom/2)':y='if(gte(on,1),y-1.2,ih*0.6)'`;
  }
  if (motion === "parallax_zoom") {
    return `${PRE},zoompan=z='1.02+0.0007*on':d=${totalFrames}:s=${s}:fps=${fps}:x='iw/2-(iw/zoom/2)+sin(on/30)*8':y='ih/2-(ih/zoom/2)'`;
  }
  if (motion === "detail_sweep") {
    return `${PRE},zoompan=z='1.12-0.0004*on':d=${totalFrames}:s=${s}:fps=${fps}:x='if(gte(on,1),x+2,0)':y='ih/2-(ih/zoom/2)'`;
  }
  // Default: gentle push-in
  return `${PRE},zoompan=z='1.0+0.0008*on':d=${totalFrames}:s=${s}:fps=${fps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
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
  // v23: per-style 3D LUTs (Kodak 2383 / teal-orange / Rec.709 / desat film).
  // Falls back to the legacy math grade if the style's .cube is missing.
  const colorGrade = buildColorGradeFilter(manifest, { verboseLog: true });
  console.info(`[runway] color grade: ${describeColorGrade(manifest)}`);
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

    // BUG FIX (regen double-bake): when the regenerate-scene flow downloads
    // the 23 already-normalized scene clips from Supabase Storage, those
    // clips ALREADY have the color grade + watermark + corner headshot baked
    // in from the original render. Re-running the normalize chain on them
    // would stack a second corner headshot on top of the first, re-grade an
    // already-graded image, and add a second watermark. We pass-through
    // copy them instead — same wall-clock as a few hundred ms vs ~5 seconds
    // of re-encode per clip, AND preserves the original visual.
    if (clip.preNormalized) {
      await runFFmpeg(
        ["-y", "-threads", "1", "-i", clip.clipPath, "-c", "copy", normalized],
        { timeoutMs: 30000, label: `runway:normalize-${clip.sceneIndex}-passthrough` }
      );
      normalizedClips.push({ ...clip, clipPath: normalized });
      options.onProgress?.({
        phase: `Polishing scene ${i + 1}/${clipResults.length}`,
        progress: NORMALIZE_PROGRESS_START + Math.floor(((i + 1) / clipResults.length) * NORMALIZE_PROGRESS_RANGE)
      });
      continue;
    }

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

  // v23: address opener card. Generated as a normalized clip and prepended
  // to the array before stitch. Uses the first photo as the slow-zoomed
  // backdrop with animated address + price + stats overlays. Skipped if
  // manifest.disableAddressCard is true, or if hero image fails to download.
  let addressCardPath = null;
  try {
    const heroScene = clipResults.find((c) => c.photoId);
    const heroSceneObj = heroScene ? manifest.scenes.find((s) => s.photoId === heroScene.photoId) : null;
    const heroPhoto = heroScene ? (manifest.orderedPhotos || []).find((p) => p.id === heroScene.photoId) : null;
    const heroUrl = heroSceneObj && heroPhoto ? pickImageUrl(heroSceneObj, heroPhoto) : null;
    if (heroUrl) {
      // Download hero locally — drawtext + zoompan need a local file path
      // for reliable rendering across ffmpeg builds.
      const heroLocalPath = path.join(tempDir, "address-card-hero.jpg");
      await downloadFile(heroUrl, heroLocalPath);
      const accentColor =
        manifest?.template?.accentColor ||
        manifest?.brandKit?.accentColor ||
        "#C7A76C";
      addressCardPath = await buildAddressCardClip({
        project: manifest.project || {},
        brandKit: manifest.brandKit || {},
        manifest,
        dimensions,
        heroImage: heroLocalPath,
        tempDir,
        accentColor,
        encodeOptions: {
          preset: ENCODE_PRESET,
          crf: ENCODE_CRF_MASTER,
          x264Params: X264_PARAMS,
          bufsize: BUFSIZE
        }
      });
      // Cleanup hero copy after use
      await fs.unlink(heroLocalPath).catch(() => {});
    }
  } catch (err) {
    console.warn(`[runway] address card generation failed (${err.message}). Continuing without it.`);
    addressCardPath = null;
  }

  // v23: B-roll lifestyle cutaways from Pexels.
  // Inject 1-3 normalized B-roll clips evenly through the timeline.
  // Skipped if PEXELS_API_KEY missing or manifest.disableBroll set.
  // Failures fall back gracefully to the photo-only stitch.
  let brollPrepared = [];
  try {
    if (manifest?.creative?.injectBroll !== false) {
      const brollCount = Math.min(3, Math.max(1, Math.floor(normalizedClips.length / 8)));
      if (brollCount > 0) {
        options.onProgress?.({ phase: "Fetching B-roll cutaways", progress: 80 });
        const suggestions = await getBrollSuggestions({ manifest, count: brollCount });
        if (suggestions.length > 0) {
          brollPrepared = await prepareBrollClips({
            brollSuggestions: suggestions,
            dimensions,
            tempDir,
            encodeOptions: {
              preset: ENCODE_PRESET,
              crf: ENCODE_CRF_MASTER,
              x264Params: X264_PARAMS,
              bufsize: BUFSIZE
            },
            durationSec: 4.0,
            runFFmpeg
          });
          if (brollPrepared.length > 0) {
            console.info(`[runway] B-roll prepared: ${brollPrepared.length} clips`);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[runway] B-roll injection failed (${err.message}). Continuing without B-roll.`);
    brollPrepared = [];
  }

  // If we got an address card, prepend it to the normalized clips so the
  // stitch step concatenates: [address-card, scene-1, scene-2, ..., scene-N].
  // Outro is added by the stitch functions themselves.
  let stitchClips = addressCardPath
    ? [{ clipPath: addressCardPath, sceneIndex: -1, duration: 3.5, transition: "fade", isAddressCard: true }, ...normalizedClips]
    : [...normalizedClips];

  // v23: splice B-roll into stitchClips at evenly distributed indices.
  // E.g. 3 B-roll into 24 photos → insert at positions 6, 12, 18.
  if (brollPrepared.length > 0) {
    const photoStart = addressCardPath ? 1 : 0;
    const photoCount = stitchClips.length - photoStart;
    const augmented = [];
    let brollIdx = 0;
    for (let i = 0; i < stitchClips.length; i++) {
      augmented.push(stitchClips[i]);
      // After every floor(photoCount / (brollPrepared.length+1))-th photo, insert one B-roll
      const offset = i - photoStart + 1;
      const interval = Math.floor(photoCount / (brollPrepared.length + 1));
      if (
        i >= photoStart &&
        brollIdx < brollPrepared.length &&
        interval > 0 &&
        offset % interval === 0 &&
        offset < photoCount
      ) {
        const bclip = brollPrepared[brollIdx];
        augmented.push({
          clipPath: bclip.clipPath,
          sceneIndex: -2 - brollIdx,
          duration: bclip.durationSec,
          transition: "fade",
          isBroll: true,
          brollCategory: bclip.suggestion?.categorySlug,
          brollAttribution: bclip.suggestion?.attribution
        });
        brollIdx++;
      }
    }
    stitchClips = augmented;
  }

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

  // v23 false-stuck fix: stitchWithSimpleConcat / stitchWithCrossfades don't
  // emit any progress during their work — they're a single ffmpeg call that
  // takes 60-180s on a 24-clip render. The frontend's 90s heartbeat detector
  // fired "appears stuck" warnings on every render that legitimately ran past
  // 90s in stitch. Solve it by emitting a heartbeat ping every 25s that
  // creeps progress from 81→84% while the stitch ffmpeg call is running.
  // The ceiling stops short of 86% so the real "Aspect variants" phase has
  // somewhere to advance to. Always cleared in the finally block.
  let stitchProgress = 81;
  const stitchHeartbeat = setInterval(() => {
    if (stitchProgress < 84) {
      stitchProgress += 0.4;
      options.onProgress?.({
        phase: "Stitching final video",
        progress: Math.min(84, stitchProgress)
      });
    }
  }, 25000);

  try {
    const useCrossfades = Boolean(manifest?.runwayConfig?.useCrossfades);
    if (useCrossfades) {
      try {
        await stitchWithCrossfades({
          clips: stitchClips,
          outroClip,
          output: stitched,
          crossfadeDurationSec: 0.5
        });
      } catch (err) {
        console.warn(`[runway] xfade stitch failed (${err.message}). Falling back to simple concat.`);
        await stitchWithSimpleConcat({
          clips: stitchClips,
          outroClip,
          output: stitched,
          tempDir
        });
      }
    } else {
      await stitchWithSimpleConcat({
        clips: stitchClips,
        outroClip,
        output: stitched,
        tempDir
      });
    }
  } finally {
    clearInterval(stitchHeartbeat);
  }

  // v20: corner headshot is baked into each clip during normalize above —
  // no separate post-stitch ffmpeg pass needed. The v19 approach OOM'd
  // Render Standard 2GB. Per-clip overlay distributes the work and never
  // accumulates more than one ffmpeg process worth of memory at a time.

  // Step 4: optional audio mix from manifest.musicMood mapping. We honor a
  // RUNWAY_MUSIC_<MOOD>_URL env var pointing to a remote MP3. If no music
  // configured, the final video has no audio (acceptable for v1).
  const musicUrl = pickMusicUrl(manifest);
  if (musicUrl) {
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", stitched,
      "-i", musicUrl,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-map", "0:v:0",
      "-map", "1:a:0",
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
  // v23: addressCardIncluded tells the caller whether the 3.5s opener
  // actually made it into the stitch. The caller uses this to decide
  // whether to apply a 3.5s pre-roll offset on voice/SFX/validation.
  // It's truthy only if the card was generated AND prepended to stitchClips.
  return { normalizedClips, addressCardIncluded: Boolean(addressCardPath) };
}

// Crossfade-stitch all normalized clips together.
//
// v22 — BATCHED to keep memory bounded. xfade with all clips in one
// filter_complex opens N codec contexts simultaneously, peaking ~150-200
// MB per input. At 24+ inputs that's 4 GB+ of decoder state alone, which
// OOM-killed the 4 GB Render instance.
//
// Strategy: chunk the clips into batches of XFADE_BATCH_SIZE, run xfade
// per batch (single filter_complex), then simple-concat the batch outputs.
// Memory peak per batch = XFADE_BATCH_SIZE codec contexts ≈ 600-800 MB.
// Hard cuts only occur at batch boundaries — for a 24-clip render at
// batch=4 that's 5 hard cuts and 18 crossfades, visually fine.
async function stitchWithCrossfades({ clips, outroClip, output, crossfadeDurationSec = 0.5 }) {
  const allClips = outroClip
    ? [...clips, { clipPath: outroClip, duration: 5, sceneIndex: 9999 }]
    : [...clips];
  if (allClips.length === 0) throw new Error("stitchWithCrossfades called with no clips.");
  if (allClips.length === 1) {
    // Single clip — just copy it through.
    await runFFmpeg(
      ["-y", "-threads", "1", "-i", allClips[0].clipPath, "-c", "copy", output],
      { timeoutMs: 30000, label: "runway:single-clip-copy" }
    );
    return;
  }

  // Batch threshold — at or below this many clips, do a single xfade pass
  // (no boundary cuts). Above it, chunk.
  const XFADE_BATCH_SIZE = 4;
  if (allClips.length <= XFADE_BATCH_SIZE + 2) {
    await xfadeSingleBatch(allClips, output, crossfadeDurationSec);
    return;
  }

  // Chunked path. Build batches, xfade each into a temp file, then
  // simple-concat the temp files into the final output.
  const tempDir = path.dirname(output);
  const batches = [];
  for (let i = 0; i < allClips.length; i += XFADE_BATCH_SIZE) {
    batches.push(allClips.slice(i, i + XFADE_BATCH_SIZE));
  }
  console.info(
    `[runway:xfade] batched ${allClips.length} clips into ${batches.length} groups of ≤${XFADE_BATCH_SIZE} ` +
    `(memory-safe: ~600-800 MB per batch instead of ~${Math.round(allClips.length * 175)} MB single-pass)`
  );

  const batchOutputs = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchOut = path.join(tempDir, `xfade-batch-${String(bi).padStart(2, "0")}.mp4`);
    if (batch.length === 1) {
      // Trailing single clip — just copy it; nothing to xfade against.
      await runFFmpeg(
        ["-y", "-threads", "1", "-i", batch[0].clipPath, "-c", "copy", batchOut],
        { timeoutMs: 30000, label: `runway:xfade-batch-${bi}-passthrough` }
      );
    } else {
      await xfadeSingleBatch(batch, batchOut, crossfadeDurationSec);
    }
    batchOutputs.push(batchOut);
  }

  // Concat the batch outputs. Use the demuxer (-f concat -c copy) — no
  // re-encode, so this is a 1-2 second metadata pass.
  const concatList = path.join(tempDir, "xfade-batch-concat.txt");
  await fs.writeFile(
    concatList,
    batchOutputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c", "copy",
    output
  ], { timeoutMs: 60000, label: "runway:xfade-batch-concat" });

  // Cleanup
  await fs.unlink(concatList).catch(() => {});
  for (const p of batchOutputs) await fs.unlink(p).catch(() => {});
}

// Single-pass xfade for a small group of clips. Used directly for short
// renders and as the inner step of the batched path.
async function xfadeSingleBatch(clipsInBatch, output, crossfadeDurationSec) {
  if (clipsInBatch.length === 1) {
    await runFFmpeg(
      ["-y", "-threads", "1", "-i", clipsInBatch[0].clipPath, "-c", "copy", output],
      { timeoutMs: 30000, label: "runway:xfade-single" }
    );
    return;
  }
  const f = crossfadeDurationSec;
  const inputs = [];
  clipsInBatch.forEach((clip) => { inputs.push("-i", clip.clipPath); });

  // Build the xfade chain for this batch. Same offset math as before:
  //   xfade_i offset = sum(d0..di) - (i+1)*f
  let cumulativeOffset = 0;
  const xfadeSteps = [];
  let lastLabel = "[0:v]";
  for (let i = 1; i < clipsInBatch.length; i++) {
    const prevDuration = Number(clipsInBatch[i - 1].duration || 5);
    cumulativeOffset += prevDuration - f;
    const isLast = i === clipsInBatch.length - 1;
    const outLabel = isLast ? "[vout]" : `[v${String(i).padStart(2, "0")}]`;
    xfadeSteps.push(
      `${lastLabel}[${i}:v]xfade=transition=fade:duration=${f}:offset=${cumulativeOffset.toFixed(3)}${outLabel}`
    );
    lastLabel = outLabel;
  }
  const filterComplex = xfadeSteps.join(";");

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
    output
  ], { timeoutMs: 4 * 60 * 1000, label: `runway:xfade-batch-${clipsInBatch.length}clips` });
}

// Reliability fallback for stitchWithCrossfades. Uses ffmpeg's concat
// demuxer with -c copy — no re-encode, no filter_complex, no boundary
// math. Visually less polished (hard cuts) but bulletproof.
async function stitchWithSimpleConcat({ clips, outroClip, output, tempDir }) {
  const allClips = outroClip
    ? [...clips, { clipPath: outroClip }]
    : clips;
  if (allClips.length === 0) throw new Error("stitchWithSimpleConcat called with no clips.");
  const concatList = path.join(tempDir, "concat-fallback.txt");
  await fs.writeFile(
    concatList,
    allClips.map((c) => `file '${c.clipPath.replace(/'/g, "'\\''")}'`).join("\n")
  );
  // Simple concat is just a demuxer pass — no re-encode, very fast.
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c", "copy",
    output
  ], { timeoutMs: 60000, label: "runway:simple-concat" });
  await fs.unlink(concatList).catch(() => {});
}

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
//   5. Equal Housing footer + EstateMotion attribution
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
  // Equal Housing + EstateMotion attribution footer (MLS compliance)
  const footerText = ffEscape("Equal Housing Opportunity  ·  Made with EstateMotion");
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
      wasFallback: Boolean(original.fallback),
      // v23: per-scene engine + reason tracking. Surfaced in the UI as
      // "X of Y scenes used cinematic AI" + per-scene drill-down. Also
      // powers offline Hallucination Guard tuning.
      engineUsed: original.engineUsed || (original.fallback ? "ken_burns" : "cinematic_ai"),
      fallbackReason: original.fallbackReason || null,
      guardRisk: original.guardRisk ?? null,
      guardLevel: original.guardLevel || null,
      runwayTaskId: original.runwayTaskId || null,
      durationMs: original.durationMs ?? null,
      // v23.1: which Runway model actually ran this scene. Tracks Gen-4.5
      // premium tier usage + auto-fallback events. Cost-reconciliation +
      // "Generated with Gen-4.5 Premium" UI badge will read from here.
      modelRequested: original.modelRequested || null,
      modelUsed: original.modelUsed || null
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
      throw new Error(`Runway scene ${scene.photoId} has browser-only URL (blob:/data:). Re-upload first.`);
    }
    if (!scene.runwayPrompt) throw new Error(`Runway scene ${scene.photoId} missing runwayPrompt — regenerate edit plan with engine=runway.`);
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
  const mood = String(manifest.musicMood || manifest.selectedStyle || "").toLowerCase();

  // Determine which style "slot" this mood belongs to.
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

  // Resolve absolute paths for the bundled music directory.
  const musicDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "music");
  const candidate = (name) => [
    path.join(musicDir, `${name}.mp3`),
    path.join(musicDir, `${name}.m4a`)
  ];

  // 1. Slot-specific local file (luxury/social/mls/investor).
  for (const localPath of candidate(slot)) {
    if (existsSync(localPath)) return localPath;
  }

  // 2. Fall through to a generic default.mp3 if the slot file isn't bundled
  //    yet. Means every render gets music as long as ANY local track exists,
  //    even if the agent only uploaded one of the four style tracks.
  for (const localPath of candidate("default")) {
    if (existsSync(localPath)) return localPath;
  }

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

// POST to the Vercel /api/notify-render-complete endpoint to fire the
// "your video is ready" email. Worker → Vercel → Resend. Worker doesn't
// hold Resend keys; Vercel does. Auth uses the same shared secret as the
// render webhook. Configure NOTIFY_BASE_URL on the worker to point at
// the Vercel domain (e.g. https://estatemotion.ai).
async function notifyRenderComplete({ userId, jobId, mp4Url, thumbnailUrl, listingTitle }) {
  const baseUrl = process.env.NOTIFY_BASE_URL || process.env.APP_URL || "";
  if (!baseUrl || !userId || !jobId || !mp4Url) return;
  const secret = process.env.RENDER_WEBHOOK_SECRET || process.env.RENDER_WORKER_SECRET || "";
  const url = `${baseUrl.replace(/\/$/, "")}/api/notify-render-complete`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {})
      },
      body: JSON.stringify({ userId, jobId, mp4Url, thumbnailUrl, listingTitle }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
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

  // STRICT: lock all kitchens regardless of features. Aggressive lower threshold.
  if (guardLevel === "strict") {
    if (room === "kitchen") {
      return { useKenBurns: true, risk, reason: "strict: all kitchens locked" };
    }
    if (risk >= 35) {
      return { useKenBurns: true, risk, reason: `strict: risk≥35 (${risk})` };
    }
  }

  // BALANCED (default): kitchens + bathrooms with any appliance/parallel
  // features → KB. Other rooms only flip to KB when risk crosses 60.
  if (room === "kitchen" || room === "bathroom") {
    // Kitchen base risk is 80, bathroom 60. A kitchen with ANY appliance keyword
    // (+15 each) easily crosses the 60 line. Bathroom with a tile feature
    // (+15) does too. So this effectively locks both with rare exception
    // (e.g. a "kitchen detail" shot with no risky features).
    if (risk >= 60) {
      return { useKenBurns: true, risk, reason: `${room} risk≥60 (${risk})` };
    }
  }
  if (risk >= 60) {
    return { useKenBurns: true, risk, reason: `risk≥60 (${risk}, ${room || "unknown"})` };
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

  // Each category contributes once (saturating) so a feature list packed
  // with "cabinets, counter, granite" doesn't quadruple-count the same
  // parallel-edge failure profile.
  if (RISK_KEYWORDS.high.some((kw) => blob.includes(kw))) score += 25;
  if (RISK_KEYWORDS.appliance.some((kw) => blob.includes(kw))) score += 20;
  if (RISK_KEYWORDS.rotational.some((kw) => blob.includes(kw))) score += 30;
  if (RISK_KEYWORDS.reflective.some((kw) => blob.includes(kw))) score += 15;
  if (RISK_KEYWORDS.text.some((kw) => blob.includes(kw))) score += 10;

  // Camera motion modulation — parallax/lateral_pan add risk because they
  // sweep across more pixels, giving Runway more surface area to invent on.
  const motion = String(scene?.cameraMotion || "").toLowerCase();
  if (motion === "parallax_zoom" || motion === "lateral_pan") score += 8;
  if (motion === "detail_sweep") score += 5;

  // Long clips are riskier — more frames = more chances to drift.
  const duration = Number(scene?.duration || 5);
  if (duration > 5.5) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}
