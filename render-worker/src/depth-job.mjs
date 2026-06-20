// Vistalia — Depth-based engine orchestrator (Path B).
//
// Full peer of renderRunwayJob. Same input contract (manifest, options),
// same output shape (videoUrl + variants + shorts + thumbnail + per-scene
// metadata + audit log). server.mjs routes engine='depth' here.
//
// PER-SCENE PIPELINE (the new bit):
//   1. Download photo to local temp.
//   2. Replicate depth-anything-v2 → depth map → download.
//   3. depth-renderer.mjs → per-scene MP4 (vertex-displaced parallax).
//   4. (Phase 2) Disocclusion mask → LaMa inpaint per frame → restitch.
//
// POST-PROCESSING (reused from runway-job.mjs):
//   stitchClipsAndOverlays  — normalize, watermark, headshot, crossfade,
//                             outro card, thumbnail.
//   applyVoiceNarration     — ElevenLabs + duck music under voice.
//   deriveAspectVariants    — 9:16, 16:9, 1:1 variants from master.
//   buildSocialShorts       — three highlight clips for social.
//   uploadDeliverables      — Supabase storage upload.
//   uploadPerSceneClips     — per-scene clip upload for regenerate support.
//   writeRenderAudit        — fire-and-forget audit row.
//
// SAFETY GATE:
//   ENABLE_DEPTH_ENGINE=true env var on the worker. Without it, any
//   engine='depth' request errors out cleanly. Flip after smoke:gl and
//   smoke:depth both pass on the worker.
//
// PHASE TRACKING:
//   Phase 1 (this version): depth + render + stitch + voice + music
//                           + variants + upload. No inpainting yet.
//                           Disocclusion gaps will look stretched at
//                           strong depth discontinuities.
//   Phase 2 (next):         per-frame disocclusion masks + LaMa inpaint
//                           pass before stitching.
//   Phase 3 (later):        per-room camera profiles, per-style intensity,
//                           flat-depth → Ken Burns auto-route.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { renderDepthClip, stitchFramesToMp4, cameraPathFor, isDepthFlat } from "./depth-renderer.mjs";
import { generateKenBurnsFallback } from "./runway-job.mjs";
import { estimateDepth, inpaintImage, fileToDataUrl } from "./replicate-client.mjs";
import sharp from "sharp";
import {
  stitchClipsAndOverlays,
  uploadDeliverables,
  uploadPerSceneClips
} from "./runway-job.mjs";
import { applyVoiceNarration } from "./voice-mixer.mjs";
import { deriveAspectVariants, buildSocialShorts } from "./aspect-variants.mjs";
import { writeRenderAudit } from "./audit-log.mjs";
import { runFFmpeg } from "./ffmpeg-runner.mjs";
import { existsSync } from "node:fs";

// Tolerant truthy-env parser. Accepts any of: "true", "True", "TRUE",
// "1", "yes", "y", "on" (case-insensitive, with surrounding whitespace
// trimmed). The strict `=== "true"` check we had before silently failed
// when Render's UI saved the value as "True" instead of "true" — produced
// the misleading 'engine not enabled' error on tiers that should work.
function envIsTrue(name) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "y" || raw === "on";
}

const ENABLE_FLAG = envIsTrue("ENABLE_DEPTH_ENGINE");
// Phase 2 opt-in: per-frame LaMa inpaint of disocclusion gaps. Adds
// ~$0.40-0.50 + 2-6 min latency per render (depending on parallelism
// and how many scenes have meaningful disocclusion). Disabled by
// default until end-to-end quality is validated.
const ENABLE_INPAINT = envIsTrue("ENABLE_DEPTH_INPAINT");
// How many inpaints to run concurrently per scene. Higher = faster but
// more Replicate rate-limit risk. 4 is a safe starting point.
const INPAINT_CONCURRENCY = Number(process.env.DEPTH_INPAINT_CONCURRENCY || 4);
// Skip frames whose disocclusion mask has fewer than this fraction of
// white pixels — saves cost on frames with negligible gaps.
const INPAINT_MIN_GAP_FRACTION = Number(process.env.DEPTH_INPAINT_MIN_GAP || 0.005);

/* ============================================================
   Public entry: renderDepthJob
   ============================================================
   Mirrors renderRunwayJob's signature so server.mjs can route to
   either engine interchangeably.
*/
export async function renderDepthJob(body, options = {}) {
  // Pre-flight: fail fast with a SINGLE clear line so the frontend
  // surfaces it cleanly instead of a wall of text. Most common cause
  // of 'render failed at 13%' on a fresh depth deploy is missing env.
  if (!ENABLE_FLAG) {
    throw new Error(
      "Cinematic Depth isn't enabled on this render worker yet. The worker admin needs to set ENABLE_DEPTH_ENGINE=true and REPLICATE_API_TOKEN. For now, switch the engine to Quick Reel or Cinematic AI."
    );
  }
  if (!process.env.REPLICATE_API_TOKEN) {
    throw new Error(
      "Cinematic Depth needs a Replicate API token. The worker admin needs to set REPLICATE_API_TOKEN. For now, switch the engine to Quick Reel or Cinematic AI."
    );
  }

  // server.mjs passes the manifest as `body` (the whole payload) and the
  // jobId via `options.jobId`. Mirror runway-job's pattern: read jobId
  // from options first, fall back to a freshly minted one for ad-hoc
  // calls (smoke tests, local CLI, regen).
  const manifest = body?.manifest || body;
  if (!manifest) throw new Error("renderDepthJob: missing manifest");
  const jobId = options.jobId || makeFallbackJobId(manifest);

  const photoScenes = (manifest.scenes || []).filter(
    (s) => String(s.type || "photo").toLowerCase() === "photo"
  );
  if (photoScenes.length === 0) throw new Error("renderDepthJob: no photo scenes in manifest");

  const tempDir = path.join(os.tmpdir(), `em-depth-${jobId}`);
  await fs.mkdir(tempDir, { recursive: true });

  const dims = depthDimensions(manifest);
  const frameRate = Number(manifest?.runwayConfig?.frameRate || 24);

  options.onProgress?.({ phase: "Depth engine: starting", progress: 5 });

  // ============================================================
  // Step 1: per-scene depth render
  // ============================================================
  // Serial for v1 to stay memory-safe on Render Pro 4GB. depth +
  // WebGL each peak around 200-400 MB; running two in parallel risks
  // OOM. Phase 3 measures real memory and bumps to 2-at-a-time if safe.
  const clipResults = [];
  for (let i = 0; i < photoScenes.length; i++) {
    const scene = photoScenes[i];
    options.onProgress?.({
      phase: `Depth render scene ${i + 1}/${photoScenes.length}`,
      progress: 8 + Math.floor(58 * (i / photoScenes.length))
    });
    const result = await renderOneScene({
      scene,
      manifest,
      tempDir,
      dims,
      frameRate,
      sceneIndex: i
    });
    clipResults.push(result);
  }

  // ============================================================
  // Step 2: stitch + brand overlays (reused from runway-job)
  // ============================================================
  options.onProgress?.({ phase: "Stitching final video", progress: 76 });
  const finalMp4 = path.join(tempDir, `${jobId}.mp4`);
  const thumbnailPath = path.join(tempDir, `${jobId}.png`);

  const { normalizedClips } = await stitchClipsAndOverlays(
    clipResults,
    manifest,
    finalMp4,
    thumbnailPath,
    options
  );

  // ============================================================
  // Step 3: music bed (mirrors runway-job's inline music mix step
  // because that block is engine-agnostic but not yet extracted)
  // ============================================================
  options.onProgress?.({ phase: "Adding music bed", progress: 79 });
  const musicUrl = pickMusicUrl(manifest);
  const masterWithMusic = path.join(tempDir, `${jobId}-music.mp4`);
  if (musicUrl) {
    const musicBedLevel = Number(
      manifest?.musicBedLevel ?? process.env.MUSIC_BED_LEVEL ?? 0.35
    );
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", finalMp4,
      "-i", musicUrl,
      "-filter_complex", `[1:a]volume=${musicBedLevel.toFixed(3)}[mus]`,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-map", "0:v:0",
      "-map", "[mus]",
      masterWithMusic
    ], { timeoutMs: 120000, label: "depth:music-mix" });
  } else {
    await fs.copyFile(finalMp4, masterWithMusic);
  }

  // ============================================================
  // Step 4: voice narration (reused from runway-job)
  // ============================================================
  options.onProgress?.({ phase: "Adding voice narration", progress: 82 });
  let narration = { narrationApplied: false, reason: "skipped" };
  if (manifest?.skipNarration) {
    console.info("[depth] skipNarration=true on manifest — skipping voice step.");
  } else {
    const NARRATION_TIME_BUDGET_MS = 120 * 1000;
    try {
      narration = await Promise.race([
        applyVoiceNarration({
          masterMp4: masterWithMusic,
          scenes: manifest.scenes,
          brandKit: manifest.brandKit || {},
          tempDir,
          jobId,
          manifest,
          onProgress: (info) => {
            options.onProgress?.({ phase: info.phase, progress: 82 + Math.floor((info.fraction || 0) * 4) });
          }
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Narration step exceeded 2-minute time budget.")), NARRATION_TIME_BUDGET_MS)
        )
      ]);
    } catch (err) {
      console.warn(`[depth] narration step failed (${err.message}). Continuing with music-only audio.`);
      narration = { narrationApplied: false, reason: err.message || "narration_failed" };
    }
  }
  const masterForVariants = narration.narrationApplied ? narration.masterMp4 : masterWithMusic;

  // ============================================================
  // Step 5: finalize master (ONE-MASTER simplification)
  // ============================================================
  // No aspect variants, no social shorts. See runway-job.mjs for the
  // full rationale — single 9:16 master per render.
  options.onProgress?.({ phase: "Finalizing master", progress: 90 });
  const variants = {
    vertical: { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } }
  };
  const shorts = [];

  // ============================================================
  // Step 6: upload deliverables + per-scene clips (reused)
  // ============================================================
  options.onProgress?.({ phase: "Uploading deliverables", progress: 94 });
  const upload = await uploadDeliverables({
    manifest,
    jobId,
    variants,
    shorts,
    thumbnailPath,
    pathPrefix: "depth",
    onProgress: (info) => {
      options.onProgress?.({
        phase: info.phase || `Uploading ${info.fileLabel || "deliverables"}`,
        progress: 94 + Math.floor((info.fraction || 0) * 5)
      });
    }
  });

  const scenesMeta = await uploadPerSceneClips({
    manifest,
    jobId,
    normalizedClips,
    clipResults,
    pathPrefix: "depth"
  });

  // Cleanup per-scene local files.
  for (const clip of normalizedClips) {
    await fs.unlink(clip.clipPath).catch(() => {});
  }

  options.onProgress?.({ phase: "Ready to download", progress: 100 });

  // Audit log — fire-and-forget so a slow Supabase write doesn't block.
  // Args MUST match the writeRenderAudit destructuring shape in
  // audit-log.mjs: { manifest, jobId, engine, upload, narration, scenes }.
  // Prior version used engineUsed/scenesMeta — destructured to undefined,
  // audit row had engine=null + scenes=[].
  const enginePhase = ENABLE_INPAINT ? "phase2-inpaint" : "phase1-no-inpaint";
  writeRenderAudit({
    jobId,
    manifest,
    engine: "depth",
    upload,
    narration: narration.narrationApplied
      ? { applied: true, voiceId: narration.voiceId, lineCount: narration.narrationLineCount }
      : { applied: false, reason: narration.reason },
    scenes: scenesMeta
  }).catch((err) => console.warn(`[depth] audit log failed: ${err.message}`));

  // Return shape MUST match runway-job's so server.mjs.publishLocalAssetUrls
  // + the frontend's mp4Url/thumbnailUrl/variants readers all work
  // identically across engines. Prior version returned just {...upload}
  // which is missing mp4Url, jobId, status, engine, etc.
  return {
    status: "complete",
    mock: false,
    engine: "depth",
    enginePhase,
    jobId,
    mp4Url: upload.formats?.vertical?.mp4Url || "",
    thumbnailUrl: upload.thumbnailUrl,
    storagePath: upload.formats?.vertical?.storagePath,
    thumbnailPath: upload.thumbnailStoragePath,
    localMp4Path: upload.storageSkipped ? masterForVariants : "",
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
      cameraMotion: c.cameraMotion,
      enginePhase: c.enginePhase,
      engineSource: c.engineSource || null
    })),
    scenesMeta
  };
}

/* ============================================================
   Per-scene depth render
   ============================================================ */
async function renderOneScene({ scene, manifest, tempDir, dims, frameRate, sceneIndex }) {
  // Image URL lookup mirrors runway-job's pickImageUrl: scenes don't carry
  // the photo URL directly — it lives in manifest.orderedPhotos keyed by
  // photoId. Try every plausible field on scene + photo so partial
  // manifests still work.
  const orderedPhotos = Array.isArray(manifest?.orderedPhotos) ? manifest.orderedPhotos : [];
  const photo = orderedPhotos.find((p) => p?.id === scene.photoId) || {};
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) {
    throw new Error(
      `Depth scene ${sceneIndex + 1} (${scene.photoId}): no source image URL found on scene OR photo record. ` +
      `Manifest.orderedPhotos length=${orderedPhotos.length}. ` +
      `Re-upload photos or re-run create-edit-plan with engine=depth.`
    );
  }

  const padIdx = String(sceneIndex).padStart(3, "0");
  const photoPath = path.join(tempDir, `s${padIdx}-photo.jpg`);
  await downloadTo(imageUrl, photoPath);

  const depthUrl = await estimateDepth({ imageUrl });
  const depthPath = path.join(tempDir, `s${padIdx}-depth.png`);
  await downloadTo(depthUrl, depthPath);

  // ----------------------------------------------------------------
  // Flat-depth check: if the photo has near-uniform depth (wide exterior
  // with no foreground, distant landscape, etc.) parallax adds nothing
  // and we just burn compute. Auto-route those scenes to Ken Burns.
  // ----------------------------------------------------------------
  const flatness = await isDepthFlat(depthPath);
  if (flatness.isFlat) {
    console.info(
      `[depth] scene ${sceneIndex + 1} (${scene.photoId}, room=${scene.roomType}) has flat depth ` +
      `(variance=${flatness.variance.toFixed(4)}, threshold=${flatness.threshold}). ` +
      `Routing to Ken Burns — depth parallax wouldn't add visible motion.`
    );
    await fs.unlink(depthPath).catch(() => {});
    // Fall back to the existing runway-job Ken Burns generator, which is
    // engine-agnostic and uses ffmpeg zoompan. Same path the Runway engine
    // uses when a scene is high-risk for hallucination.
    const fallback = await generateKenBurnsFallback(scene, manifest, tempDir, sceneIndex);
    await fs.unlink(photoPath).catch(() => {});
    return {
      ...fallback,
      engineUsed: "ken_burns",
      engineSource: "depth_flat_detected",
      depthVariance: flatness.variance,
      enginePhase: "flat-fallback"
    };
  }

  // Per-room camera profile + per-style intensity scaling (Phase 3).
  const motion = String(scene.cameraMotion || "push_in").toLowerCase().replace(/[^a-z_]/g, "");
  const styleId = manifest?.selectedStyleId || manifest?.template?.style || null;
  const cameraPath = cameraPathFor(motion, {
    roomType: scene.roomType,
    styleId,
    useRoomPreference: true
  });
  const durationSec = Math.max(2, Math.min(10, Number(scene.duration || 5)));
  const clipPath = path.join(tempDir, `s${padIdx}-clip.mp4`);

  // ----------------------------------------------------------------
  // Path branching: Phase 1 (direct MP4) vs Phase 2 (frames + inpaint)
  // ----------------------------------------------------------------
  if (!ENABLE_INPAINT) {
    // Phase 1: render straight to MP4. Disocclusion gaps will show as
    // magenta in this version — acceptable for first end-to-end test.
    // Once Phase 2 is enabled the magenta is filled by LaMa.
    try {
      const renderResult = await renderDepthClip({
        photoPath,
        depthPath,
        cameraPath,
        dimensions: dims,
        frameRate,
        durationSec,
        outPath: clipPath
      });
      return {
        sceneIndex,
        photoId: scene.photoId,
        clipPath: renderResult.outPath,
        duration: durationSec,
        cameraMotion: motion,
        engineUsed: "depth_parallax",
        enginePhase: "phase1",
        fallback: false,
        runwayPrompt: ""
      };
    } finally {
      // Always clean up the source assets even if render threw — they're
      // a few MB each but accumulate fast across long-running workers.
      await fs.unlink(photoPath).catch(() => {});
      await fs.unlink(depthPath).catch(() => {});
    }
  }

  // Phase 2: render to per-frame PNGs + mask PNGs, inpaint disocclusion
  // gaps via LaMa, stitch cleaned frames into the final MP4.
  const framesDir = path.join(tempDir, `s${padIdx}-frames`);
  try {
    const renderResult = await renderDepthClip({
      photoPath,
      depthPath,
      cameraPath,
      dimensions: dims,
      frameRate,
      durationSec,
      outPath: clipPath, // unused when writeFramesDir is set, but kept for symmetry
      writeFramesDir: framesDir
    });

    await inpaintFrames({
      framesDir,
      totalFrames: renderResult.framesRendered,
      sceneIndex
    });

    await stitchFramesToMp4({
      framesDir,
      outPath: clipPath,
      frameRate
    });

    return {
      sceneIndex,
      photoId: scene.photoId,
      clipPath,
      duration: durationSec,
      cameraMotion: motion,
      engineUsed: "depth_parallax",
      enginePhase: "phase2-inpaint",
      fallback: false,
      runwayPrompt: ""
    };
  } finally {
    // Cleanup runs even if inpaint or stitch threw. Per-scene temp dirs
    // can hit 100+ MB at high resolutions; leaking them across a 24-scene
    // render would burn through Render's local disk.
    await fs.unlink(photoPath).catch(() => {});
    await fs.unlink(depthPath).catch(() => {});
    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============================================================
   Phase 2: disocclusion inpaint pass
   ============================================================
   For each rendered frame:
     1. Read its disocclusion mask.
     2. If the mask is empty (or near-empty), skip — no holes to fill,
        save a Replicate call.
     3. Otherwise feed frame + mask (as data: URLs) to LaMa, download
        the cleaned frame, overwrite frame-NNN.png in place.
   Runs INPAINT_CONCURRENCY frames in parallel to keep total scene
   latency bounded — fully serial would be 5-10 min per scene.
*/
async function inpaintFrames({ framesDir, totalFrames, sceneIndex }) {
  const indices = Array.from({ length: totalFrames }, (_, i) => i);

  // Worker pool — pulls indices off a shared cursor, runs inpaint for
  // each, surfaces errors so we can log but continue (a single failed
  // inpaint = stretched edge for one frame, not a render failure).
  let cursor = 0;
  let skipped = 0;
  let inpainted = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.min(INPAINT_CONCURRENCY, totalFrames) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= indices.length) return;
      const padded = String(i).padStart(4, "0");
      const framePath = path.join(framesDir, `frame-${padded}.png`);
      const maskPath = path.join(framesDir, `mask-${padded}.png`);

      // Cheap mask check: count white pixels. If below threshold,
      // skip the Replicate call — there's nothing meaningful to fill.
      try {
        const { data: maskRaw, info: maskInfo } = await sharp(maskPath).raw().toBuffer({ resolveWithObject: true });
        const totalPx = maskInfo.width * maskInfo.height;
        let whiteCount = 0;
        for (let p = 0; p < maskRaw.length; p++) {
          if (maskRaw[p] > 200) whiteCount++;
        }
        const gapFraction = whiteCount / totalPx;
        if (gapFraction < INPAINT_MIN_GAP_FRACTION) {
          skipped++;
          continue;
        }

        // Inpaint via LaMa — frame + mask as data URLs, no external upload.
        const imageDataUrl = await fileToDataUrl(framePath);
        const maskDataUrl = await fileToDataUrl(maskPath);
        const cleanedUrl = await inpaintImage({ imageUrl: imageDataUrl, maskUrl: maskDataUrl });
        const cleanedRes = await fetch(cleanedUrl);
        if (!cleanedRes.ok) throw new Error(`download cleaned frame failed: HTTP ${cleanedRes.status}`);
        const cleanedBuf = Buffer.from(await cleanedRes.arrayBuffer());
        await fs.writeFile(framePath, cleanedBuf);
        inpainted++;
      } catch (err) {
        failed++;
        console.warn(`[depth:inpaint] scene ${sceneIndex + 1} frame ${i} failed (${err.message}). Keeping raw frame.`);
      }
    }
  });
  await Promise.all(workers);

  console.info(
    `[depth:inpaint] scene ${sceneIndex + 1}: ${inpainted} inpainted, ${skipped} skipped (no gaps), ${failed} failed of ${totalFrames} frames`
  );
}

/* ============================================================
   Helpers
   ============================================================ */
function depthDimensions(manifest) {
  const ratio = String(manifest?.runwayConfig?.ratio || manifest?.exportFormat || "9:16");
  if (ratio.includes("16:9") || ratio === "wide") return { width: 1920, height: 1080 };
  if (ratio === "1:1" || ratio === "square") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 }; // 9:16 default
}

async function downloadTo(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outPath, buf);
}

// Music picker — mirrors the v22 runway-job logic. Manifest.musicTrack
// (set by the webapp's MusicSelector) wins; falls back to style slot.
function pickMusicUrl(manifest) {
  const musicDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "music");
  const candidate = (name) => [
    path.join(musicDir, `${name}.mp3`),
    path.join(musicDir, `${name}.m4a`)
  ];

  const explicitTrack = String(manifest?.musicTrack || "").trim();
  if (explicitTrack) {
    const safeName = path.basename(explicitTrack);
    const explicitPath = path.join(musicDir, safeName);
    if (existsSync(explicitPath)) return explicitPath;
    console.warn(`[depth-music] manifest.musicTrack="${safeName}" not found — falling back to style default.`);
  }

  const mood = String(manifest.musicMood || manifest.selectedStyle || "").toLowerCase();
  let slot;
  if (mood.includes("social") || mood.includes("upbeat") || mood.includes("modern") || mood.includes("viral")) slot = "social";
  else if (mood.includes("mls") || mood.includes("ambient") || mood.includes("clean")) slot = "mls";
  else if (mood.includes("investor") || mood.includes("minimal")) slot = "investor";
  else slot = "luxury";

  for (const localPath of candidate(slot)) {
    if (existsSync(localPath)) return localPath;
  }
  for (const localPath of candidate("default")) {
    if (existsSync(localPath)) return localPath;
  }
  return null;
}

// Fallback jobId for ad-hoc renderDepthJob calls (smoke tests, local
// CLI, direct invocations). Production calls always get a jobId from
// server.mjs via options.jobId.
function makeFallbackJobId(manifest) {
  const projectId =
    manifest?.project?.id || manifest?.project?.title || manifest?.projectTitle || "estate-motion";
  const safe = String(projectId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "depth";
  return `depth-${safe}-${Date.now()}`;
}

// Mirrors runway-job's pickImageUrl exactly — same field priority so the
// two engines accept the same manifest shapes.
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

export const DEPTH_ENGINE_ENABLED = ENABLE_FLAG;
