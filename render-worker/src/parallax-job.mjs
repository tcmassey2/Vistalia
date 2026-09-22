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
const LAMA_PATH = process.env.PARALLAX_LAMA_PATH || path.join(HERE, "..", "models", "lama_fp32.onnx");
const PYTHON = process.env.PARALLAX_PYTHON || "python3";
const SUPERSAMPLE = Math.min(2.5, Math.max(1, Number(process.env.PARALLAX_SUPERSAMPLE) || 1.75));
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
//
// v64.2 VELOCITY (Sep-22 smoke test): the first production render put four
// interiors on parallax at a fixed 6-8% push and the slideshow guard read
// them at YDIF 0.29-0.88 — "floor" territory, the same slow drift Troy called
// "a little brutal" on long hero scenes (v62.35/v62.67). The palette below
// is a TOTAL displacement at a 3.5 s reference, scaled by duration so the
// per-frame camera speed stays constant (the v39 floor's rule, gain capped
// at 2.2), and it lands where the pipeline's own floor already lives
// (zoom 1.13 + 1.5° at 3.5 s). The push is exact and hallucination-free, so
// the only budget is resolution: the crop is 1.75× supersampled and the
// zoom is capped at PARALLAX_ZOOM_MAX (1.30) so the last frame still
// samples ≥ 1.3 source px per output px. PARALLAX_VELOCITY scales it all.
const REF_DURATION_SEC = 3.5;
// v64.3 LIVING PARALLAX (Troy, Sep 22: "misses the level of movement Reel-E
// is able to feature"). Reel-E's look is lateral: the foreground slides
// across the background. Two things unlocked it — the crop now carries real
// photo beyond the frame edge (MARGIN_X/Y, so a truck reveals the room, not
// a zoom), and the revealed strip is inpainted once per scene with LaMa
// (tools/parallax.py --lama). Amplitudes are frame px at the NEAREST pixel
// over a 3.5 s reference and scale with duration like the push; an "arc"
// is a truck plus the yaw that keeps the mid-depth centre framed.
const MOVES = [                                   // index (i*5+1)%6: scene 1 → arc-right, 2 → push, 3 → truck-left, 4 → truck-right, 5 → hero-push, 6 → arc-left
  { name: "push",       zoom: 1.13, truckX: 0,   truckY: 0,   arc: false, yaw: 0.0,  pitch: 0.0 },
  { name: "arc-right",  zoom: 1.08, truckX: 80,  truckY: 0,   arc: true,  yaw: 0.0,  pitch: 0.0 },
  { name: "arc-left",   zoom: 1.08, truckX: -80, truckY: 0,   arc: true,  yaw: 0.0,  pitch: 0.0 },
  { name: "hero-push",  zoom: 1.15, truckX: 0,   truckY: -18, arc: false, yaw: 0.0,  pitch: 0.3 },
  { name: "truck-right", zoom: 1.06, truckX: 70, truckY: 0,   arc: false, yaw: 0.0,  pitch: 0.0 },
  { name: "truck-left", zoom: 1.06, truckX: -70, truckY: 0,   arc: false, yaw: 0.0,  pitch: 0.0 }
];
const zoomMax = () => Math.min(1.45, Math.max(1.08, Number(process.env.PARALLAX_ZOOM_MAX) || 1.30));
const velocity = () => Math.min(2.5, Math.max(0.4, Number(process.env.PARALLAX_VELOCITY) || 1.0));
const lateral = () => {
  const v = process.env.PARALLAX_LATERAL;
  if (v == null || String(v).trim() === "") return 1.0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(2.5, Math.max(0, n)) : 1.0;
};
const TRUCK_MAX = 140;   // frame px at the nearest pixel — beyond this the reveal strips outgrow what a plate can fake

export function parallaxMove(sceneIndex = 0, cameraMotion = "push_in", durationSec = REF_DURATION_SEC) {
  const ZOOM_MAX = zoomMax();
  const VELOCITY = velocity();
  const LATERAL = lateral();
  const motion = String(cameraMotion || "push_in").toLowerCase();
  let mv = MOVES[(sceneIndex * 5 + 1) % MOVES.length];
  if (motion === "pull_out") mv = MOVES[3];               // legacy pull-outs render as the hero push
  else if (motion === "lateral_pan" || motion === "detail_sweep") mv = MOVES[sceneIndex % 2 === 0 ? 1 : 2];
  if (LATERAL === 0 && mv.truckX !== 0) mv = MOVES[0];    // PARALLAX_LATERAL=0: push-only (v64.2 behaviour)
  const dur = Number(durationSec) > 0 ? Number(durationSec) : REF_DURATION_SEC;
  const gain = Math.min(2.2, Math.max(0.6, dur / REF_DURATION_SEC)) * VELOCITY;
  const zoom = Math.min(ZOOM_MAX, +(1 + (mv.zoom - 1) * gain).toFixed(3));
  const rot = Math.min(1.6, gain);
  const lat = Math.min(1.8, gain) * LATERAL;
  const truckX = Math.max(-TRUCK_MAX, Math.min(TRUCK_MAX, Math.round(mv.truckX * lat)));
  const truckY = Math.max(-60, Math.min(60, Math.round(mv.truckY * lat)));
  return { name: mv.name, zoom, truckX, truckY, arc: Boolean(mv.arc) && truckX !== 0, yaw: +(mv.yaw * rot).toFixed(2), pitch: +(mv.pitch * rot).toFixed(2), gain: +gain.toFixed(2) };
}

// How much photo to keep beyond the frame edge, as a fraction of the frame,
// when the photo has it: a truck of TRUCK_MAX px needs ~13% of the width.
const MARGIN_X_FRAC = Math.min(0.3, Math.max(0, Number(process.env.PARALLAX_MARGIN_X) || 0.13));
const MARGIN_Y_FRAC = Math.min(0.3, Math.max(0, Number(process.env.PARALLAX_MARGIN_Y) || 0.05));

/**
 * Attention-positioned frame crop + as much symmetric margin as the photo
 * has around it. Returns the source PNG path plus the margins in frame px.
 */
export async function prepareSource(photoPath, srcPng, { width, height, move, supersample = SUPERSAMPLE }) {
  const sharp = (await import("sharp")).default;
  const oriented = await sharp(photoPath).rotate().toBuffer();
  const meta = await sharp(oriented).metadata();
  const pw = meta.width, ph = meta.height;
  const aspect = width / height;
  // the frame's crop rectangle at photo scale (cover), positioned by attention
  let cw = Math.round(ph * aspect), ch = ph;
  if (cw > pw) { cw = pw; ch = Math.round(pw / aspect); }
  const probe = await sharp(oriented).resize(cw, ch, { fit: "cover", position: sharp.strategy.attention }).toBuffer({ resolveWithObject: true });
  let left = Number(probe.info.cropOffsetLeft) || 0, top = Number(probe.info.cropOffsetTop) || 0;
  // sharp reports offsets as negative extract positions in some versions
  left = Math.abs(left); top = Math.abs(top);
  left = Math.max(0, Math.min(pw - cw, left)); top = Math.max(0, Math.min(ph - ch, top));
  // margins the move actually wants (frame px), then what the photo can give (photo px), symmetric
  const wantX = move.truckX !== 0 || move.arc || Math.abs(move.yaw) > 0 ? MARGIN_X_FRAC : 0.04;
  const wantY = move.truckY !== 0 || Math.abs(move.pitch) > 0 ? MARGIN_Y_FRAC : 0.02;
  // symmetric margins: take what the photo can give, and slide the frame
  // inward (away from the photo edge) by up to that margin so a truck at the
  // edge of the photo still reveals real pixels on both sides
  const mxPhoto = Math.floor(Math.min(wantX * cw, (pw - cw) / 2));
  const myPhoto = Math.floor(Math.min(wantY * ch, (ph - ch) / 2));
  left = Math.max(mxPhoto, Math.min(pw - cw - mxPhoto, left));
  top = Math.max(myPhoto, Math.min(ph - ch - myPhoto, top));
  const scale = width / cw;                      // photo px -> frame px
  const mx = Math.max(0, Math.floor(mxPhoto * scale)), my = Math.max(0, Math.floor(myPhoto * scale));
  const canvasW = width + 2 * mx, canvasH = height + 2 * my;
  const srcW = Math.round(canvasW * supersample / 2) * 2, srcH = Math.round(canvasH * supersample / 2) * 2;
  const exW = Math.round(canvasW / scale), exH = Math.round(canvasH / scale);
  const exLeft = Math.max(0, Math.min(pw - exW, Math.round(left + cw / 2 - exW / 2)));
  const exTop = Math.max(0, Math.min(ph - exH, Math.round(top + ch / 2 - exH / 2)));
  await sharp(oriented)
    .extract({ left: exLeft, top: exTop, width: Math.min(exW, pw - exLeft), height: Math.min(exH, ph - exTop) })
    .resize(srcW, srcH, { fit: "fill" })
    .png({ compressionLevel: 3 })
    .toFile(srcPng);
  return { mx, my, canvasW, canvasH, srcW, srcH, photo: { pw, ph, left, top, cw, ch } };
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
    availabilityPromise = runPython(["--check", "--model", MODEL_PATH, "--lama", LAMA_PATH], { timeoutMs: 60000 })
      .then((r) => {
        const s = parseParallaxSummary(r.stdout);
        if (!s?.ok) {
          console.warn(`[parallax] unavailable: ${s?.error || r.stderr?.slice(0, 200) || `exit ${r.code}`}`);
          return false;
        }
        console.info(`[parallax] ready: python ${s.python}, cv2 ${s.cv2}, onnxruntime ${s.onnxruntime}, depth ${path.basename(s.model)}, plate ${s.lama_present ? "lama" : "telea (no LaMa model)"}`);
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
  const move = parallaxMove(sceneIndex, cameraMotion, duration);

  // Same crop discipline as the homography floor (v44 attention crop, v49
  // EXIF rotate), plus real photo beyond the frame edge for lateral moves.
  const srcPng = `${outPath}.src.png`;
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const src = await prepareSource(photoPath, srcPng, { width, height, move });

  const args = [
    "--src", srcPng, "--out", outPath,
    "--seconds", duration.toFixed(3), "--fps", String(FPS),
    "--out-size", `${width}x${height}`, "--margin", `${src.mx},${src.my}`,
    "--zoom", String(move.zoom), "--truck-x", String(move.truckX), "--truck-y", String(move.truckY),
    "--yaw", String(move.yaw), "--pitch", String(move.pitch),
    "--model", MODEL_PATH, "--lama", LAMA_PATH
  ];
  if (move.arc) args.push("--arc");
  if (process.env.PARALLAX_MAP_EVERY) args.push("--map-every", String(process.env.PARALLAX_MAP_EVERY));
  if (process.env.PARALLAX_LAYERS) args.push("--layers", String(process.env.PARALLAX_LAYERS));
  // stronger depth separation on lateral moves (the plate now carries the reveal)
  args.push("--near-ratio", String(Number(process.env.PARALLAX_NEAR_RATIO) || (move.truckX !== 0 ? 4 : 3)));

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
      `[parallax] scene ${sceneIndex + 1} (${roomType || "?"}): ${move.name} ${duration}s zoom ${move.zoom} truck ${move.truckX},${move.truckY}${move.arc ? " arc" : ""} yaw ${summary.yaw ?? move.yaw} pitch ${move.pitch} (gain ${move.gain}, margin ${src.mx},${src.my}) ` +
      `— ${summary.elapsed_s}s, plate ${summary.plate} ${summary.plate_tiles} tiles ${summary.plate_s}s, lines ${summary.lines_regularised}, bend p95 ${summary.bend_p95_px}px max ${summary.bend_max_px}px, ` +
      `holes ${summary.mean_hole_px}px/frame, oob ${summary.oob_last_px} (${((Date.now() - t0) / 1000).toFixed(1)}s wall)`
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
