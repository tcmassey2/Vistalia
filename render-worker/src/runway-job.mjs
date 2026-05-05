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
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

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

  let scenesCompleted = 0;
  const clipResults = await pMap(
    photoScenes,
    async (scene, index) => {
      const result = await generateClip(scene, manifest, tempDir, index);
      scenesCompleted++;
      options.onProgress?.({
        phase: `Rendering scene ${scenesCompleted}/${photoScenes.length}`,
        progress: 10 + Math.floor((scenesCompleted / photoScenes.length) * 70),
        scenesCompleted,
        scenesTotal: photoScenes.length
      });
      return result;
    },
    { concurrency }
  );

  options.onProgress?.({ phase: "Stitching final video", progress: 84 });
  const finalMp4 = path.join(tempDir, `${jobId}.mp4`);
  const thumbnailPath = path.join(tempDir, `${jobId}.png`);

  await stitchClipsAndOverlays(clipResults, manifest, finalMp4, thumbnailPath);

  options.onProgress?.({ phase: "Uploading final MP4", progress: 92 });
  const upload = await uploadRunwayAssets({ manifest, jobId, finalMp4, thumbnailPath });

  options.onProgress?.({ phase: "Ready to download", progress: 100 });

  return {
    status: "complete",
    mock: false,
    engine: "runway",
    jobId,
    mp4Url: upload.mp4Url,
    thumbnailUrl: upload.thumbnailUrl,
    storagePath: upload.storagePath,
    thumbnailPath: upload.thumbnailStoragePath,
    localMp4Path: upload.storageSkipped ? finalMp4 : "",
    localThumbnailPath: upload.storageSkipped ? thumbnailPath : "",
    storageSkipped: upload.storageSkipped,
    storageWarning: upload.storageWarning || "",
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

async function generateClip(scene, manifest, tempDir, sceneIndex) {
  const photo = (manifest.orderedPhotos || []).find((p) => p.id === scene.photoId);
  const imageUrl = pickImageUrl(scene, photo);
  if (!imageUrl) throw new Error(`Scene ${sceneIndex + 1} (${scene.photoId}) missing durable image URL.`);
  const prompt = scene.runwayPrompt || scene.runway_prompt;
  if (!prompt) throw new Error(`Scene ${sceneIndex + 1} missing runwayPrompt. Regenerate edit plan with engine=runway.`);

  const config = manifest.runwayConfig || {};
  const ratio = ratioForRunway(config.ratio);
  const duration = clamp(Number(scene.duration || 5) > 5.5 ? 10 : 5, 5, 10);
  const model = config.model || "gen3a_turbo";

  // Submit task
  const submitResponse = await fetch(`${RUNWAY_API_BASE}/image_to_video`, {
    method: "POST",
    headers: runwayHeaders(),
    body: JSON.stringify({
      model,
      promptImage: imageUrl,
      promptText: prompt,
      ratio,
      duration,
      watermark: false,
      ...(config.seed != null ? { seed: Number(config.seed) } : {})
    })
  });

  if (!submitResponse.ok) {
    const errBody = await safeText(submitResponse);
    throw new Error(
      `Runway submit failed for scene ${sceneIndex + 1} (HTTP ${submitResponse.status}): ${errBody.slice(0, 240)}`
    );
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

async function stitchClipsAndOverlays(clipResults, manifest, outputPath, thumbnailPath) {
  clipResults.sort((a, b) => a.sceneIndex - b.sceneIndex);
  const tempDir = path.dirname(outputPath);

  // Step 1: re-encode each clip to a uniform codec/framerate so concat works
  // safely. Runway clips can return at varying frame rates and sometimes
  // different containers; normalize first to avoid concat artifacts.
  // RAM-conscious flags: -threads 1, ultrafast preset, scaled to 1080p max
  // — Render Standard has 2GB and Chromium is sharing it.
  const normalizedClips = [];
  for (const clip of clipResults) {
    const normalized = path.join(tempDir, `norm-${String(clip.sceneIndex).padStart(3, "0")}.mp4`);
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", clip.clipPath,
      "-vf", "fps=30,scale='min(1920,iw)':-2:flags=fast_bilinear",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "ultrafast",
      "-crf", "23",
      "-an",
      normalized
    ]);
    normalizedClips.push({ ...clip, clipPath: normalized });
  }

  // Step 2: concat with FFmpeg concat demuxer (lossless, fast).
  const concatList = path.join(tempDir, "concat.txt");
  const concatContent = normalizedClips
    .map((clip) => `file '${clip.clipPath.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(concatList, concatContent);

  const stitched = path.join(tempDir, "stitched.mp4");
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-f", "concat",
    "-safe", "0",
    "-i", concatList,
    "-c", "copy",
    stitched
  ]);

  // Step 3: optional audio mix from manifest.musicMood mapping. We honor a
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
    ]);
  } else {
    await fs.copyFile(stitched, outputPath);
  }

  // Free the normalized clips immediately — they can each be 10-30 MB and
  // we no longer need them after the concat step. Helps RAM pressure on
  // the Supabase upload that follows.
  for (const clip of normalizedClips) {
    await fs.unlink(clip.clipPath).catch(() => {});
  }
  await fs.unlink(stitched).catch(() => {});

  // Step 4: extract a thumbnail from ~10% in.
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-i", outputPath,
    "-ss", "1.5",
    "-vframes", "1",
    "-q:v", "3",
    thumbnailPath
  ]);
}

async function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Truncate to last 4KB to avoid runaway memory on long renders
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600).replace(/\n/g, " | ")}`));
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
  });
}

async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destPath, buffer);
}

/* =================================================================
   Supabase upload
   ================================================================= */

async function uploadRunwayAssets({ manifest, jobId, finalMp4, thumbnailPath }) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const bucket = process.env.SUPABASE_GENERATED_VIDEOS_BUCKET || "generated-videos";

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      storageSkipped: true,
      storageWarning: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required to upload Runway videos.",
      mp4Url: "",
      thumbnailUrl: ""
    };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const ownerId = slug(manifest.project?.userId || manifest.project?.id || "demo");
  const basePath = `${ownerId}/runway/${jobId}`;
  const storagePath = `${basePath}/estate-motion.mp4`;
  const thumbnailStoragePath = `${basePath}/thumbnail.png`;

  const mp4Buffer = await fs.readFile(finalMp4);
  const thumbBuffer = await fs.readFile(thumbnailPath);

  const videoUpload = await supabase.storage.from(bucket).upload(storagePath, mp4Buffer, {
    contentType: "video/mp4",
    upsert: true
  });
  if (videoUpload.error) throw new Error(`Supabase video upload failed: ${videoUpload.error.message}`);

  const thumbUpload = await supabase.storage.from(bucket).upload(thumbnailStoragePath, thumbBuffer, {
    contentType: "image/png",
    upsert: true
  });
  if (thumbUpload.error) throw new Error(`Supabase thumbnail upload failed: ${thumbUpload.error.message}`);

  return {
    storageSkipped: false,
    storagePath,
    thumbnailStoragePath,
    mp4Url: supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl,
    thumbnailUrl: supabase.storage.from(bucket).getPublicUrl(thumbnailStoragePath).data.publicUrl
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

function ratioForRunway(ratio) {
  // Runway Gen-3 Turbo expects WxH pixel pairs for image_to_video, not aspect strings.
  const value = String(ratio || "9:16").toLowerCase();
  if (value === "16:9" || value === "wide") return "1280:768";
  if (value === "1:1" || value === "square") return "960:960";
  return "768:1280"; // 9:16 default
}

function pickMusicUrl(manifest) {
  const mood = String(manifest.musicMood || "").toLowerCase();
  if (mood.includes("luxury")) return process.env.RUNWAY_MUSIC_LUXURY_URL || process.env.MUSIC_LUXURY_URL || "";
  if (mood.includes("social") || mood.includes("upbeat")) return process.env.RUNWAY_MUSIC_VIRAL_URL || process.env.MUSIC_VIRAL_URL || "";
  if (mood.includes("ambient") || mood.includes("mls")) return process.env.RUNWAY_MUSIC_MLS_URL || process.env.MUSIC_MLS_CLEAN_URL || "";
  if (mood.includes("investor") || mood.includes("minimal")) return process.env.RUNWAY_MUSIC_INVESTOR_URL || process.env.MUSIC_INVESTOR_URL || "";
  return process.env.RUNWAY_MUSIC_DEFAULT_URL || "";
}

function runwayHeaders() {
  return {
    Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
    "X-Runway-Version": RUNWAY_API_VERSION,
    "Content-Type": "application/json"
  };
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
    // Surface the first error with full context
    const first = errors[0];
    throw new Error(`Runway scene ${first.index + 1} failed: ${first.error.message}`);
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
