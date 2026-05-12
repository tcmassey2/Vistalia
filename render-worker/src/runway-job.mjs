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
import { writeRenderAudit } from "./audit-log.mjs";
import { runFFmpeg, timed } from "./ffmpeg-runner.mjs";

const RUNWAY_API_BASE = process.env.RUNWAY_API_BASE || "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = process.env.RUNWAY_API_VERSION || "2024-11-06";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per clip
const DEFAULT_CONCURRENCY = 4;
const MAX_SCENES = 30;
const NON_PHOTO_TYPES = new Set(["intro", "outro", "stat", "card", "title", "stats"]);

export async function renderRunwayJob(body, options = {}) {
  const { manifest, requestedFormat } = body || {};
  validateRunwayManifest(manifest);

  if (!process.env.RUNWAY_API_KEY) {
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

  // Protect high-risk rooms (kitchens + bathrooms) — these are Gen-4
  // Turbo's worst-case for hallucination because of the parallel-edge
  // surfaces (cabinet doors, appliance panels, tile grids). When opted in,
  // route ONLY these room types through Ken Burns and let everything else
  // run through real Runway AI motion. Surgical, doesn't sacrifice the
  // cinematic feel on the 80% of scenes that work fine.
  const protectHighRiskRooms = Boolean(manifest?.protectHighRiskRooms);
  const HIGH_RISK_ROOMS = new Set(["kitchen", "bathroom"]);
  if (protectHighRiskRooms && !complianceMode) {
    const protectedCount = photoScenes.filter((s) => HIGH_RISK_ROOMS.has(s.roomType)).length;
    console.info(`[runway] protectHighRiskRooms=true — ${protectedCount}/${photoScenes.length} scenes (kitchens/bathrooms) will use Ken Burns; the rest use Runway.`);
  }

  let scenesCompleted = 0;
  let fallbackCount = 0;
  // Per-scene failure recovery: when Runway fails on a single scene we
  // generate a Ken-Burns–style fallback clip from the same photo using
  // ffmpeg locally. The render completes with mixed Cinematic AI and
  // Ken-Burns scenes rather than dying with one bad apple. Daily-cap
  // errors still propagate up — those need user action, not a fallback.
  const clipResults = await pMap(
    photoScenes,
    async (scene, index) => {
      let result;
      const useKenBurnsForScene =
        complianceMode ||
        (protectHighRiskRooms && HIGH_RISK_ROOMS.has(scene.roomType));
      if (useKenBurnsForScene) {
        // Skip Runway entirely for this scene — guaranteed shape preservation.
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
      narration = await Promise.race([
        applyVoiceNarration({
          masterMp4: finalMp4,
          scenes: manifest.scenes,
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
    "-preset", "ultrafast",
    "-crf", "22",
    "-r", "30",
    clipPath
  ], { timeoutMs: 90000, label: `runway:fallback-scene-${sceneIndex + 1}` });

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
  // Common base: 4K-ish input scaling so zoompan has resolution headroom.
  const PRE = `scale=${dim.width * 2}:${dim.height * 2}:force_original_aspect_ratio=increase,crop=${dim.width * 2}:${dim.height * 2}`;
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
  // bake in the persistent brand watermark, AND apply a unified cinematic
  // color grade (subtle warm, contrast bump, saturation pull) so every clip
  // has the same look despite Runway's per-clip color variance. The grade
  // is what turns "AI-rendered footage" into "looks like one production
  // grading pass."
  const watermarkFilter = buildWatermarkDrawtext(brand, dimensions);
  const colorGrade = "eq=contrast=1.06:saturation=0.93:gamma=1.04,colorbalance=rs=0.04:bs=-0.02";
  const normalizedClips = [];
  // Per-clip granular progress so the bar visibly moves through this step
  // instead of sitting at 76%. We split the 76→80 range across the clips.
  const NORMALIZE_PROGRESS_START = 76;
  const NORMALIZE_PROGRESS_RANGE = 4;
  for (let i = 0; i < clipResults.length; i++) {
    const clip = clipResults[i];
    const normalized = path.join(tempDir, `norm-${String(clip.sceneIndex).padStart(3, "0")}.mp4`);
    const filterChain = [
      `fps=30`,
      `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${dimensions.width}:${dimensions.height}`,
      colorGrade,
      ...(watermarkFilter ? [watermarkFilter] : [])
    ].join(",");
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", clip.clipPath,
      "-vf", filterChain,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "ultrafast",
      "-crf", "21",
      "-an",
      normalized
    ], { timeoutMs: 90000, label: `runway:normalize-${clip.sceneIndex}` });
    normalizedClips.push({ ...clip, clipPath: normalized });
    options.onProgress?.({
      phase: `Polishing scene ${i + 1}/${clipResults.length}`,
      progress: NORMALIZE_PROGRESS_START + Math.floor(((i + 1) / clipResults.length) * NORMALIZE_PROGRESS_RANGE)
    });
  }

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
  const useCrossfades = Boolean(manifest?.runwayConfig?.useCrossfades);
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

  // Free the stitched intermediate immediately (already concatenated to outputPath).
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

// Build a single ffmpeg filter_complex chain that crossfades through every
// normalized clip in sequence, then crossfades into the optional outro card.
//
// xfade math: each xfade's `offset` is the timestamp (seconds) at which the
// transition begins, measured from the start of the LEFT input. For a chain
// of N clips with durations d0..d(N-1) and crossfade f, the offsets are:
//   xfade_0 (clip0 → clip1): offset = d0 - f
//   xfade_1 (v01 → clip2):   offset = d0 + d1 - 2f
//   xfade_i: offset = sum(d0..di) - (i+1)*f
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

  const f = crossfadeDurationSec;
  const inputs = [];
  allClips.forEach((clip) => { inputs.push("-i", clip.clipPath); });

  // Build the filter_complex graph. For 3 clips:
  //   [0:v][1:v]xfade=fade:duration=0.5:offset=4.5[v01];
  //   [v01][2:v]xfade=fade:duration=0.5:offset=8.5[vout]
  let cumulativeOffset = 0;
  const xfadeSteps = [];
  let lastLabel = "[0:v]";
  for (let i = 1; i < allClips.length; i++) {
    const prevDuration = Number(allClips[i - 1].duration || 5);
    cumulativeOffset += prevDuration - f;
    const isLast = i === allClips.length - 1;
    const outLabel = isLast ? "[vout]" : `[v${String(i).padStart(2, "0")}]`;
    xfadeSteps.push(
      `${lastLabel}[${i}:v]xfade=transition=fade:duration=${f}:offset=${cumulativeOffset.toFixed(3)}${outLabel}`
    );
    lastLabel = outLabel;
  }
  const filterComplex = xfadeSteps.join(";");

  // 8-minute timeout — xfade re-encodes through 24+ inputs sequentially,
  // can take 3-5 min on Render Standard. 8 min gives 60% headroom.
  await runFFmpeg([
    "-y",
    "-threads", "1",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "ultrafast",
    "-crf", "21",
    "-r", "30",
    output
  ], { timeoutMs: 8 * 60 * 1000, label: `runway:xfade-${allClips.length}clips` });
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
    "-preset", "ultrafast",
    "-crf", "21",
    "-r", "30",
    "-t", "5",
    "-an",
    outroPath
  ], { timeoutMs: 60000, label: "runway:outro-card" });

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
