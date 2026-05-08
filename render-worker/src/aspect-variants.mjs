// EstateMotion — multi-format atomic export.
//
// Both render engines (Remotion Quick Reel and Runway Cinematic AI) produce
// a 9:16 master MP4. This helper derives 1:1 and 16:9 variants from that
// master via ffmpeg, so one render fans out to every platform an agent posts
// to. No second Remotion bundle, no second Runway billing pass.
//
// Treatments:
//   - vertical (9:16, 1080x1920) — passthrough, the master
//   - square   (1:1, 1080x1080)  — center vertical crop, keeps the strongest
//                                  middle band of the composition
//   - wide     (16:9, 1920x1080) — blurred-pillar treatment (Instagram
//                                  story-to-feed style): the 9:16 fills the
//                                  center, a heavily blurred enlarged copy
//                                  fills the side bars. Looks professional
//                                  on Zillow / YouTube / 16:9 MLS portals.
//
// Cost: each derive runs ~2-4s on a 60s 1080p input on the Render Standard
// plan. Total added latency to a 2-min Cinematic AI render: ~8s. Negligible
// next to the 3-5 minute Runway pipeline; non-zero but acceptable on Quick
// Reel.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const VARIANTS = ["vertical", "square", "wide"];

export async function deriveAspectVariants({ masterMp4, tempDir, jobId, upscale4K = false }) {
  const stat = await fs.stat(masterMp4);
  if (!stat.isFile()) throw new Error(`Master MP4 not found at ${masterMp4}`);

  // Output dimensions. When upscale4K is true, every variant is doubled to
  // a 4K-equivalent: 9:16 → 2160x3840, 1:1 → 2160x2160, 16:9 → 3840x2160.
  // The master itself is also upscaled so the vertical deliverable is 4K.
  // Lanczos resampling gives the best quality-vs-speed for ~2x upscale.
  const dim = upscale4K
    ? { v: { w: 2160, h: 3840 }, s: { w: 2160, h: 2160 }, w: { w: 3840, h: 2160 } }
    : { v: { w: 1080, h: 1920 }, s: { w: 1080, h: 1080 }, w: { w: 1920, h: 1080 } };

  // Vertical (master). Either pass-through or upscale-to-4K.
  let verticalPath = masterMp4;
  if (upscale4K) {
    verticalPath = path.join(tempDir, `${jobId}-vertical-4k.mp4`);
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-i", masterMp4,
      "-vf", `scale=${dim.v.w}:${dim.v.h}:flags=lanczos`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "ultrafast",
      "-crf", "20",
      "-c:a", "copy",
      verticalPath
    ]);
  }

  const outputs = {
    vertical: { format: "vertical", path: verticalPath, dimensions: dim.v }
  };

  // 1:1 — center vertical crop from the 9:16 master, optionally upscaled.
  const squarePath = path.join(tempDir, `${jobId}-square.mp4`);
  const squareFilter = upscale4K
    ? `crop=1080:1080:(in_w-1080)/2:(in_h-1080)/2,scale=${dim.s.w}:${dim.s.h}:flags=lanczos`
    : `crop=1080:1080:(in_w-1080)/2:(in_h-1080)/2`;
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-i", masterMp4,
    "-vf", squareFilter,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "ultrafast",
    "-crf", "21",
    "-c:a", "copy",
    squarePath
  ]);
  outputs.square = { format: "square", path: squarePath, dimensions: dim.s };

  // 16:9 — blurred-pillar treatment, optionally upscaled.
  const widePath = path.join(tempDir, `${jobId}-wide.mp4`);
  const wideFilter = upscale4K
    ? [
        `[0:v]scale=${dim.w.w}:${dim.w.h}:force_original_aspect_ratio=increase,crop=${dim.w.w}:${dim.w.h},boxblur=48:2[bg]`,
        `[0:v]scale=-1:${dim.w.h}:flags=lanczos[fg]`,
        `[bg][fg]overlay=(W-w)/2:0`
      ].join(";")
    : [
        `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=24:2[bg]`,
        `[0:v]scale=-1:1080:flags=lanczos[fg]`,
        `[bg][fg]overlay=(W-w)/2:0`
      ].join(";");
  await runFFmpeg([
    "-y",
    "-threads", "1",
    "-i", masterMp4,
    "-filter_complex", wideFilter,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "ultrafast",
    "-crf", "21",
    "-c:a", "copy",
    widePath
  ]);
  outputs.wide = { format: "wide", path: widePath, dimensions: dim.w };

  return outputs;
}

// Cuts N short hero clips from the master video for Instagram Reels / TikTok
// posts. Each clip is a single edit-plan scene (the highest-qualityScore
// scenes), 9-12 seconds, 9:16, with the persistent watermark already baked in
// (since the master has it). Output is exactly the format Instagram Reels
// rewards: short, vertical, single clean shot.
//
// Returns an array of { clipNumber, path, sourceSceneId, sourceSceneOrder }.
export async function buildSocialShorts({ masterMp4, scenes, tempDir, jobId, count = 3 }) {
  if (!Array.isArray(scenes) || scenes.length === 0) return [];

  // Only photo scenes contribute to the master timeline before the outro card.
  const photoScenes = scenes.filter((s) => String(s.type || "photo").toLowerCase() === "photo");
  if (photoScenes.length < 2) return [];

  // Compute cumulative scene start times in seconds. Scene durations come
  // straight from the manifest that produced the master.
  let cursor = 0;
  const sceneTimings = photoScenes.map((scene) => {
    const start = cursor;
    const duration = Number(scene.duration || 3);
    cursor += duration;
    return {
      ...scene,
      startSec: start,
      durationSec: duration
    };
  });

  // Pick the top N hero scenes. Selection rules:
  //   - Skip scene 0 (it's the address intro — already on the long video)
  //   - Sort remaining by qualityScore descending
  //   - Prefer kitchen / living / exterior / outdoor (highest engagement on social)
  //   - Take top N, then re-sort by original order so the shorts are numbered
  //     in tour order rather than score order
  const SOCIAL_ROOM_BOOST = { kitchen: 8, living: 6, exterior: 5, outdoor: 5, bedroom: 2 };
  const candidates = sceneTimings
    .slice(1)
    .map((scene) => ({
      ...scene,
      socialScore: Number(scene.qualityScore || 70) + (SOCIAL_ROOM_BOOST[scene.roomType] || 0)
    }))
    .sort((a, b) => b.socialScore - a.socialScore)
    .slice(0, count)
    .sort((a, b) => a.startSec - b.startSec);

  const shorts = [];
  for (let i = 0; i < candidates.length; i++) {
    const scene = candidates[i];
    // Each short = the chosen scene padded to ~10s so it has time to breathe.
    // If the source scene is already 10s+ (Cinematic AI hero shots), use as-is.
    const targetDuration = Math.max(scene.durationSec, 9);
    const shortPath = path.join(tempDir, `${jobId}-short-${i + 1}.mp4`);
    await runFFmpeg([
      "-y",
      "-threads", "1",
      "-ss", String(scene.startSec.toFixed(2)),
      "-i", masterMp4,
      "-t", String(targetDuration.toFixed(2)),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "ultrafast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      shortPath
    ]);
    shorts.push({
      clipNumber: i + 1,
      path: shortPath,
      sourceSceneId: scene.photoId,
      sourceSceneOrder: scene.order,
      durationSec: targetDuration,
      roomType: scene.roomType
    });
  }

  return shorts;
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600).replace(/\n/g, " | ")}`));
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
  });
}

export const ASPECT_FORMATS = VARIANTS;
