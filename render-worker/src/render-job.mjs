import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { deriveAspectVariants, buildSocialShorts } from "./aspect-variants.mjs";
import { applyVoiceNarration } from "./voice-mixer.mjs";
import { applyTransitionSfx } from "./sfx-mixer.mjs";
import { writeRenderAudit } from "./audit-log.mjs";
// uploadDeliverables is shared between both engines — defined alongside the
// Runway pipeline since it was the first to need multi-format upload.
import { uploadDeliverables } from "./runway-job.mjs";
import { buildColorGradeFilter, describeColorGrade, resolveLUTPath } from "./color-grade.mjs";
import { runFFmpeg } from "./ffmpeg-runner.mjs";
import { preprocessPhotosForRender } from "./photo-preprocess.mjs";
import { getBpmForMusic, beatGridFromBpm, snapScenesToBeats } from "./beat-detect.mjs";
import { validateMasterMp4 } from "./output-validator.mjs";
import { shouldRunPhotoPreprocess, shouldSnapBeats, shouldPrependAddressCard } from "./legacy-mode.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const compositionId = "EstateMotionRender";

export async function renderEstateMotionJob({ manifest, requestedFormat = "vertical" }, options = {}) {
  validateManifest(manifest);

  const jobId = options.jobId || createJobId(manifest);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "estatemotion-"));
  const mp4Path = path.join(tempDir, `${jobId}.mp4`);
  const thumbnailPath = path.join(tempDir, `${jobId}.png`);

  // v23: photo preprocessing pass. Normalizes white balance + exposure
  // across the entire reel so kitchens shot at 3200K don't read as
  // jaundiced next to bedrooms shot at 5600K. Replaces every photo URL
  // in the manifest with the processed Supabase URL. Failures fall back
  // to the original URL on a per-photo basis (render still ships).
  if (shouldRunPhotoPreprocess()) {
    options.onProgress?.({ phase: "Normalizing photos", progress: 6 });
    const preprocessResult = await preprocessPhotosForRender({ manifest, jobId });
    manifest = preprocessResult.manifest;
  }

  // V23 kill switch: address card lives inside the Remotion JSX
  // composition. The JSX checks manifest.disableAddressCard. Stamp that
  // flag here so the kill switch reaches the bundled JSX environment
  // where process.env doesn't propagate.
  if (!shouldPrependAddressCard()) {
    manifest = { ...manifest, disableAddressCard: true };
  }

  // v23: beat-aware Viral pacing — same logic as Runway side. Only fires
  // for selectedStyle="viral"; other styles keep their natural pacing.
  // Suppressed in legacy mode.
  try {
    const styleSlug = String(manifest?.selectedStyle || manifest?.template?.style || "").toLowerCase();
    if (styleSlug === "viral" && shouldSnapBeats()) {
      const musicSlot = String(manifest?.musicMood || manifest?.selectedStyle || "").toLowerCase();
      const bpm = getBpmForMusic({
        musicUrl: manifest?.music?.url,
        musicSlot,
        manifest
      });
      const estimatedTotal = (manifest.scenes || []).reduce((acc, s) => acc + (Number(s.duration) || 3), 0) + 8;
      const beats = beatGridFromBpm(bpm, estimatedTotal);
      manifest.scenes = snapScenesToBeats({
        scenes: manifest.scenes,
        beats,
        styleSlug: "viral",
        beatsPerScene: 2
      });
      console.info(`[remotion] beat-aware Viral pacing applied (bpm=${bpm})`);
    }
  } catch (err) {
    console.warn(`[remotion] beat-snap failed (${err.message}). Using original scene durations.`);
  }

  const inputProps = {
    manifest,
    format: normalizeFormat(requestedFormat)
  };

  options.onProgress?.({ phase: "Preparing video", progress: 12 });
  const entryPoint = path.join(dirname, "remotion-entry.jsx");
  const bundleLocation = await bundle({
    entryPoint,
    webpackOverride: (config) => config
  });

  options.onProgress?.({ phase: "Rendering scenes", progress: 34 });
  // Default selectComposition timeout is 30s — too short when the
  // composition mounts <Img> tags for 8-25 photos hosted on Supabase
  // / Unsplash. Bump to 120s for the page-load step and 180s per-frame.
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
    inputProps,
    timeoutInMilliseconds: 120000
  });

  options.onProgress?.({ phase: "Rendering scenes", progress: 48 });
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    outputLocation: mp4Path,
    inputProps,
    timeoutInMilliseconds: 180000,
    concurrency: 1,
    chromiumOptions: {
      ignoreCertificateErrors: true
    }
  });

  // v23: per-style 3D LUT applied as a post-render pass on the master MP4.
  // The Remotion composition outputs a "neutral" graded master (CSS filters
  // in JSX are subtle on purpose); the LUT then bakes the style's signature
  // look in. Thumbnail + aspect variants + shorts all inherit it because
  // they're derived from this graded master.
  //
  // This is a fail-soft step — if grading fails for any reason, we keep
  // the ungraded master so the render still ships. Worst case a customer
  // gets an "OK" looking video instead of a "premium" looking one.
  options.onProgress?.({ phase: "Applying color grade", progress: 70 });
  if (resolveLUTPath(manifest)) {
    try {
      await applyColorGradeLUT(mp4Path, manifest);
      console.info(`[remotion] color grade applied: ${describeColorGrade(manifest)}`);
    } catch (err) {
      console.warn(`[remotion] color grade failed (${err.message}). Shipping ungraded master.`);
    }
  } else {
    console.info(`[remotion] color grade: ${describeColorGrade(manifest)} (no-op)`);
  }

  options.onProgress?.({ phase: "Finalizing MP4", progress: 78 });
  // Thumbnail render via Remotion's renderStill, with ffmpeg-based frame
  // extraction as fallback. The thumbnail is non-critical to the actual
  // video — losing it just means agents see a black poster image, which
  // is a degraded but acceptable outcome compared to a failed render.
  try {
    await renderStill({
      composition,
      serveUrl: bundleLocation,
      output: thumbnailPath,
      frame: Math.min(45, Math.max(0, composition.durationInFrames - 1)),
      inputProps,
      timeoutInMilliseconds: 60000
    });
  } catch (err) {
    console.warn(`[remotion] renderStill failed (${err.message}). Falling back to ffmpeg frame extraction.`);
    try {
      await extractFrameWithFFmpeg(mp4Path, thumbnailPath, 1.5);
    } catch (err2) {
      console.warn(`[remotion] ffmpeg thumbnail extraction also failed: ${err2.message}. Render will ship without a poster.`);
    }
  }

  // Fail-soft voice narration with 2-minute time budget. If anything goes
  // wrong (ElevenLabs slow / errored / ffmpeg mix stuck), the render still
  // completes with music-only audio.
  options.onProgress?.({ phase: "Adding voice narration", progress: 80 });
  let narration = { narrationApplied: false, reason: "skipped" };
  if (manifest?.skipNarration) {
    console.info("[remotion] skipNarration=true on manifest — skipping voice step.");
  } else {
    const NARRATION_TIME_BUDGET_MS = 120 * 1000;
    try {
      narration = await Promise.race([
        applyVoiceNarration({
          masterMp4: mp4Path,
          scenes: manifest.scenes,
          brandKit: manifest.brandKit || {},
          manifest,
          tempDir,
          jobId,
          // v23: Remotion bakes a 3.5s address card BEFORE scene 1 unless
          // disabled. Voice narration must shift forward by that pre-roll
          // so it lands on scene 1, not on the address card.
          preRollSeconds: manifest?.disableAddressCard ? 0 : 3.5,
          onProgress: (info) => {
            options.onProgress?.({ phase: info.phase, progress: 80 + Math.floor((info.fraction || 0) * 4) });
          }
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Narration step exceeded 2-minute time budget.")), NARRATION_TIME_BUDGET_MS)
        )
      ]);
    } catch (err) {
      console.warn(`[remotion] narration step failed (${err.message}). Continuing with music-only audio.`);
      narration = { narrationApplied: false, reason: err.message || "narration_failed" };
    }
  }
  const postNarrationMaster = narration.narrationApplied ? narration.masterMp4 : mp4Path;

  // v23: transition SFX layered on top of (music + narration) at -18dB.
  // Per-scene SFX selected from scene.transition + active style pack.
  // Fail-soft — keeps the post-narration master if anything errors.
  options.onProgress?.({ phase: "Adding transition SFX", progress: 84 });
  let sfxResult = { masterMp4: postNarrationMaster, applied: false };
  try {
    sfxResult = await applyTransitionSfx({
      masterMp4: postNarrationMaster,
      scenes: manifest.scenes,
      tempDir,
      jobId,
      manifest,
      preRollSeconds: manifest?.disableAddressCard ? 0 : 3.5
    });
    if (sfxResult.applied) {
      console.info(`[remotion] transition SFX applied (${sfxResult.sfxCount} cues)`);
    }
  } catch (err) {
    console.warn(`[remotion] SFX step failed (${err.message}). Continuing without SFX.`);
    sfxResult = { masterMp4: postNarrationMaster, applied: false, reason: err.message };
  }
  const masterForVariants = sfxResult.masterMp4;

  options.onProgress?.({ phase: "Deriving aspect variants", progress: 86 });
  const wants4K = Boolean(manifest?.export4K || String(manifest?.exportFormat || "").toLowerCase().includes("4k"));
  let variants = {};
  try {
    variants = await deriveAspectVariants({
      masterMp4: masterForVariants,
      tempDir,
      jobId,
      upscale4K: wants4K
    });
  } catch (err) {
    console.warn(`[remotion] aspect variants failed entirely (${err.message}). Falling back to vertical-only.`);
    variants = { vertical: { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } } };
  }
  // Guarantee at least vertical exists — without it there's nothing to ship.
  if (!variants.vertical?.path) {
    variants.vertical = { format: "vertical", path: masterForVariants, dimensions: { w: 1080, h: 1920 } };
  }

  options.onProgress?.({ phase: "Cutting social shorts", progress: 90 });
  let shorts = [];
  try {
    shorts = await buildSocialShorts({
      masterMp4: masterForVariants,
      scenes: manifest.scenes,
      tempDir,
      jobId,
      count: 3
    });
  } catch (err) {
    console.warn(`[remotion] social shorts failed entirely (${err.message}). Continuing without shorts.`);
    shorts = [];
  }

  // v23: ffprobe validation gate — same as Runway path. Throws on hard
  // failure with code OUTPUT_VALIDATION_FAILED so the job is marked failed
  // instead of shipping a broken master.
  options.onProgress?.({ phase: "Validating final video", progress: 92 });
  try {
    const expectedSec = (() => {
      const sceneSec = (manifest.scenes || [])
        .filter((s) => String(s.type || "photo").toLowerCase() === "photo")
        .reduce((acc, s) => acc + Number(s.duration || 3), 0);
      const cardSec = manifest?.disableAddressCard ? 0 : 3.5;
      // Outro duration comes from the style pack's outroDuration field
      // (typically 5s) — best-effort estimate. Validation tolerance covers
      // up to 0.6s of drift.
      const outroSec = 5;
      return sceneSec + cardSec + outroSec;
    })();
    const expectedDimensions = (variants.vertical?.dimensions) || { width: 1080, height: 1920 };
    await validateMasterMp4({
      filePath: variants.vertical?.path || mp4Path,
      expectedDurationSec: expectedSec,
      expectedDimensions,
      label: "remotion"
    });
  } catch (err) {
    if (err.code === "OUTPUT_VALIDATION_FAILED") {
      err.jobPhase = "validation";
      throw err;
    }
    throw err;
  }

  options.onProgress?.({ phase: "Uploading deliverables", progress: 94 });
  // Per-file upload progress so the bar advances 94 → 99 as each file
  // finishes. Without this the bar sits at ~99% for the entire upload.
  const upload = await uploadDeliverables({
    manifest,
    jobId,
    variants,
    shorts,
    thumbnailPath,
    pathPrefix: "generated",
    onProgress: (info) => {
      options.onProgress?.({
        phase: info.phase || `Uploading ${info.fileLabel || "deliverables"}`,
        progress: 94 + Math.floor((info.fraction || 0) * 5)
      });
    }
  });

  // v23: per-scene engine breakdown for the Remotion path. Quick Reel
  // doesn't have engine fallback — every scene is "remotion" — but we
  // still emit a uniform per-scene array so the UI can render its
  // breakdown widget consistently across both engines.
  const remotionSceneMeta = (manifest.scenes || [])
    .filter((s) => String(s.type || "photo").toLowerCase() === "photo")
    .map((s, i) => ({
      sceneIndex: i,
      photoId: s.photoId || "",
      photoUrl: s.durableUrl || s.durable_url || s.publicUrl || s.public_url || s.imageUrl || "",
      roomType: s.roomType || "",
      cameraMotion: s.cameraMotion || "",
      duration: Number(s.duration || 3),
      engineUsed: "remotion",
      fallbackReason: null
    }));

  // Audit log — TRULY fire-and-forget (no await). Cannot block completion.
  writeRenderAudit({
    manifest,
    jobId,
    engine: "remotion",
    upload,
    narration,
    scenes: remotionSceneMeta
  }).catch(() => {});

  return {
    status: "complete",
    mock: false,
    jobId,
    mp4Url: upload.formats?.vertical?.mp4Url || "",
    thumbnailUrl: upload.thumbnailUrl,
    storagePath: upload.formats?.vertical?.storagePath,
    thumbnailPath: upload.thumbnailStoragePath,
    localMp4Path: upload.storageSkipped ? mp4Path : "",
    localThumbnailPath: upload.storageSkipped ? thumbnailPath : "",
    storageSkipped: upload.storageSkipped,
    storageWarning: upload.storageWarning || "",
    formats: upload.formats,
    socialShorts: upload.socialShorts,
    narration: narration.narrationApplied
      ? { applied: true, voiceId: narration.voiceId, lineCount: narration.narrationLineCount }
      : { applied: false, reason: narration.reason },
    format: inputProps.format,
    durationInFrames: composition.durationInFrames
  };
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error("Render manifest must include at least one scene.");
  }

  const photos = manifest.orderedPhotos || [];
  const missingDurableUrl = photos.some((photo) => !String(photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || ""));
  if (missingDurableUrl) {
    throw new Error("Live MP4 rendering requires durable Supabase image URLs on every ordered photo.");
  }
  const hasUnrenderableLocalUrl = photos.some((photo) => {
    const url = String(photo.durableUrl || photo.durable_url || photo.publicUrl || photo.public_url || photo.imageUrl || photo.uri || "");
    return url.startsWith("blob:") || url.startsWith("data:");
  });
  if (hasUnrenderableLocalUrl) {
    throw new Error("Live MP4 rendering requires Supabase/public image URLs. Browser blob/data URLs only work in MOCK_RENDERING mode.");
  }
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  for (const [index, scene] of manifest.scenes.entries()) {
    if (String(scene.type || "photo").toLowerCase() !== "photo") continue;
    const label = scene.fileName || `scene ${index + 1}`;
    const imageUrl = scene.durableUrl || scene.durable_url || scene.publicUrl || scene.public_url || scene.imageUrl || "";
    if (!scene.photoId) throw new Error(`${label} is missing photoId.`);
    if (!photosById.has(scene.photoId)) throw new Error(`${label} references a photo that is not in orderedPhotos.`);
    if (!imageUrl) throw new Error(`${label} is missing a durable image URL.`);
    if (String(imageUrl).startsWith("blob:") || String(imageUrl).startsWith("data:")) {
      throw new Error(`${label} uses a browser-only image URL. Re-upload photos before rendering.`);
    }
  }
}

function normalizeFormat(format) {
  const value = String(format || "vertical").toLowerCase();
  if (value === "9:16" || value === "reel" || value === "vertical") return "vertical";
  if (value === "1:1" || value === "square") return "square";
  if (value === "16:9" || value === "wide" || value === "youtube") return "wide";
  if (value === "mls") return "mls";
  return "vertical";
}

function createJobId(manifest) {
  const projectId = manifest.project?.id || manifest.project?.title || "estate-motion";
  return `${slug(projectId)}-${Date.now()}`;
}

function slug(value) {
  return String(value || "render").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "render";
}

// Fallback thumbnail extraction — used when Remotion's renderStill fails.
// Delegates to the shared timeout-aware ffmpeg runner so a hung thumbnail
// extract can't lock up the render.
async function extractFrameWithFFmpeg(mp4Path, outputPath, timestampSec) {
  return runFFmpeg([
    "-y",
    "-threads", "1",
    "-i", mp4Path,
    "-ss", String(timestampSec),
    "-vframes", "1",
    "-q:v", "3",
    outputPath
  ], { timeoutMs: 30000, label: "remotion:thumbnail-fallback" });
}

/* ----------------------------------------------------------------
   applyColorGradeLUT
   ----------------------------------------------------------------
   Post-Remotion-render pass: applies the style's 3D LUT to the master
   MP4 in-place. Writes to <mp4Path>.tmp first, then renames over the
   original — that way any partial failure leaves the original intact.

   Encoding settings mirror the Runway pipeline's normalize step
   (superfast preset, CRF 19, capped x264 params) for consistent
   visual quality + memory ceiling across both engines.

   Memory profile: ffmpeg with lut3d on a 1080×1920 H.264 input runs at
   ~120-160MB peak — well under Render Standard's 2GB ceiling even when
   stacked with the rest of the render-worker process.
*/
async function applyColorGradeLUT(mp4Path, manifest) {
  const filter = buildColorGradeFilter(manifest, { verboseLog: true });
  const tmpPath = `${mp4Path}.graded.tmp.mp4`;
  await runFFmpeg(
    [
      "-y",
      "-threads", "1",
      "-i", mp4Path,
      "-vf", filter,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "superfast",
      "-crf", "19",
      "-x264-params", "rc-lookahead=10:ref=2:bframes=2:keyint=60:scenecut=0",
      "-bufsize", "2M",
      "-c:a", "copy", // preserve any audio track Remotion already encoded
      tmpPath
    ],
    { timeoutMs: 240000, label: "remotion:color-grade-lut" }
  );
  // Atomic rename: tmp → original. If anything failed above, the original
  // is still on disk and the render continues with the ungraded master.
  await fs.rename(tmpPath, mp4Path);
}
