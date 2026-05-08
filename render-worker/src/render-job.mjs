import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { deriveAspectVariants, buildSocialShorts } from "./aspect-variants.mjs";
import { applyVoiceNarration } from "./voice-mixer.mjs";
import { writeRenderAudit } from "./audit-log.mjs";
// uploadDeliverables is shared between both engines — defined alongside the
// Runway pipeline since it was the first to need multi-format upload.
import { uploadDeliverables } from "./runway-job.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const compositionId = "EstateMotionRender";

export async function renderEstateMotionJob({ manifest, requestedFormat = "vertical" }, options = {}) {
  validateManifest(manifest);

  const jobId = options.jobId || createJobId(manifest);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "estatemotion-"));
  const mp4Path = path.join(tempDir, `${jobId}.mp4`);
  const thumbnailPath = path.join(tempDir, `${jobId}.png`);
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
          tempDir,
          jobId,
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
  const masterForVariants = narration.narrationApplied ? narration.masterMp4 : mp4Path;

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

  options.onProgress?.({ phase: "Uploading deliverables", progress: 94 });
  const upload = await uploadDeliverables({
    manifest,
    jobId,
    variants,
    shorts,
    thumbnailPath,
    pathPrefix: "generated"
  });

  // Audit log — never throws, never blocks.
  await writeRenderAudit({
    manifest,
    jobId,
    engine: "remotion",
    upload,
    narration
  });

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
// Pulls a single frame from the rendered MP4 at the requested timestamp.
function extractFrameWithFFmpeg(mp4Path, outputPath, timestampSec) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-threads", "1",
      "-i", mp4Path,
      "-ss", String(timestampSec),
      "-vframes", "1",
      "-q:v", "3",
      outputPath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg thumbnail exit ${code}: ${stderr.slice(-300).replace(/\n/g, " | ")}`));
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
  });
}
