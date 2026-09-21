// Vistalia — 2.5D depth-parallax photo motion (v64).
//
// Node side of tools/parallax.py: crops the customer's photo to the delivery
// aspect (EXIF-rotated, attention-positioned, 1.5x supersampled like the
// homography floor), runs the Python renderer, parses its JSON summary and
// hands back a clip in the same shape generateKenBurnsFallback returns.
//
// Why a Python sidecar and not Node: the warp is dense per-pixel work
// (layered inverse mapping with a z-test, Lanczos resampling) — numpy/OpenCV
// do a 1080x1920 frame in ~0.3s; the same loops in JS are 5-10x slower and
// the depth model already runs through onnxruntime either way. The Docker
// image installs python3 + numpy + opencv-contrib-headless + onnxruntime and
// downloads the Depth Anything V2 small ONNX at build time (see Dockerfile).
//
// Where it sits (Sep-21 stage-2 bake-off, MODEL_BAKEOFF_SEP2026.md §4b): on
// 9:16 production crops no hosted image-to-video API gives a controlled
// camera — MiniMax's numeric trajectory is ignored on vertical input, Kling
// v3 Pro pushes 9-37% against an 8% ask, Wan flickers. Depth parallax gives
// an EXACT 6-8% dolly at native resolution with zero hallucination; the
// trade is no "living" elements (sky, water, fire). So:
//
//   PARALLAX_MODE=off       never (v63 behaviour)
//   PARALLAX_MODE=floor     replaces homography-drift as the QC floor only
//   PARALLAX_MODE=interior  (default once shipped) primary engine for interior
//                           room types — no fal spend, no QC ladder; exteriors,
//                           pools, twilight keep the generative engine + floor
//   PARALLAX_MODE=all       primary engine for every scene
//
// Every failure fails CLOSED to the existing floor (homography drift), so a
// broken Python on the host can never drop a scene.

import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = path.join(HERE, "..", "tools", "parallax.py");
const MODEL_PATH = process.env.PARALLAX_MODEL_PATH || path.join(HERE, "..", "models", "dav2_small.onnx");
const PYTHON = process.env.PARALLAX_PYTHON || "python3";
const SUPERSAMPLE = Math.min(2, Math.max(1, Number(process.env.PARALLAX_SUPERSAMPLE) || 1.5));
const FPS = 30;

export const PARALLAX_MODES = ["off", "floor", "interior", "all"];

export function parallaxMode() {
  const m = String(process.env.PARALLAX_MODE || "off").toLowerCase().trim();
  return PARALLAX_MODES.includes(m) ? m : "off";
}

// Room types whose photos are rigid architecture — where a hallucinated
// cabinet or a 30% push is the complaint and "living" motion adds nothing.
const INTERIOR_RE = /kitchen|bath|bedroom|primary|living|family|great|dining|office|den|laundry|closet|hall|entry|foyer|loft|bonus|game|media|theater|gym|garage|basement|interior|amenity|detail|room/i;
const EXTERIOR_RE = /exterior|outdoor|backyard|front|yard|patio|pool|garden|deck|twilight|aerial|drone|street|view|balcony|courtyard/i;

/** "primary" (render with parallax, skip fal), "floor" (fal first, parallax as the floor), or "off". */
export function parallaxPolicy(scene = {}) {
  const mode = parallaxMode();
  if (mode === "off") return "off";
  if (mode === "floor") return "floor";
  if (mode === "all") return "primary";
  const room = String(scene.roomType || "").toLowerCase();
  if (EXTERIOR_RE.test(room)) return "floor";
  if (INTERIOR_RE.test(room)) return "primary";
  // unknown room type: photographers' galleries are mostly interiors, and a
  // wrong guess here costs a "living" sky, not a hallucinated cabinet.
  return "primary";
}

// Choreography: push only (v46, Troy: "the camera should not be panning
// out"), varied by a small yaw/pitch drift — a rotation is exact for any
// depth (no disocclusion), so it adds life without adding artefacts. Trucks
// wait for a better plate inpainter (Sep-21 note in tools/parallax.py).
const MOVES = [
  { zoom: 1.07, yaw: 0.0, pitch: 0.0 },     // clean push
  { zoom: 1.06, yaw: 0.45, pitch: -0.15 },  // push + slow turn right
  { zoom: 1.08, yaw: 0.0, pitch: 0.2 },     // hero push, tilt up
  { zoom: 1.06, yaw: -0.45, pitch: -0.15 }, // push + slow turn left
  { zoom: 1.07, yaw: 0.25, pitch: 0.0 },    // push, settle right
  { zoom: 1.07, yaw: -0.25, pitch: 0.1 }    // push, settle left
];

export function parallaxMove(sceneIndex = 0, cameraMotion = "push_in") {
  const motion = String(cameraMotion || "push_in").toLowerCase();
  let mv = MOVES[(sceneIndex * 5 + 1) % MOVES.length];
  if (motion === "pull_out") mv = MOVES[2];               // legacy pull-outs render as the hero push
  else if (motion === "lateral_pan" || motion === "detail_sweep") mv = MOVES[sceneIndex % 2 === 0 ? 1 : 3];
  // longer scenes get a touch more travel so per-second velocity stays visible (v62.35 idea, capped)
  return mv;
}

/** Parse the renderer's stdout: the last "[parallax] {...}" line is the summary. */
export function parseParallaxSummary(stdout = "") {
  const lines = String(stdout).split(/\r?\n/).filter((l) => l.startsWith("[parallax] {"));
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1].slice("[parallax] ".length)); } catch { return null; }
}

let availabilityPromise = null;
/** One probe per process: python + deps + model present. Cached. */
export function parallaxAvailable() {
  if (!availabilityPromise) {
    availabilityPromise = runPython(["--check", "--model", MODEL_PATH], { timeoutMs: 60000 })
      .then((r) => {
        const s = parseParallaxSummary(r.stdout);
        if (!s?.ok) {
          console.warn(`[parallax] unavailable: ${s?.error || r.stderr?.slice(0, 200) || `exit ${r.code}`}`);
          return false;
        }
        console.info(`[parallax] ready: python ${s.python}, cv2 ${s.cv2}, onnxruntime ${s.onnxruntime}, model ${path.basename(s.model)}`);
        return true;
      })
      .catch((err) => { console.warn(`[parallax] unavailable: ${err.message}`); return false; });
  }
  return availabilityPromise;
}

function runPython(args, { timeoutMs = 600000, label = "parallax" } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    let child;
    try {
      child = spawn(PYTHON, [TOOL_PATH, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OMP_NUM_THREADS: process.env.PARALLAX_THREADS || "2" } });
    } catch (err) {
      return reject(err);
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// One render at a time per worker: the warp is CPU-bound on every core it
// can get, so two in parallel just take twice as long each and starve the
// fal pMap's ffmpeg normalize passes.
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * Render a parallax clip from a still photo.
 * Output matches the floor/Veo clip contract: width x height mp4, exact
 * duration, 30 fps, yuv420p.
 */
export async function renderParallax({
  photoPath,
  outPath,
  durationSec,
  width = 1080,
  height = 1920,
  roomType = "",
  sceneIndex = 0,
  cameraMotion = "push_in",
  timeoutMs = 600000
}) {
  if (!(await parallaxAvailable())) throw new Error("parallax renderer unavailable on this host");
  const duration = Math.min(12, Math.max(1.6, Number(durationSec) || 5));
  const move = parallaxMove(sceneIndex, cameraMotion);
  const W = Math.round(width * SUPERSAMPLE / 2) * 2;
  const H = Math.round(height * SUPERSAMPLE / 2) * 2;

  // Same crop discipline as the homography floor (v44 attention crop, v49
  // EXIF rotate) so a floored and a parallax scene of the same photo frame
  // the same pixels.
  const sharp = (await import("sharp")).default;
  const srcPng = `${outPath}.src.png`;
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(photoPath)
    .rotate()
    .resize(W, H, { fit: "cover", position: sharp.strategy.attention })
    .png({ compressionLevel: 3 })
    .toFile(srcPng);

  const args = [
    "--src", srcPng, "--out", outPath,
    "--seconds", duration.toFixed(3), "--fps", String(FPS),
    "--out-size", `${width}x${height}`,
    "--zoom", String(move.zoom), "--yaw", String(move.yaw), "--pitch", String(move.pitch),
    "--model", MODEL_PATH
  ];
  if (process.env.PARALLAX_MAP_EVERY) args.push("--map-every", String(process.env.PARALLAX_MAP_EVERY));
  if (process.env.PARALLAX_LAYERS) args.push("--layers", String(process.env.PARALLAX_LAYERS));
  if (process.env.PARALLAX_NEAR_RATIO) args.push("--near-ratio", String(process.env.PARALLAX_NEAR_RATIO));

  const t0 = Date.now();
  try {
    const r = await serialize(() => runPython(args, { timeoutMs, label: `parallax scene ${sceneIndex + 1}` }));
    const summary = parseParallaxSummary(r.stdout);
    if (r.code !== 0 || !summary?.ok) {
      throw new Error(`parallax exited ${r.code}: ${summary?.error || r.stderr.trim().split("\n").pop() || "no summary"}`);
    }
    const st = await fsp.stat(outPath).catch(() => null);
    if (!st || st.size < 20000) throw new Error(`parallax wrote ${st ? st.size : 0} bytes`);
    console.info(
      `[parallax] scene ${sceneIndex + 1} (${roomType || "?"}): ${duration}s zoom ${move.zoom} yaw ${move.yaw} pitch ${move.pitch} ` +
      `— ${summary.elapsed_s}s, lines ${summary.lines_regularised}, bend p95 ${summary.bend_p95_px}px max ${summary.bend_max_px}px, ` +
      `holes ${summary.mean_hole_px}px/frame (${((Date.now() - t0) / 1000).toFixed(1)}s wall)`
    );
    return { outPath, duration, move, summary };
  } finally {
    await fsp.unlink(srcPng).catch(() => {});
  }
}

// Bench: node src/parallax-job.mjs selftest <photo> <out.mp4> [seconds] [sceneIndex] [WxH]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "selftest") {
  const [photo, out, sec, idx, size] = process.argv.slice(3);
  const [w, h] = String(size || "1080x1920").split("x").map(Number);
  const t0 = Date.now();
  const r = await renderParallax({ photoPath: photo, outPath: out, durationSec: Number(sec) || 3, sceneIndex: Number(idx) || 0, width: w, height: h, roomType: "kitchen" });
  console.log(`[parallax] selftest done in ${Date.now() - t0}ms → ${out}`, JSON.stringify(r.summary));
}
