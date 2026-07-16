// Vistalia — Homography Drift Photo Motion (v39).
//
// THE deterministic QC floor. Replaces both the v36 zoompan floor and the
// v37 depth-parallax floor.
//
// Why this exists (7/7 postmortem): v37 weighted per-pixel displacement by
// estimated depth. Any per-pixel depth-dependent scale BENDS STRAIGHT
// LINES — a grid warped through the v37 field snakes visibly, and in a
// listing video that's cabinet edges and door frames breathing. Rooms read
// as rubber. Unshippable, and untunable: the bending IS the effect.
//
// The fix is to restrict motion to the projective group. For a camera that
// ROTATES in place, the image-to-image map is exactly H = K·R·K⁻¹ for any
// scene, with zero knowledge of geometry — pan/tilt from a single photo is
// physically correct, not an approximation. We compose that with a gentle
// uniform scale (dolly approximation). Homographies map lines to lines, so
// architecture stays rigid no matter what. The trade: no parallax. This
// rung fires after Veo has failed a scene three times; its contract is
// "cannot be wrong", not "walk-through". Every pixel provably comes from
// the customer's photo — no hallucination is possible here.
//
// Sampling uses the in-repo ONNX GridSample graph (assets/warp.onnx) for
// true bilinear fractional warping — every stock ffmpeg warp is integer-
// only and seams on smooth gradients (v36.x lesson). Rendered at 1.5x the
// delivery resolution and lanczos-downscaled so the zoomed frames land on
// native-or-better pixels ("no super blurry zoom").

import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import ort from "onnxruntime-node";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WARP_MODEL_PATH = path.join(HERE, "..", "assets", "warp.onnx");

let warpSessionPromise = null;
function warpSession() {
  if (!warpSessionPromise) {
    warpSessionPromise = ort.InferenceSession.create(WARP_MODEL_PATH);
    warpSessionPromise.catch(() => { warpSessionPromise = null; });
  }
  return warpSessionPromise;
}

// ——— 3×3 helpers (row-major) ———
function matMul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
function matInv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  const det = a * A + b * D + c * G;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}

/**
 * Camera pose → image homography. Small yaw/pitch/roll (radians) around a
 * pinhole at (cx,cy) with focal f, then uniform scale z about (cx,cy).
 * Returns the OUTPUT→SOURCE map (inverse), ready for sampling.
 */
function poseToSampleMap({ yaw, pitch, roll, zoom, f, cx, cy }) {
  const cyw = Math.cos(yaw), syw = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Rz(roll)·Rx(pitch)·Ry(yaw)
  const Ry = [cyw, 0, syw, 0, 1, 0, -syw, 0, cyw];
  const Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const Rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  const R = matMul(Rz, matMul(Rx, Ry));
  const K = [f, 0, cx, 0, f, cy, 0, 0, 1];
  const Kinv = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const S = [zoom, 0, cx * (1 - zoom), 0, zoom, cy * (1 - zoom), 0, 0, 1];
  const H = matMul(S, matMul(K, matMul(R, Kinv)));
  return matInv(H); // output pixel → source pixel
}

// Choreography palette (v37.2 Reel-E lesson: variety between scenes reads
// as filmed; a single repeated move reads mechanical). Angles in degrees at
// s=1; zoom is the end scale. All values chosen small enough that the
// keystone stays "steadicam", never "security camera".
const DEG = Math.PI / 180;
const MOVES = [
  { yaw: [0, 1.5],    pitch: [0, -0.35], roll: 0,     zoom: [1.0, 1.13] },  // push + slow turn R
  { yaw: [1.6, -1.6], pitch: [0, 0],     roll: 0,     zoom: [1.0, 1.06] },  // glide sweep L
  { yaw: [0, -1.2],   pitch: [0.3, -0.3], roll: 0,    zoom: [1.0, 1.12] },  // push + turn L, rise
  // v46 (m50): was a settling PULL (zoom 1.12→1.0) — the rotation pool handed
  // it to floored scenes at random (m50 scene 5 got it), so even deterministic
  // floors could pan out. Troy: "the camera should not be panning out." Push only.
  { yaw: [-0.8, 0],   pitch: [-0.3, 0],  roll: 0,     zoom: [1.0, 1.1] },   // settling push
  { yaw: [-1.5, 1.5], pitch: [0, 0],     roll: 0.15,  zoom: [1.0, 1.07] },  // glide sweep R
  { yaw: [0, 0.6],    pitch: [0.45, -0.25], roll: 0,  zoom: [1.0, 1.15] }   // hero push, tilt up
];

/**
 * Render a homography-drift clip from a still photo.
 * Output matches the Veo-clip contract: width×height mp4, exact duration,
 * 30 fps, yuv420p — the normalize pass treats it like any other clip.
 */
export async function renderHomographyDrift({
  photoPath,
  outPath,
  durationSec,
  width = 720,
  height = 1280,
  roomType = "",
  sceneIndex = 0,
  cameraMotion = "push_in"
}) {
  const FPS = 30;
  const N = Math.max(24, Math.round(durationSec * FPS));
  const W = Math.round((width * 3) / 2 / 2) * 2; // 1.5x working res
  const H = Math.round((height * 3) / 2 / 2) * 2;

  // Room-aware principal point (square-crop findings, v35.2).
  const room = String(roomType || "").toLowerCase();
  const cyFrac = /exterior|outdoor|backyard|front|yard|patio|pool|garden|deck/.test(room)
    ? 0.56
    : room === "detail" || room === "amenity"
    ? 0.5
    : 0.45;
  const cx = W / 2;
  const cy = H * cyFrac;
  const f = W * 0.85; // ~wide interior lens

  const motion = String(cameraMotion || "push_in").toLowerCase();
  let mv = MOVES[(sceneIndex * 5 + 1) % MOVES.length];
  // v46: legacy pull_out motions render as the hero push — no backward moves.
  if (motion === "pull_out") mv = MOVES[5];
  else if (motion === "lateral_pan" || motion === "detail_sweep")
    mv = MOVES[sceneIndex % 2 === 0 ? 1 : 4];
  const flip = sceneIndex % 2 === 0 ? 1 : -1;

  const poseAt = (s, baseZoom) => poseToSampleMap({
    yaw: (mv.yaw[0] + (mv.yaw[1] - mv.yaw[0]) * s) * DEG * flip,
    pitch: (mv.pitch[0] + (mv.pitch[1] - mv.pitch[0]) * s) * DEG,
    roll: (mv.roll || 0) * s * DEG * flip,
    zoom: (mv.zoom[0] + (mv.zoom[1] - mv.zoom[0]) * s) * baseZoom,
    f, cx, cy
  });

  // Overscan guard: find the base zoom that keeps every sampled corner
  // inside the source across the whole move (coarse t sweep, then margin).
  let baseZoom = 1.0;
  for (let pass = 0; pass < 8; pass++) {
    let overflow = 0;
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      const s = t * t * (3 - 2 * t);
      const Hinv = poseAt(s, baseZoom);
      for (const [px, py] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) {
        const d = Hinv[6] * px + Hinv[7] * py + Hinv[8];
        const sx = (Hinv[0] * px + Hinv[1] * py + Hinv[2]) / d;
        const sy = (Hinv[3] * px + Hinv[4] * py + Hinv[5]) / d;
        overflow = Math.max(overflow, -sx, -sy, sx - (W - 1), sy - (H - 1));
      }
    }
    if (overflow <= 0.5) break;
    baseZoom *= 1 + (overflow / Math.max(W, H)) * 2.2 + 0.002;
  }

  // v44: attention-positioned crop (was default center). The 9:16 cover
  // crop of a 4:3 photo keeps only ~42% of its width — the luxury-demo
  // office photo's center was a bright mesh-shade window, so the floor
  // faithfully rendered 2.5s of featureless gray (m-lux 14.4–16.4s).
  // sharp's attention strategy targets the highest-detail region instead;
  // for normally-composed listing photos it lands within pixels of center.
  // v49: .rotate() (no-arg) applies EXIF orientation BEFORE the crop.
  // sharp ignores EXIF unless asked — iPhone portrait photos carry
  // orientation in metadata, so without this the floor warped sideways
  // pixels. Veo/fal auto-orients, which hid the bug until the 2026-07-16
  // fal outage sent an entire render (m55, first nudge-converted lead) to
  // the floor and shipped sideways scenes. QC can't catch it: the video
  // "matches" the photo because both are equally rotated.
  const photoPng = await sharp(photoPath)
    .rotate()
    .resize(W, H, { fit: "cover", position: sharp.strategy.attention })
    .png().toBuffer();
  const rgb = await sharp(photoPng).raw().toBuffer();
  const npx = W * H;
  const imgT = new Float32Array(3 * npx);
  for (let i = 0; i < npx; i++) {
    imgT[i] = rgb[i * 3];
    imgT[npx + i] = rgb[i * 3 + 1];
    imgT[2 * npx + i] = rgb[i * 3 + 2];
  }
  const warp = await warpSession();
  const imageTensor = new ort.Tensor("float32", imgT, [1, 3, H, W]);

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const ff = spawn("ffmpeg", [
    "-y", "-v", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
    "-t", String(durationSec),
    "-vf", `scale=${width}:${height}:flags=lanczos`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "superfast", "-crf", "19",
    "-r", String(FPS), outPath
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((resolve, reject) => {
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    ff.on("error", reject);
  });

  const grid = new Float32Array(npx * 2);
  const frame = Buffer.alloc(npx * 3);
  const xNorm = 2 / (W - 1), yNorm = 2 / (H - 1);
  for (let fIdx = 0; fIdx < N; fIdx++) {
    const t = fIdx / (N - 1);
    const s = t * t * (3 - 2 * t); // smoothstep ease
    const Hi = poseAt(s, baseZoom);
    // Row-incremental projective sampling: per pixel it's 3 adds + 2 divs.
    let gi = 0;
    for (let y = 0; y < H; y++) {
      let nx = Hi[1] * y + Hi[2];
      let ny = Hi[4] * y + Hi[5];
      let dn = Hi[7] * y + Hi[8];
      for (let x = 0; x < W; x++) {
        grid[gi++] = (nx / dn) * xNorm - 1;
        grid[gi++] = (ny / dn) * yNorm - 1;
        nx += Hi[0]; ny += Hi[3]; dn += Hi[6];
      }
    }
    const out = await warp.run({
      image: imageTensor,
      grid: new ort.Tensor("float32", grid, [1, H, W, 2])
    });
    const w = out.warped.data;
    for (let i = 0; i < npx; i++) {
      frame[i * 3] = w[i] < 0 ? 0 : w[i] > 255 ? 255 : w[i];
      frame[i * 3 + 1] = w[npx + i] < 0 ? 0 : w[npx + i] > 255 ? 255 : w[npx + i];
      frame[i * 3 + 2] = w[2 * npx + i] < 0 ? 0 : w[2 * npx + i] > 255 ? 255 : w[2 * npx + i];
    }
    if (!ff.stdin.write(frame)) {
      await new Promise((r) => ff.stdin.once("drain", r));
    }
  }
  ff.stdin.end();
  await ffDone;
  return outPath;
}

// Bench entries:
//   node homography-drift.mjs selftest <photo> <out.mp4> [motion] [sceneIndex]
//   node homography-drift.mjs gridtest <out.png> [sceneIndex]   (line-straightness proof)
if (process.argv[2] === "selftest") {
  const t0 = Date.now();
  await renderHomographyDrift({
    photoPath: process.argv[3],
    outPath: process.argv[4],
    durationSec: Number(process.env.SELFTEST_DUR) || 2.2,
    cameraMotion: process.argv[5] || "push_in",
    sceneIndex: Number(process.argv[6]) || 0,
    roomType: "kitchen"
  });
  console.log(`[homography-drift] selftest done in ${Date.now() - t0}ms → ${process.argv[4]}`);
} else if (process.argv[2] === "gridtest") {
  const W = 1080, H = 1920;
  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="100%" height="100%" fill="#18181c"/>` +
    Array.from({ length: Math.ceil(W / 60) }, (_, i) =>
      `<line x1="${i * 60}" y1="0" x2="${i * 60}" y2="${H}" stroke="#c8c8d2" stroke-width="3"/>`).join("") +
    Array.from({ length: Math.ceil(H / 60) }, (_, i) =>
      `<line x1="0" y1="${i * 60}" x2="${W}" y2="${i * 60}" stroke="#c8c8d2" stroke-width="3"/>`).join("") +
    `</svg>`
  );
  const tmp = "/tmp/hg-grid-src.png";
  await sharp(svg).png().toFile(tmp);
  const out = process.argv[3] || "/tmp/hg-gridtest.mp4";
  await renderHomographyDrift({
    photoPath: tmp,
    outPath: out,
    durationSec: 2.0,
    sceneIndex: Number(process.argv[4]) || 0
  });
  console.log(`[homography-drift] gridtest → ${out} (every line must stay straight)`);
}
