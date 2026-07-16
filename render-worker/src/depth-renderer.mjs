// Vistalia — Depth-based parallax renderer (Path B core).
//
// Takes a photo + its depth map + a virtual camera path. Produces an MP4
// clip of the virtual camera moving through the 3D scene reconstructed
// from the depth.
//
// PIPELINE
//   1. Decode photo to RGBA pixel buffer (sharp).
//   2. Decode depth map to grayscale buffer (sharp).
//   3. Build a vertex-displaced plane mesh: each vertex's z is set from
//      the depth at the corresponding pixel. Texture-map the photo.
//   4. Animate a Three.js PerspectiveCamera along the requested path.
//   5. For each frame: render, gl.readPixels, pipe raw RGBA to ffmpeg
//      stdin (vflip filter because GL origin is bottom-left, video is
//      top-left).
//
// WHY WE OWN STEPS 3-5
//   The geometric pipeline is a few hundred lines of math. Owning it
//   means: exact camera moves (no Runway shake), zero hallucination on
//   the original pixels, full control over per-room camera profiles,
//   and per-render compute drops to ~$0.02-0.06 (vs Runway's $9.60).
//
// THE MESH
//   For a HxW photo we build a (H/STEP)x(W/STEP) vertex grid. STEP=4
//   gives a ~480x270 grid for a 1920x1080 photo (~130K vertices) which
//   renders in <50ms per frame and looks smooth. Lower STEP = higher
//   fidelity at object boundaries, higher GPU cost.
//
// CAMERA PATH FORMAT
//   Array of keyframes: [{ t: 0, position: [x,y,z], target: [x,y,z], fov: 50 }, ...]
//   t is normalized 0-1. Frames are interpolated linearly between
//   adjacent keyframes (linear is fine for the modest moves real estate
//   needs; switch to Catmull-Rom if we want curvier paths later).
//
// DISOCCLUSION MASKS (RETURNED, NOT FILLED)
//   We return both the rendered RGBA frames AND per-frame masks marking
//   pixels that had no source data (disoccluded — revealed area behind
//   foreground). The orchestrator (depth-job.mjs) sends each frame +
//   mask to Replicate's inpainter to clean those gaps before stitching.

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

// gl + three are OPTIONAL dependencies. They require X11 dev libraries
// (libxi-dev, libxext-dev, libx11-dev, libglu1-mesa-dev, libglew-dev,
// pkg-config) that aren't preinstalled on Render's native build runtime.
// Lazy-imported so the worker boots successfully even when those system
// libs are missing — Runway and Quick Reel keep working; only the depth
// engine errors out at render time with a clear message.
let createGL = null;
let THREE = null;
let glLoadError = null;

async function ensureGlLoaded() {
  if (createGL && THREE) return;
  if (glLoadError) throw glLoadError;
  try {
    // Three.js's WebGLRenderer reaches for browser globals during
    // construction AND cleanup: requestAnimationFrame /
    // cancelAnimationFrame for its internal animation loop, plus
    // window / document / self for various capability checks. In
    // headless Node these are all undefined, which surfaces as
    // 'Cannot read properties of null (reading cancelAnimationFrame)'
    // when renderer.dispose() runs. Shimming them BEFORE the three
    // import lets Three's static initialization succeed cleanly.
    if (typeof globalThis.requestAnimationFrame !== "function") {
      globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
      globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }
    if (typeof globalThis.window === "undefined") {
      globalThis.window = globalThis;
    }
    if (typeof globalThis.self === "undefined") {
      globalThis.self = globalThis;
    }
    if (typeof globalThis.document === "undefined") {
      // Minimal document shim — Three only touches createElementNS for
      // SVG capability checks and a few property reads. Returning empty
      // objects satisfies those without breaking anything.
      globalThis.document = {
        createElement: () => ({ style: {}, getContext: () => null }),
        createElementNS: () => ({ style: {} }),
        addEventListener: () => {},
        removeEventListener: () => {}
      };
    }

    const glMod = await import("gl");
    createGL = glMod.default || glMod;
    const threeMod = await import("three");
    THREE = threeMod;
  } catch (err) {
    glLoadError = new Error(
      "Cinematic Depth can't run because the worker is missing the 'gl' or 'three' native modules. " +
      "On Render.com: switch the worker's Build Command to " +
      "`apt-get update && apt-get install -y libxi-dev libxext-dev libx11-dev libglu1-mesa-dev libglew-dev pkg-config && npm install` " +
      "(or use the Dockerfile in render-worker/, which already installs these). " +
      `Underlying error: ${err.message}`
    );
    throw glLoadError;
  }
}

const DEFAULT_STEP = 4;        // mesh vertex spacing in source-photo pixels
const DEFAULT_FOV = 50;        // degrees, photographic look
const NEAR = 0.1;
const FAR = 100;

/* ============================================================
   Public entry: renderDepthClip
   ============================================================
   Inputs:
     photoPath        — local PNG/JPG file
     depthPath        — local grayscale PNG (0=near, 255=far) at any resolution
     cameraPath       — array of { t, position:[x,y,z], target:[x,y,z], fov? }
     dimensions       — { width, height } of the output video
     frameRate        — int (24, 30, 60)
     durationSec      — float
     outPath          — where to write the MP4 (skipped if writeFramesDir is set)
     vertexStep?      — int (default 4); lower = more vertices, smoother boundaries
     writeFramesDir?  — string: when set, also writes frame-NNN.png +
                        mask-NNN.png per frame to this dir. Used by Phase 2
                        inpainting pipeline to fill disocclusion gaps before
                        stitching the final clip. Masks are PNG: white = no
                        source data (inpaint here), black = keep original.
   Returns:
     { outPath, framesRendered, durationSec, framesDir? }
*/
export async function renderDepthClip({
  photoPath,
  depthPath,
  cameraPath,
  dimensions,
  frameRate = 24,
  durationSec,
  outPath,
  vertexStep = DEFAULT_STEP,
  writeFramesDir = null
}) {
  const { width, height } = dimensions;
  if (!width || !height) throw new Error("renderDepthClip: dimensions.width/height required");
  if (!cameraPath?.length) throw new Error("renderDepthClip: cameraPath empty");

  // Lazy-load gl + three. Fails with clear apt-get message if missing.
  await ensureGlLoaded();

  // ---- Decode inputs ---------------------------------------------------
  // Photo: full-resolution RGBA buffer. We size it to (width, height) so
  // the texture exactly matches the output framebuffer (no scaling in
  // the shader).
  const { data: photoRgba, info: photoInfo } = await sharp(photoPath)
    .rotate() // v49: apply EXIF orientation — see homography-drift.mjs
    .resize(width, height, { fit: "cover" })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  // Depth: resize to the mesh grid resolution and convert to grayscale.
  // Mesh resolution is (width/step) x (height/step). A 1920x1080 video
  // with step=4 gives a 480x270 mesh — 130K vertices, fast and smooth.
  const meshW = Math.max(2, Math.floor(width / vertexStep));
  const meshH = Math.max(2, Math.floor(height / vertexStep));
  const { data: depthGray } = await sharp(depthPath)
    .resize(meshW, meshH, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // ---- WebGL context ---------------------------------------------------
  const gl = createGL(width, height, { preserveDrawingBuffer: true, antialias: true });
  if (!gl) throw new Error("renderDepthClip: failed to create headless WebGL context (gl package)");

  // WebGL 2 method stubs. The `gl` npm package implements WebGL 1 only,
  // but some Three.js code paths assume WebGL 2 even when handed a
  // WebGL 1 context. Stubbing the most-commonly-called WebGL 2 methods
  // as no-ops prevents 'X is not a function' crashes — Three's basic
  // 2D-textured-plane rendering doesn't actually need any of these,
  // so no-ops are functionally correct for our pipeline. We rely on
  // the three@0.158 pin (last version with full WebGL 1 fallback
  // paths) to avoid the bulk of WebGL 2 calls in the first place;
  // these stubs are belt-and-suspenders.
  const webgl2Stubs = [
    "texImage3D", "texSubImage3D", "texStorage3D",
    "copyTexSubImage3D", "compressedTexImage3D", "compressedTexSubImage3D",
    "texStorage2D", "drawArraysInstanced", "drawElementsInstanced",
    "vertexAttribDivisor", "createVertexArray", "bindVertexArray",
    "deleteVertexArray", "getFragDataLocation", "uniformBlockBinding",
    "bindBufferBase", "bindBufferRange", "drawBuffers", "renderbufferStorageMultisample"
  ];
  for (const name of webgl2Stubs) {
    if (typeof gl[name] !== "function") gl[name] = () => {};
  }

  // Three.js renderer wrapped around the headless context. We have to
  // shim a tiny bit of canvas-like state because Three pokes at it.
  const fakeCanvas = {
    width,
    height,
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => gl
  };
  const renderer = new THREE.WebGLRenderer({
    context: gl,
    canvas: fakeCanvas,
    antialias: true,
    preserveDrawingBuffer: true
  });
  renderer.setSize(width, height, false);
  // Magenta clear so disocclusion gaps (areas with no source pixels after
  // camera move) are detectable in post: any pixel still pure magenta
  // (255, 0, 255) after render = needs inpainting. The mesh texture covers
  // all original pixels, so magenta only survives in genuine gaps.
  renderer.setClearColor(0xff00ff, 1.0);

  // ---- Build the depth-displaced mesh ---------------------------------
  // Mesh is a (meshW x meshH) grid. Each vertex sits at its 2D image
  // position (normalized to [-1, 1] x, [-1, 1] y) and is displaced
  // backward along z by its depth value.
  const photoTexture = new THREE.DataTexture(
    photoRgba,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  photoTexture.flipY = true; // sharp produces top-left origin; Three expects bottom-left
  photoTexture.needsUpdate = true;
  photoTexture.minFilter = THREE.LinearFilter;
  photoTexture.magFilter = THREE.LinearFilter;

  // The plane spans x in [-aspect, +aspect] and y in [-1, +1] so when
  // the camera is at z=1 looking at origin with the default FOV, the
  // plane fills the frame.
  const aspect = width / height;
  const planeWorldW = 2 * aspect;
  const planeWorldH = 2;

  // PlaneGeometry: meshW segments wide, meshH segments tall. Vertices
  // come out in row-major order starting top-left.
  const geometry = new THREE.PlaneGeometry(
    planeWorldW,
    planeWorldH,
    meshW - 1,
    meshH - 1
  );

  // Displace each vertex z by its corresponding depth pixel. Depth value
  // is normalized to [0, 1] then scaled by DEPTH_AMPLITUDE to control
  // how strong the parallax is. Larger amplitude = more dramatic
  // parallax but bigger disocclusion holes. 0.35 is a reasonable
  // starting point for real-estate stills.
  const DEPTH_AMPLITUDE = 0.35;
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    // Three.js PlaneGeometry vertices are emitted row-by-row, but in
    // bottom-up order (y starts at +half, decreases). We need to read
    // the depth pixel from the corresponding (col, row) accounting for
    // that flip.
    const col = i % meshW;
    const rowFromTop = Math.floor(i / meshW);
    const rowFromBottom = (meshH - 1) - rowFromTop;
    const depthIdx = rowFromBottom * meshW + col;
    const depthByte = depthGray[depthIdx] ?? 128;
    // depth 0 = near (push toward camera, negative z), 255 = far (push
    // away from camera, deeper into scene). We invert so the foreground
    // pops forward.
    const depthNorm = depthByte / 255; // 0..1, 0=near
    const zDisplace = -(1 - depthNorm) * DEPTH_AMPLITUDE; // near pixels pop forward
    positions.setZ(i, zDisplace);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    map: photoTexture,
    side: THREE.FrontSide
  });
  const mesh = new THREE.Mesh(geometry, material);

  const scene = new THREE.Scene();
  scene.add(mesh);

  // ---- Camera ----------------------------------------------------------
  const initialFov = cameraPath[0]?.fov ?? DEFAULT_FOV;
  const camera = new THREE.PerspectiveCamera(initialFov, aspect, NEAR, FAR);

  // ---- Output mode selection ------------------------------------------
  // Two modes:
  //   (A) Default: pipe raw RGBA to ffmpeg stdin, write MP4. Fast.
  //   (B) Phase 2 inpaint: write per-frame frame.png + mask.png so the
  //       orchestrator can run an inpaint pass before stitching.
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  if (writeFramesDir) await fs.mkdir(writeFramesDir, { recursive: true });

  const totalFrames = Math.max(1, Math.round(frameRate * durationSec));

  let ff = null;
  let ffErr = "";
  let ffDone = null;
  if (!writeFramesDir) {
    const ffArgs = [
      "-y",
      "-loglevel", "error",
      "-f", "rawvideo",
      "-pixel_format", "rgba",
      "-video_size", `${width}x${height}`,
      "-framerate", String(frameRate),
      "-i", "pipe:0",
      "-vf", "vflip",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "veryfast",
      "-crf", "20",
      "-movflags", "+faststart",
      outPath
    ];
    ff = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "ignore", "pipe"] });
    ff.stderr.on("data", (chunk) => { ffErr += chunk.toString(); });
    ffDone = new Promise((resolve, reject) => {
      ff.on("close", (code) => {
        if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${ffErr.slice(0, 400)}`));
        else resolve();
      });
      ff.on("error", reject);
    });
  }

  // ---- Render loop -----------------------------------------------------
  const pixelBuf = Buffer.alloc(width * height * 4);
  const pixelView = new Uint8Array(pixelBuf.buffer);

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      const t = totalFrames === 1 ? 0 : frame / (totalFrames - 1);
      applyCameraAtT(camera, cameraPath, t);

      renderer.render(scene, camera);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixelView);

      if (writeFramesDir) {
        // Phase 2 path: write a frame PNG + a disocclusion mask PNG. The
        // mask is white at any pixel that's still pure magenta (no source
        // data) and black everywhere else. Inpainter fills the white.
        // We flip Y here (gl bottom-left → image top-left) so the saved
        // PNG matches what ffmpeg would produce in the direct-pipe path.
        const padded = String(frame).padStart(4, "0");
        const framePath = path.join(writeFramesDir, `frame-${padded}.png`);
        const maskPath = path.join(writeFramesDir, `mask-${padded}.png`);

        // Build mask buffer in parallel: 1 byte per pixel, 255 where
        // magenta survived. Threshold leaves room for tiny shader-AA
        // bleed at gap edges (R>240, G<20, B>240).
        const maskBuf = Buffer.alloc(width * height);
        for (let p = 0; p < width * height; p++) {
          const o = p * 4;
          const r = pixelView[o];
          const g = pixelView[o + 1];
          const b = pixelView[o + 2];
          maskBuf[p] = (r > 240 && g < 20 && b > 240) ? 255 : 0;
        }

        // Flip Y for both frame + mask via sharp (faster than manual
        // memmove and keeps the data path identical).
        await sharp(pixelBuf, { raw: { width, height, channels: 4 } })
          .flip()
          .png()
          .toFile(framePath);
        await sharp(maskBuf, { raw: { width, height, channels: 1 } })
          .flip()
          .png()
          .toFile(maskPath);
      } else {
        // Default fast path — pipe raw bytes to ffmpeg.
        const wroteOk = ff.stdin.write(pixelBuf);
        if (!wroteOk) {
          await new Promise((resolve) => ff.stdin.once("drain", resolve));
        }
      }
    }
  } finally {
    if (ff) {
      try { ff.stdin.end(); } catch (_) {}
    }
  }

  if (ffDone) await ffDone;

  // Three.js cleanup so this process can render many clips without leak.
  geometry.dispose();
  material.dispose();
  photoTexture.dispose();
  renderer.dispose();
  // gl context cleanup — `gl` package exposes a `destroy` helper but
  // calling it is optional and not all versions support it. Garbage
  // collection takes care of it when the variable goes out of scope.

  return {
    outPath: writeFramesDir ? null : outPath,
    framesRendered: totalFrames,
    durationSec,
    framesDir: writeFramesDir || null
  };
}

/* ============================================================
   Stitch frames-NNN.png into an MP4 clip (Phase 2 helper).
   ============================================================
   After the inpaint pass replaces each frame.png with its cleaned
   version, this builds the final clip via ffmpeg's image2 demuxer.
   Same encoding params as the Phase 1 direct-pipe path so output
   quality is comparable.
*/
export async function stitchFramesToMp4({ framesDir, outPath, frameRate = 24 }) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y",
      "-loglevel", "error",
      "-framerate", String(frameRate),
      "-i", path.join(framesDir, "frame-%04d.png"),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "veryfast",
      "-crf", "20",
      "-movflags", "+faststart",
      outPath
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (c) => { err += c.toString(); });
    ff.on("close", (code) => {
      if (code !== 0) reject(new Error(`stitchFramesToMp4 ffmpeg exited ${code}: ${err.slice(0, 400)}`));
      else resolve({ outPath });
    });
    ff.on("error", reject);
  });
}

/* ============================================================
   Camera path interpolation
   ============================================================ */

// Apply the camera state at normalized time t in [0, 1] by linearly
// interpolating between the surrounding keyframes. Keyframes have:
//   { t, position: [x,y,z], target: [x,y,z], fov?: number }
function applyCameraAtT(camera, path, t) {
  // Find the segment t falls into. cameraPath should be sorted by t
  // (callers are expected to pass them in order).
  let prev = path[0];
  let next = path[path.length - 1];
  for (let i = 0; i < path.length - 1; i++) {
    if (t >= path[i].t && t <= path[i + 1].t) {
      prev = path[i];
      next = path[i + 1];
      break;
    }
  }
  const span = next.t - prev.t;
  const local = span > 0 ? (t - prev.t) / span : 0;

  const px = lerp(prev.position[0], next.position[0], local);
  const py = lerp(prev.position[1], next.position[1], local);
  const pz = lerp(prev.position[2], next.position[2], local);
  const tx = lerp(prev.target[0], next.target[0], local);
  const ty = lerp(prev.target[1], next.target[1], local);
  const tz = lerp(prev.target[2], next.target[2], local);

  camera.position.set(px, py, pz);
  camera.lookAt(tx, ty, tz);

  if (typeof prev.fov === "number" || typeof next.fov === "number") {
    const fovA = prev.fov ?? next.fov ?? DEFAULT_FOV;
    const fovB = next.fov ?? prev.fov ?? DEFAULT_FOV;
    const interpFov = lerp(fovA, fovB, local);
    if (camera.fov !== interpFov) {
      camera.fov = interpFov;
      camera.updateProjectionMatrix();
    }
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/* ============================================================
   Camera path presets — matches the existing scene.cameraMotion
   vocabulary so depth-job.mjs can drop these in without changing the
   edit plan. Base values are moderate; per-room overrides + per-style
   intensity scaling let us push more aggressive moves selectively.
   ============================================================ */

export const CAMERA_PRESETS = {
  push_in: {
    description: "Dolly push forward, 12% travel toward the scene",
    keyframes: [
      { t: 0,   position: [0, 0,  1.00], target: [0, 0, 0], fov: 50 },
      { t: 1,   position: [0, 0,  0.78], target: [0, 0, 0], fov: 50 }
    ]
  },
  pull_out: {
    description: "Dolly pull back, 12% travel away from the scene",
    keyframes: [
      { t: 0,   position: [0, 0,  0.78], target: [0, 0, 0], fov: 50 },
      { t: 1,   position: [0, 0,  1.00], target: [0, 0, 0], fov: 50 }
    ]
  },
  lateral_pan: {
    description: "Lateral dolly left-to-right with parallax",
    keyframes: [
      { t: 0,   position: [-0.18, 0, 0.95], target: [-0.18, 0, 0], fov: 50 },
      { t: 1,   position: [ 0.18, 0, 0.95], target: [ 0.18, 0, 0], fov: 50 }
    ]
  },
  vertical_reveal: {
    description: "Tilt-up reveal, camera target rises from lower frame",
    keyframes: [
      { t: 0,   position: [0,  0.00, 0.95], target: [0, -0.20, 0], fov: 50 },
      { t: 1,   position: [0,  0.00, 0.95], target: [0,  0.20, 0], fov: 50 }
    ]
  },
  parallax_zoom: {
    description: "Off-axis dolly push for visible parallax",
    keyframes: [
      { t: 0,   position: [-0.08, 0, 1.00], target: [0, 0, 0], fov: 50 },
      { t: 1,   position: [ 0.08, 0, 0.80], target: [0, 0, 0], fov: 50 }
    ]
  },
  detail_sweep: {
    description: "Lateral move across an architectural detail, narrow FOV",
    keyframes: [
      { t: 0,   position: [-0.10, 0, 0.85], target: [-0.10, 0, 0], fov: 42 },
      { t: 1,   position: [ 0.10, 0, 0.85], target: [ 0.10, 0, 0], fov: 42 }
    ]
  },
  // Orbit — slight arc around the focal subject. Only safe with strong
  // foreground depth (set ROOM_PROFILES.<room>.preferredMotion to opt in).
  orbit: {
    description: "Slight orbit around focal subject (~10°)",
    keyframes: [
      { t: 0,   position: [-0.20, 0, 0.95], target: [0, 0, 0], fov: 50 },
      { t: 1,   position: [ 0.20, 0, 0.95], target: [0, 0, 0], fov: 50 }
    ]
  }
};

/* ============================================================
   Per-room camera profiles (Phase 3)
   ============================================================
   Each room type picks a default cameraMotion best-suited to what
   typically anchors the shot:
     - kitchen        → slow push toward the island/counter
     - primary bdrm   → wide lateral pan revealing scale
     - exterior       → slow pull-back so the whole house comes in
     - bathroom       → tight detail sweep across fixtures
     - living         → lateral pan with parallax
     - outdoor/pool   → vertical reveal (sky → landscape)
     - amenity        → push-in to highlight the feature
     - detail         → detail sweep with narrow FOV

   The edit plan still chooses the cameraMotion per scene; this only
   kicks in when the manifest doesn't specify one (or specifies a
   generic 'push_in' that the room profile can refine).
*/
export const ROOM_PROFILES = {
  exterior:  { preferredMotion: "pull_out",        intensityMultiplier: 1.10 },
  kitchen:   { preferredMotion: "push_in",         intensityMultiplier: 1.00 },
  living:    { preferredMotion: "lateral_pan",     intensityMultiplier: 1.00 },
  bedroom:   { preferredMotion: "lateral_pan",     intensityMultiplier: 0.95 },
  bathroom:  { preferredMotion: "detail_sweep",    intensityMultiplier: 0.85 },
  outdoor:   { preferredMotion: "vertical_reveal", intensityMultiplier: 1.05 },
  amenity:   { preferredMotion: "push_in",         intensityMultiplier: 1.00 },
  detail:    { preferredMotion: "detail_sweep",    intensityMultiplier: 0.90 }
};

/* ============================================================
   Per-style intensity scaling (Phase 3)
   ============================================================
   Multiplied with the room intensityMultiplier to scale camera
   translation magnitude. Style picker drives the personality:
     - Luxury  → slower, more restrained (0.85)
     - Social  → bolder, faster, bigger moves (1.20)
     - MLS     → minimal motion (0.65) — compliance-safe
     - Investor → neutral (1.00) — moderate professional
*/
export const STYLE_INTENSITY = {
  "cinematic-luxury": 0.85,
  "modern-social":    1.20,
  "mls-clean":        0.65,
  "investor-tour":    1.00
};

/* ============================================================
   Resolve a scene's cameraMotion → keyframes, applying per-room
   preference + per-style intensity scaling.
   ============================================================
   The keyframes returned are scaled COPIES so caller mutations
   never leak back into CAMERA_PRESETS.
*/
/* ============================================================
   Flat-depth detection (Phase 3)
   ============================================================
   Some scenes — wide exteriors with no clear foreground, distant
   landscape shots, top-down photos — produce nearly-flat depth maps.
   Parallax through a flat scene looks identical to a basic Ken Burns
   move while still costing depth + WebGL compute (and sometimes
   inpaint compute too).

   This helper reads the depth PNG, computes the normalized variance
   of its pixel values, and returns { isFlat, variance } so the
   orchestrator can choose to skip the depth pipeline entirely and
   route the scene to Ken Burns instead.

   Threshold tuning:
     variance < 0.005 → almost certainly flat (sky, single wall, etc.)
     variance < 0.015 → looks flat — parallax adds little
     variance > 0.020 → meaningful depth — parallax helps

   The threshold can be overridden via DEPTH_FLAT_THRESHOLD env.
*/
export async function isDepthFlat(depthPath, threshold = null) {
  const t = threshold ?? Number(process.env.DEPTH_FLAT_THRESHOLD || 0.015);
  // Resize to a small thumbnail for fast variance computation.
  const { data, info } = await sharp(depthPath)
    .resize(128, 128, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n / 255;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const norm = data[i] / 255;
    sumSq += (norm - mean) ** 2;
  }
  const variance = sumSq / n;
  return { isFlat: variance < t, variance, threshold: t };
}

export function cameraPathFor(motion, options = {}) {
  const { roomType = null, styleId = null, useRoomPreference = true } = options;

  // Resolve which preset to use. If a room profile prefers a different
  // motion and we're allowed to override, swap.
  let chosenMotion = motion;
  if (useRoomPreference && roomType && ROOM_PROFILES[roomType]?.preferredMotion) {
    // Only override the generic 'push_in' default. If the edit plan
    // explicitly picked something other than push_in, trust it.
    if (motion === "push_in") {
      chosenMotion = ROOM_PROFILES[roomType].preferredMotion;
    }
  }
  const preset = CAMERA_PRESETS[chosenMotion] ?? CAMERA_PRESETS.push_in;

  // Compute intensity multiplier from room + style.
  const roomMul = (roomType && ROOM_PROFILES[roomType]?.intensityMultiplier) ?? 1.0;
  const styleMul = (styleId && STYLE_INTENSITY[styleId]) ?? 1.0;
  const intensity = roomMul * styleMul;

  // Scale keyframe positions/targets around the unit camera axis. The
  // camera default position is at z≈1 looking at origin; we scale the
  // DELTA from that center so smaller intensity = less travel, larger
  // = more.
  const baseZ = 1.0;
  const baseTarget = [0, 0, 0];
  return preset.keyframes.map((kf) => ({
    ...kf,
    position: [
      kf.position[0] * intensity,
      kf.position[1] * intensity,
      baseZ + (kf.position[2] - baseZ) * intensity
    ],
    target: [
      baseTarget[0] + (kf.target[0] - baseTarget[0]) * intensity,
      baseTarget[1] + (kf.target[1] - baseTarget[1]) * intensity,
      baseTarget[2] + (kf.target[2] - baseTarget[2]) * intensity
    ]
  }));
}
