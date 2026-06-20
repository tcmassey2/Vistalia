// Vistalia — depth-renderer end-to-end smoke test.
//
// Generates a synthetic test photo + a matching depth gradient so this
// runs WITHOUT any network access or Replicate calls. Validates that
// the entire depth-renderer.mjs pipeline produces a playable MP4
// against a known-good input. If smoke:gl passes but THIS fails, the
// bug is in our renderer code (mesh / camera math / ffmpeg piping),
// not in the underlying gl/three stack.
//
// Run on the worker:
//   npm run smoke:depth
//
// Expected output:
//   ✓ test photo + depth gradient generated
//   ✓ renderDepthClip completed (N frames in ~Ts)
//   ✓ output mp4 exists and ffprobes cleanly
//
// Output lives at render-worker/scratch/depth-smoke.mp4 — scp it off
// the worker and watch it to subjectively assess motion quality.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import sharp from "sharp";
import {
  renderDepthClip,
  cameraPathFor,
  CAMERA_PRESETS
} from "../src/depth-renderer.mjs";

function ok(msg) { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg, err) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  if (err) console.error(err.stack || err.message || err);
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRATCH_DIR = path.resolve(__dirname, "..", "scratch");

await fs.mkdir(SCRATCH_DIR, { recursive: true });

// ----------------------------------------------------------------------
// Generate a synthetic test photo + matching depth gradient.
// ----------------------------------------------------------------------
// Photo: 1280x720 image with horizontal color bands so motion is easy
//        to perceive visually (red band on top, then green, then blue,
//        with white labels every 200 px so you can spot horizontal pan).
// Depth: same dimensions, vertical gradient — top of frame is far (255),
//        bottom is near (0). When the camera pushes in, the bottom of
//        the frame should grow faster than the top (parallax).
// ----------------------------------------------------------------------

const W = 1280;
const H = 720;
const photoPath = path.join(SCRATCH_DIR, "smoke-photo.png");
const depthPath = path.join(SCRATCH_DIR, "smoke-depth.png");

try {
  // Build photo as a raw RGB buffer with horizontal bands.
  const photoRgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const band = Math.floor((y / H) * 3); // 0=red, 1=green, 2=blue
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 3;
      const stripeMod = Math.floor(x / 200) % 2;
      const brightness = stripeMod ? 220 : 160; // light/dark stripes for motion clarity
      photoRgb[idx]     = band === 0 ? brightness : 30;
      photoRgb[idx + 1] = band === 1 ? brightness : 30;
      photoRgb[idx + 2] = band === 2 ? brightness : 30;
    }
  }
  await sharp(photoRgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile(photoPath);

  // Depth: vertical gradient. Top (y=0) → 255 (far). Bottom (y=H) → 0 (near).
  const depthGray = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    const val = Math.round(255 * (1 - y / (H - 1)));
    for (let x = 0; x < W; x++) {
      depthGray[y * W + x] = val;
    }
  }
  await sharp(depthGray, { raw: { width: W, height: H, channels: 1 } }).png().toFile(depthPath);

  ok(`test photo + depth gradient generated (${W}x${H} → ${photoPath}, ${depthPath})`);
} catch (err) {
  fail("synthetic input generation failed", err);
}

// ----------------------------------------------------------------------
// Render a 4-second clip using the parallax_zoom preset (the most
// motion-visible of the bundled presets).
// ----------------------------------------------------------------------

const outPath = path.join(SCRATCH_DIR, "depth-smoke.mp4");
const motion = "parallax_zoom";
const duration = 4;
const frameRate = 24;

let result;
try {
  const t0 = Date.now();
  result = await renderDepthClip({
    photoPath,
    depthPath,
    cameraPath: cameraPathFor(motion),
    dimensions: { width: W, height: H },
    frameRate,
    durationSec: duration,
    outPath
  });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);
  ok(`renderDepthClip completed (${result.framesRendered} frames in ${elapsedSec}s, preset=${motion})`);
} catch (err) {
  fail("renderDepthClip threw", err);
}

// ----------------------------------------------------------------------
// Verify the output MP4 exists and is decodable.
// ----------------------------------------------------------------------

try {
  const stat = await fs.stat(outPath);
  if (stat.size < 1024) {
    throw new Error(`output mp4 suspiciously small (${stat.size} bytes)`);
  }
  ok(`output mp4 exists (${stat.size.toLocaleString()} bytes)`);
} catch (err) {
  fail("output mp4 missing or empty", err);
}

try {
  const probe = await ffprobe(outPath);
  if (!probe.includes("Video:") || !probe.includes("h264")) {
    throw new Error(`ffprobe didn't find a h264 video stream:\n${probe.slice(0, 400)}`);
  }
  ok(`output mp4 ffprobes cleanly (h264 stream present)`);
} catch (err) {
  fail("output mp4 ffprobe failed", err);
}

console.log("");
console.log(`\x1b[32mAll depth-renderer smoke tests passed.\x1b[0m`);
console.log(`Watch the output: ${outPath}`);
console.log("");
console.log(`Available presets to test next: ${Object.keys(CAMERA_PRESETS).join(", ")}`);

function ffprobe(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "info",
      "-i", filePath,
      "-of", "default=nw=1"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    proc.stdout.on("data", (c) => { buf += c.toString(); });
    proc.stderr.on("data", (c) => { buf += c.toString(); });
    proc.on("close", () => resolve(buf));
    proc.on("error", reject);
  });
}
