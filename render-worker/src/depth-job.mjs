// EstateMotion — Depth-based engine orchestrator (Path B).
//
// Same outward interface as render-worker/src/runway-job.mjs so the rest
// of the worker (server.mjs, audit-log, supabase upload, brand-kit
// overlay) treats us as a peer engine. Drops in alongside Runway with
// no changes to the surrounding infrastructure.
//
// PER-SCENE PIPELINE:
//   1. Download the listing photo to a local temp file.
//   2. POST it to Replicate's depth-anything-v2 → download depth map.
//   3. Call depth-renderer.mjs with photo + depth + camera path → raw
//      clip MP4. (Disocclusion gaps look stretched at this stage.)
//   4. Detect disocclusion masks (TODO Phase 2 — for now skip inpaint,
//      ship the stretched-edge clip and iterate on quality).
//   5. (Phase 2) Run inpainting on each frame, restitch clip.
//   6. Normalize + add brand-kit overlay (reuse runway-job helpers).
//
// PHASE 1 SCOPE (this file):
//   Steps 1, 2, 3, 6. Stretched edges at object boundaries are
//   acceptable for the v1 — Troy + I assess against current Runway
//   output and decide if Phase 2 inpainting is needed.
//
// SAFETY GATE:
//   The depth engine ships behind ENABLE_DEPTH_ENGINE=true. Until that
//   env is set on the worker, any engine="depth" request errors out
//   with a clear "not yet wired" message. This lets us deploy the code
//   without affecting any live render path.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { renderDepthClip, cameraPathFor } from "./depth-renderer.mjs";
import { estimateDepth } from "./replicate-client.mjs";

const ENABLE_FLAG = process.env.ENABLE_DEPTH_ENGINE === "true";

/* ============================================================
   Public entry: renderDepthJob
   ============================================================
   Mirrors renderRunwayJob's signature so server.mjs can hand off
   manifests interchangeably.
*/
export async function renderDepthJob({ manifest, jobId, options = {} }) {
  if (!ENABLE_FLAG) {
    throw new Error(
      "Depth engine is not yet enabled on this worker. " +
      "Set ENABLE_DEPTH_ENGINE=true in the worker env to unlock. " +
      "(This is intentional — depth-job.mjs ships code-complete but " +
      "stays gated until end-to-end quality is validated against Runway.)"
    );
  }

  const scenes = (manifest?.scenes || []).filter(
    (s) => String(s.type || "photo").toLowerCase() === "photo"
  );
  if (scenes.length === 0) throw new Error("renderDepthJob: no photo scenes in manifest");

  const tempDir = path.join(os.tmpdir(), `em-depth-${jobId}`);
  await fs.mkdir(tempDir, { recursive: true });

  const dims = depthDimensions(manifest);
  const frameRate = Number(manifest?.runwayConfig?.frameRate || 24);

  // Render each scene serially for v1 — depth + render + ffmpeg each
  // hold meaningful memory, and the parallelism savings aren't worth
  // OOM risk on Render Pro 4GB. We can move to limited parallelism
  // (2-at-a-time) in Phase 2 after measuring real memory.
  const clipResults = [];
  let sceneIdx = 0;
  for (const scene of scenes) {
    sceneIdx++;
    options.onProgress?.({
      phase: `Depth engine: rendering scene ${sceneIdx}/${scenes.length}`,
      progress: 10 + Math.floor(60 * (sceneIdx / scenes.length))
    });

    const sceneOut = await renderOneScene({
      scene,
      manifest,
      tempDir,
      dims,
      frameRate,
      sceneIndex: sceneIdx - 1
    });
    clipResults.push(sceneOut);
  }

  // For Phase 1 we return the per-scene results in the same shape
  // runway-job returns. The caller (server.mjs / orchestrator) takes
  // it from here — stitching, voice, music, brand kit are all engine-
  // agnostic at that layer.
  return {
    clipResults,
    engine: "depth",
    enginePhase: "phase1-no-inpaint"
  };
}

/* ============================================================
   Per-scene render
   ============================================================ */
async function renderOneScene({ scene, manifest, tempDir, dims, frameRate, sceneIndex }) {
  const imageUrl = scene.imageUrl || scene.photoUrl || scene.durableUrl;
  if (!imageUrl) {
    throw new Error(`Depth scene ${sceneIndex + 1} (${scene.photoId}): no source image URL`);
  }

  // 1. Download photo locally — sharp + WebGL need a file path.
  const photoPath = path.join(tempDir, `s${String(sceneIndex).padStart(3, "0")}-photo.jpg`);
  await downloadTo(imageUrl, photoPath);

  // 2. Depth estimation via Replicate.
  const depthUrl = await estimateDepth({ imageUrl });
  const depthPath = path.join(tempDir, `s${String(sceneIndex).padStart(3, "0")}-depth.png`);
  await downloadTo(depthUrl, depthPath);

  // 3. Render the parallax clip via headless WebGL.
  const motion = String(scene.cameraMotion || "push_in").toLowerCase().replace(/[^a-z_]/g, "");
  const cameraPath = cameraPathFor(motion);
  const durationSec = Math.max(2, Math.min(10, Number(scene.duration || 5)));
  const clipPath = path.join(tempDir, `s${String(sceneIndex).padStart(3, "0")}-clip.mp4`);

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
    fallback: false
  };
}

/* ============================================================
   Helpers
   ============================================================ */
function depthDimensions(manifest) {
  // Mirror runway-job's resolution logic — vertical 9:16 by default,
  // wide 16:9 for "exportFormat: wide". 4K is opt-in via export4K but
  // depth rendering at 4K is GPU-heavy on Render — start at 1080p
  // until we benchmark.
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

export const DEPTH_ENGINE_ENABLED = ENABLE_FLAG;
