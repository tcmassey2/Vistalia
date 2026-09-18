// Vistalia — i2v model bake-off harness (v59 round 2; v63.0 round 3).
//
// Round 3 (Sep 17 2026): Troy + customers don't love Kling V3 Std — the
// named faults are architecture morph/invention, wrong motion, and soft
// output. Candidates are the Sep-2026 fal generation: MiniMax H3 (open
// weights, native 2K) + H3 Max (incl. the numeric camera-controls
// endpoint: azimuth/elevation/distance keyframes + rigid default prompt),
// Wan 3.0, Kling 3.0 Pro (1080p), Gemini Omni 1.1 Flash, Veo 3.1 Lite as
// the price floor, and Kling V3 Std as the baseline. New `--set=real`:
// six REAL Phoenix HDR listing photos (public photographer-portfolio
// URLs) — the canary set is AI-generated and went 30/30 with zero
// discrimination. Numeric scoring (first-frame SSIM, line drift, flow
// smoothness, sharpness) runs OUTSIDE this harness on the clips dir.
//
// Round 1 (June 9, eyeball-judged): Veo 3 Fast vs Kling o3 vs Seedance 1.0
// Pro on two failure scenes → Troy picked Veo 3.1 Fast. A month of
// production later Veo's hallucination tax is measured and real: kitchens
// risk-80 "always fall back", 2-3 QC retries per render, object
// erasure/invention (m76 grew a rubber duck), foliage boil, people-photo
// 422s. Round 2 tests the NEWER generations with the QC apparatus as an
// OBJECTIVE judge instead of eyeballs.
//
// Design:
//   - Fixed photoset: the 12 committed canary JPEGs (kitchen, baths,
//     foliage exteriors, twilight pool — every known Veo failure class).
//   - Same risk-routed prompts production uses (constrained for
//     kitchen/bath/pool/exterior, cinematic push for the rest, fidelity
//     suffix on everything).
//   - Judge: the production per-scene QC (frame-vs-photo vision check)
//     via qcVeoClip — the exact gate customer renders face.
//   - Output: results.json + SUMMARY.md pass-rate/cost/latency table +
//     per-model contact sheets. No prod code touched.
//
// Usage (Render worker shell, repo root):
//   node render-worker/tools/model-bakeoff.mjs                 # probe: kitchen scene only, every model (~$3)
//   node render-worker/tools/model-bakeoff.mjs --full          # all 12 scenes × all models (~$25)
//   node render-worker/tools/model-bakeoff.mjs --full --models=kling3std,hailuo23fastpro
//   node render-worker/tools/model-bakeoff.mjs --dry           # print plan + cost, no API calls
// Round 3 (local Mac is fine — only FAL_KEY needed, results in render-worker/bakeoff-results/):
//   cd render-worker && FAL_KEY=… node tools/model-bakeoff.mjs --set=real --models=round3
//       → 3 probe scenes (kitchen, bedroom, twilight) × 8 models ≈ $16
//   cd render-worker && FAL_KEY=… node tools/model-bakeoff.mjs --set=real --full --models=h3maxcam,h3,wan30
//       → all 6 real scenes for the finalists (resume-safe: finished clips are never re-bought)
//
// Env: FAL_KEY required; OPENAI_API_KEY / GEMINI_API_KEY for the QC judge
// (without them clips still generate but scoring is eyeball-only).
// Results land in ./bakeoff-results/<timestamp>/ (gitignored).

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { qcVeoClip, qcEnabled } from "../src/veo-qc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.APP_URL || "https://vistalia.ai";
const SUBSCRIBE_TIMEOUT_MS = 8 * 60 * 1000;
const SCENE_CONCURRENCY = 2;

/* ── The fixed photoset ──────────────────────────────────────────────── */

const SCENES = [
  { name: "01-exterior-twilight", roomType: "exterior" },
  { name: "02-entry-loggia", roomType: "exterior" },
  { name: "03-great-room", roomType: "living" },
  { name: "04-kitchen", roomType: "kitchen" },
  { name: "05-dining", roomType: "dining" },
  { name: "06-primary-bedroom", roomType: "bedroom" },
  { name: "07-primary-bath", roomType: "bathroom" },
  { name: "08-study", roomType: "office" },
  { name: "09-courtyard", roomType: "exterior" },
  { name: "10-pool-twilight", roomType: "pool" },
  { name: "11-ramada", roomType: "exterior" },
  { name: "12-hallway", roomType: "hallway" }
].map((s, i) => ({ ...s, index: i, imageUrl: `${APP_URL}/showcase/canary/${s.name}.jpg` }));

/* ── Round-3 real set: six real Phoenix HDR listing photos (1800×1200),
   public photographer-portfolio URLs (snaplyst.com). Real HDR flattening,
   real wide-angle distortion, real straight lines — the things the AI
   canaries don't have. Private test inputs only; never shipped. Probe =
   the first three (kitchen straight lines + pendants, bedroom patterned
   rug + art + fan blades, twilight exterior with railings + sky). */

const REAL_BASE = "https://snaplyst.com/wp-content/uploads/2025/05";
const REAL_SCENES = [
  { name: "r1-kitchen-greatroom", roomType: "kitchen", file: "HDR-Real-Estate-Photography-Phoenix-Arizona_10-23.webp" },
  { name: "r2-primary-bedroom", roomType: "bedroom", file: "HDR-Real-Estate-Photography-Phoenix-Arizona_10-28.webp" },
  { name: "r3-exterior-twilight", roomType: "exterior", file: "Twilight-Real-Estate-Photos-Phoenix-Metro-Arizona-12.webp" },
  { name: "r4-bath-mirrors", roomType: "bathroom", file: "HDR-Real-Estate-Photography-Phoenix-Arizona_10-25.webp" },
  { name: "r5-pool-patio", roomType: "pool", file: "HDR-Real-Estate-Photography-Phoenix-Arizona_10-31.webp" },
  { name: "r6-kitchen-modern", roomType: "kitchen", file: "HDR-Real-Estate-Photography-Phoenix-Arizona_10-35.webp" }
].map((s, i) => ({ ...s, index: i, imageUrl: `${REAL_BASE}/${s.file}` }));
const REAL_PROBE_COUNT = 3;

/* ── Prompts — mirrors production risk routing ───────────────────────────
   CONSTRAINED_* copied from runway-job.mjs CONSTRAINED_PROMPTS (v40/v46);
   FIDELITY_SUFFIX from VEO_FIDELITY_SUFFIX. Keep in sync by hand — this
   harness deliberately has zero imports from the job files so it can never
   destabilize them. */

const CONSTRAINED = {
  generic:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Preserve every surface, fixture, appliance, label, and object exactly as photographed. " +
    "Nothing in the scene moves.",
  kitchen:
    "The camera glides slowly and smoothly straight forward, ending about 8% closer, " +
    "with gentle easing — no panning, no tilting, no drift, no shake. " +
    "The kitchen stays exactly as photographed: every appliance keeps its exact shape, " +
    "size, door count, handles, controls, and finish; countertop and backsplash patterns " +
    "stay identical; cabinet fronts stay rigid with the same hardware; nothing reflective " +
    "changes; no new objects appear. Nothing in the scene moves — only the camera.",
  pool:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Water surface may shimmer gently, but pool shape, tile, coping, deck, and all " +
    "surroundings stay exactly as photographed. Nothing else moves.",
  exterior:
    "Completely static, locked-off camera. Extremely slow forward push of about 4% only, " +
    "with no other movement and no drift. " +
    "Trees, foliage, leaves, and branches stay completely still and hold their exact shape — " +
    "no swaying, morphing, rippling, or regenerating. The structure, roofline, windows, and " +
    "all hardscape stay exactly as photographed."
};

const CINEMATIC =
  "Slow, smooth cinematic push-in with gentle easing — no cuts, no panning drift, no shake. " +
  "The room stays exactly as photographed; nothing in the scene moves, only the camera.";

const FIDELITY_SUFFIX =
  " Photorealistic. Do not add, remove, or alter any object, surface, fixture, or " +
  "architectural feature. No people, no animals. Absolutely NO text, captions, words, " +
  "letters, numbers, signage, watermarks, on-screen UI, or graphic overlays of any kind " +
  "anywhere in the frame. Every piece of furniture and every object is bolted in place " +
  "in world space: nothing slides, drifts, follows, or travels with the camera — only " +
  "the camera moves, with correct perspective parallax, through a completely static scene.";

const NEGATIVE_PROMPT =
  "new objects, added furniture, removed furniture, morphing, warping, melting, " +
  "texture boil, flickering, people, animals, text, captions, watermarks, logos";

function promptFor(scene) {
  // Same room-class regexes as production's buildConstrainedVeoPrompt —
  // hard-set roomTypes come straight from audit rows ("outdoor", "detail",
  // "front"…) and must route the way production routed them.
  const room = String(scene.roomType || "").toLowerCase();
  let base;
  if (/pool|spa/.test(room)) base = CONSTRAINED.pool;
  else if (/exterior|backyard|outdoor|front|yard|patio/.test(room)) base = CONSTRAINED.exterior;
  else if (/kitchen/.test(room)) base = CONSTRAINED.kitchen;
  else if (/bath/.test(room)) base = CONSTRAINED.generic;
  else base = CINEMATIC;
  return base + FIDELITY_SUFFIX;
}

/* ── Hard set — self-assembled from production failures ──────────────────
   The canary photos are AI-generated ideal shots; run 1 went 30/30 PASS
   across every model — zero discrimination. The audit log records, per
   scene, how hard Veo had to fight: attempts, engineUsed (photo_motion =
   floored), sweepReplaced, fallbackReason. Scenes that needed retries or
   floors ARE the hard set — real customer photos, selected by measured
   failure, no curation bias. Photo URLs are re-signed fresh (audit may
   hold expired signed links). */

async function loadHardScenes(limit) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("--set=hard needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (run this on the worker).");
  }
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  let rows = [];
  for (const order of ["&order=created_at.desc", ""]) {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/render_audit_log?select=job_id,scenes,listing_address&internal=not.is.true&limit=30${order}`,
      { headers }
    );
    if (r.ok) { rows = await r.json().catch(() => []); break; }
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("no audit rows found for hard set.");

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const seen = new Set();
  const hard = [];
  for (const row of rows) {
    for (const s of Array.isArray(row.scenes) ? row.scenes : []) {
      const struggled = (Number(s.attempts) >= 2) || s.engineUsed === "photo_motion" ||
        s.sweepReplaced === true || Boolean(s.fallbackReason);
      if (!struggled || !s.photoUrl) continue;
      // Dedupe on the storage object path (same photo, different tokens).
      const m = String(s.photoUrl).match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/([^?]+)/);
      const key = m ? `${m[1]}/${m[2]}` : s.photoUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      // Re-sign storage URLs fresh; pass non-storage URLs through.
      let imageUrl = s.photoUrl;
      if (m) {
        const { data, error } = await sb.storage.from(m[1]).createSignedUrl(decodeURIComponent(m[2]), 7 * 24 * 3600);
        if (error || !data?.signedUrl) continue; // photo gone — skip
        imageUrl = data.signedUrl;
      }
      hard.push({
        name: `h${String(hard.length + 1).padStart(2, "0")}-${(s.roomType || "scene").replace(/[^a-z0-9]/gi, "")}`,
        roomType: s.roomType || "",
        index: hard.length,
        imageUrl,
        meta: {
          jobId: row.job_id,
          address: row.listing_address || "",
          attempts: s.attempts ?? null,
          engineUsed: s.engineUsed || "",
          sweepReplaced: Boolean(s.sweepReplaced),
          fallbackReason: s.fallbackReason || ""
        }
      });
      if (hard.length >= limit) return hard;
    }
  }
  if (hard.length === 0) throw new Error("audit rows contained no struggled scenes with photo URLs.");
  return hard;
}

/* ── Candidate registry ──────────────────────────────────────────────────
   Endpoint ids + input schemas are best-current-knowledge (fal docs,
   July 2026). If a model 422s in probe mode, fix the schema HERE and
   re-probe — that is exactly what probe mode is for. estPerScene feeds the
   cost table only (fal bills actuals). */

const MODELS = {
  veo: {
    endpoint: process.env.FAL_VIDEO_MODEL || "fal-ai/veo3.1/fast/image-to-video",
    label: "Veo 3.1 Fast (baseline)",
    estPerScene: 0.9,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: "6s",
      resolution: "720p",
      generate_audio: false,
      safety_tolerance: "4"
    })
  },
  kling3std916: {
    // v60.3 probe: does V3 i2v accept aspect_ratio? If yes → NATIVE 9:16
    // generation, no pipeline crop, and the sweep's "edge object missing"
    // false positives (0raj5j: sink/cabinets/painting/armchair, 4 wrong
    // floors) disappear along with the crop itself.
    endpoint: "fal-ai/kling-video/v3/standard/image-to-video",
    label: "Kling V3 Standard 9:16-native",
    estPerScene: 0.5,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: "6",
      aspect_ratio: "9:16",
      negative_prompt: NEGATIVE_PROMPT,
      generate_audio: false
    })
  },
  kling3std: {
    // Round-3 baseline = production engine. Schema moved since July:
    // the image field is now `start_image_url` (fal API page 2026-09-17);
    // 5s to match the round-3 candidates ($0.42 @720p, audio off).
    endpoint: "fal-ai/kling-video/v3/standard/image-to-video",
    label: "Kling V3 Standard (production baseline)",
    estPerScene: 0.42,
    buildInput: (p, img) => ({
      prompt: p,
      start_image_url: img,
      duration: "5",
      negative_prompt: NEGATIVE_PROMPT,
      generate_audio: false
    })
  },
  hailuo23fastpro: {
    // "fast" is a model-family suffix on fal, then the tier:
    // …/hailuo-2.3-fast/pro/…  (probe 1 found this the $0-cost way)
    endpoint: "fal-ai/minimax/hailuo-2.3-fast/pro/image-to-video",
    label: "Hailuo 2.3 Fast Pro",
    estPerScene: 0.33,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      prompt_optimizer: false // it rewrites prompts by default — never let it touch ours
    })
  },
  seedance2fast: {
    endpoint: "bytedance/seedance-2.0/fast/image-to-video",
    label: "Seedance 2.0 Fast",
    estPerScene: 1.45,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: "6",
      resolution: "720p"
    })
  },

  /* ── Round 3 (Sep 2026) candidates. Schemas from fal API pages 2026-09-17;
     estPerScene = fal list price for the configured duration/resolution,
     audio off. A 422 in probe mode means the schema moved — fix here. */
  h3maxcam: {
    // The only production i2v endpoint with NUMERIC camera keyframes
    // (azimuth°/elevation°/distance on a 0–1 timeline) and a rigid-scene
    // default prompt. distance 1.0 = the reference camera; 0.92 ≈ the same
    // ~8% push the kitchen constrained prompt asks for. prompt_expansion
    // disabled so our prompt is used verbatim.
    endpoint: "minimax/h3-max/camera-controls",
    label: "H3 Max camera-controls 1080p (dolly keyframes)",
    estPerScene: 0.8,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: 5,
      resolution: "1080P",
      prompt_expansion_mode: "disabled",
      camera_trajectory: [
        { time: 0, azimuth: 0, elevation: 0, distance: 1.0 },
        { time: 1, azimuth: 0, elevation: 0, distance: 0.92 }
      ]
    })
  },
  h3max: {
    endpoint: "minimax/h3-max/image-to-video",
    label: "H3 Max 1080p (prompt camera)",
    estPerScene: 0.8,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: 5,
      resolution: "1080P",
      prompt_expansion_mode: "disabled"
    })
  },
  h3: {
    // Open-weights base (self-host hedge). Native 2K — no 1080p tier.
    endpoint: "minimax/h3/image-to-video",
    label: "MiniMax H3 2K (open weights)",
    estPerScene: 0.65,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: 5,
      resolution: "2K",
      prompt_expansion_mode: "disabled"
    })
  },
  wan30: {
    // Best independent evidence of locked scene geometry; known habit of
    // inserting an unrequested cut on long clips → keep ≤6s, expansion off.
    endpoint: "alibaba/wan-3.0/image-to-video",
    label: "Wan 3.0 1080p",
    estPerScene: 1.0,
    buildInput: (p, img) => ({
      prompt: p,
      start_image_url: img,
      duration: 5,
      resolution: "1080p",
      aspect_ratio: "adaptive",
      audio: false,
      enable_prompt_expansion: false
    })
  },
  kling3pro: {
    endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    label: "Kling 3.0 Pro 1080p",
    estPerScene: 0.56,
    buildInput: (p, img) => ({
      prompt: p,
      start_image_url: img,
      duration: "5",
      negative_prompt: NEGATIVE_PROMPT,
      generate_audio: false
    })
  },
  omni11: {
    // Google's post-Veo line (#2–3 on both arenas). 1080p is upscaled.
    endpoint: "google/gemini-omni-flash/v1.1/image-to-video",
    label: "Gemini Omni 1.1 Flash 1080p",
    estPerScene: 0.75,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: 5,
      resolution: "1080p",
      aspect_ratio: "16:9"
    })
  },
  veo31lite: {
    // Price floor ($0.05/s at 1080p, audio off). 4/6/8s only.
    endpoint: "fal-ai/veo3.1/lite/image-to-video",
    label: "Veo 3.1 Lite 1080p 4s (price floor)",
    estPerScene: 0.2,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: "4s",
      resolution: "1080p",
      aspect_ratio: "auto",
      negative_prompt: NEGATIVE_PROMPT,
      generate_audio: false,
      safety_tolerance: "4"
    })
  }
};

// `--models=round3` expands to the Sep-2026 set + the Kling V3 Std baseline.
const MODEL_GROUPS = {
  round3: ["kling3std", "kling3pro", "h3maxcam", "h3max", "h3", "wan30", "omni11", "veo31lite"]
};

/* ── Small utils ─────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { full: false, dry: false, models: Object.keys(MODELS), scenes: null, out: null, set: "canary", limit: 12 };
  for (const a of argv.slice(2)) {
    if (a === "--full") args.full = true;
    else if (a === "--dry") args.dry = true;
    else if (a.startsWith("--models=")) {
      args.models = a.slice(9).split(",").map((s) => s.trim()).filter(Boolean)
        .flatMap((k) => MODEL_GROUPS[k] || [k]);
    }
    else if (a.startsWith("--scenes=")) args.scenes = a.slice(9).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--out=")) args.out = a.slice(6);
    else if (a.startsWith("--set=")) args.set = a.slice(6);
    else if (a.startsWith("--limit=")) args.limit = Math.max(1, Number(a.slice(8)) || 12);
  }
  return args;
}

async function loadFal() {
  const mod = await import("@fal-ai/client");
  const fal = mod.fal || mod.default?.fal || mod.default;
  if (!fal?.subscribe) throw new Error("@fal-ai/client loaded but `fal.subscribe` not found.");
  if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });
  return fal;
}

function pickVideoUrl(result) {
  const d = result?.data ?? result;
  return d?.video?.url || d?.video_url || d?.url ||
    (Array.isArray(d?.videos) && d.videos[0]?.url) || null;
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

function ffprobe(file) {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration", "-of", "csv=p=0", file
    ]);
    let out = "";
    proc.stdout.on("data", (c) => { out += c; });
    proc.on("close", () => {
      const [w, h, dur] = out.trim().split(",");
      resolve({ width: Number(w) || 0, height: Number(h) || 0, duration: Number(dur) || 0 });
    });
    proc.on("error", () => resolve({ width: 0, height: 0, duration: 0 }));
  });
}

function extractMidFrame(clip, dest, atSec) {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-y", "-v", "error", "-ss", String(atSec), "-i", clip, "-frames:v", "1", "-vf", "scale=360:-2", dest]);
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}

async function pMap(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ── One generation ──────────────────────────────────────────────────── */

async function generateOne(fal, modelKey, scene, outDir) {
  const model = MODELS[modelKey];
  const clipPath = path.join(outDir, "clips", `${modelKey}-${scene.name}.mp4`);
  // Resume-safe: a rerun after a partial failure skips finished clips.
  try { await fs.access(clipPath); return { cached: true, clipPath }; } catch { /* generate */ }

  const input = model.buildInput(promptFor(scene), scene.imageUrl);
  const t0 = Date.now();
  const result = await Promise.race([
    fal.subscribe(model.endpoint, { input, logs: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${SUBSCRIBE_TIMEOUT_MS / 1000}s`)), SUBSCRIBE_TIMEOUT_MS))
  ]);
  const url = pickVideoUrl(result);
  if (!url) throw new Error(`no video url in response: ${JSON.stringify(result?.data ?? result).slice(0, 200)}`);
  await download(url, clipPath);
  return { cached: false, clipPath, latencyMs: Date.now() - t0 };
}

/* ── Main ────────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv);
  const modelKeys = args.models.filter((k) => MODELS[k]);
  const unknown = args.models.filter((k) => !MODELS[k]);
  if (unknown.length) console.warn(`unknown models ignored: ${unknown.join(", ")} (have: ${Object.keys(MODELS).join(", ")})`);

  let scenes;
  if (args.set === "hard") {
    const all = await loadHardScenes(args.limit);
    scenes = args.full ? all : all.slice(0, 1);
  } else if (args.set === "real") {
    scenes = args.full ? REAL_SCENES : REAL_SCENES.slice(0, REAL_PROBE_COUNT);
  } else {
    scenes = args.full ? SCENES : SCENES.filter((s) => s.name === "04-kitchen");
  }
  if (args.scenes) scenes = scenes.filter((s) => args.scenes.some((q) => s.name.includes(q)));
  if (scenes.length === 0) { console.error("no scenes selected"); process.exit(1); }

  const est = modelKeys.reduce((sum, k) => sum + MODELS[k].estPerScene * scenes.length, 0);
  console.log(`\n=== i2v bake-off ===`);
  console.log(`set    : ${args.set}${args.set === "hard" ? " (production failure scenes, from audit log)" : args.set === "real" ? " (real Phoenix HDR listing photos)" : ""}`);
  console.log(`models : ${modelKeys.map((k) => MODELS[k].label).join(" | ")}`);
  console.log(`scenes : ${scenes.length} (${scenes.map((s) => s.name.slice(0, 3)).join(",")})`);
  console.log(`judge  : ${qcEnabled() ? "production QC (frame-vs-photo)" : "DISABLED — no OPENAI/GEMINI key; eyeball-only"}`);
  console.log(`est    : ~$${est.toFixed(2)} fal spend\n`);
  if (args.set === "hard") {
    for (const s of scenes) {
      console.log(`  ${s.name} · ${s.meta.address || s.meta.jobId} · veo needed: ${[
        s.meta.attempts ? `${s.meta.attempts} attempts` : "",
        s.meta.engineUsed === "photo_motion" ? "FLOORED" : "",
        s.meta.sweepReplaced ? "sweep-replaced" : "",
        s.meta.fallbackReason ? `(${String(s.meta.fallbackReason).slice(0, 60)})` : ""
      ].filter(Boolean).join(" ")}`);
    }
    console.log("");
  }
  if (args.dry) { console.log("(dry run — no API calls)"); return; }
  if (!process.env.FAL_KEY) { console.error("FAL_KEY not set."); process.exit(1); }

  // Date-stamped (not second-stamped) so a dropped shell or a probe→full
  // sequence RESUMES into the same dir — finished clips are never re-bought.
  const outDir = args.out || path.join(process.cwd(), "bakeoff-results", new Date().toISOString().slice(0, 10));
  await fs.mkdir(path.join(outDir, "clips"), { recursive: true });
  await fs.mkdir(path.join(outDir, "tmp"), { recursive: true });
  const fal = await loadFal();
  const rows = [];

  for (const modelKey of modelKeys) {
    const model = MODELS[modelKey];
    console.log(`\n── ${model.label} (${model.endpoint}) ──`);
    // Per-set frame dirs — canary and hard runs share the date dir and
    // must not interleave their contact sheets.
    const frameDir = path.join(outDir, "frames", `${args.set}-${modelKey}`);
    await fs.mkdir(frameDir, { recursive: true });

    await pMap(scenes, SCENE_CONCURRENCY, async (scene) => {
      const row = { model: modelKey, scene: scene.name, roomType: scene.roomType };
      if (scene.meta) row.veoHistory = scene.meta;
      try {
        const gen = await generateOne(fal, modelKey, scene, outDir);
        row.latencySec = gen.latencyMs ? Math.round(gen.latencyMs / 1000) : null;
        const probe = await ffprobe(gen.clipPath);
        row.res = `${probe.width}x${probe.height}`;
        row.clipSec = Math.round(probe.duration * 10) / 10;
        await extractMidFrame(gen.clipPath, path.join(frameDir, `${String(scene.index + 1).padStart(2, "0")}.png`), Math.max(0.5, probe.duration / 2));
        const qc = await qcVeoClip({
          clipPath: gen.clipPath,
          sourceImageUrl: scene.imageUrl,
          sceneIndex: scene.index,
          roomType: scene.roomType,
          tempDir: path.join(outDir, "tmp")
        });
        row.qcChecked = qc.checked !== false;
        row.qcPass = qc.pass;
        row.qcReasons = qc.reasons || [];
        console.log(`  ${scene.name}: ${row.qcChecked ? (qc.pass ? "PASS" : `FAIL (${(qc.reasons || []).join("; ").slice(0, 90)})`) : "generated (QC off)"}${row.latencySec ? ` · ${row.latencySec}s` : ""} · ${row.res} · ${row.clipSec}s clip`);
      } catch (err) {
        row.error = String(err.message || err).slice(0, 200);
        console.warn(`  ${scene.name}: ERROR — ${row.error}`);
      }
      rows.push(row);
    });

    // Contact sheet: mid-frame of every scene, one image per model per set.
    await new Promise((resolve) => {
      const proc = spawn("ffmpeg", ["-y", "-v", "error", "-framerate", "1", "-i", path.join(frameDir, "%02d.png"), "-vf", `tile=${Math.min(scenes.length, 6)}x${Math.ceil(scenes.length / 6)}`, "-frames:v", "1", path.join(outDir, `sheet-${args.set}-${modelKey}.png`)]);
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
    });
  }

  /* Summary table */
  const lines = ["# i2v bake-off results", "", `date: ${new Date().toISOString()} · set: ${args.set} · scenes: ${scenes.length} · judge: ${qcEnabled() ? "production QC" : "NONE"}`, "",
    "| model | QC pass | errors | avg latency | est $/scene | est $/9-scene render | clips |",
    "|---|---|---|---|---|---|---|"];
  for (const k of modelKeys) {
    const r = rows.filter((x) => x.model === k);
    const checked = r.filter((x) => x.qcChecked);
    const passed = checked.filter((x) => x.qcPass);
    const errored = r.filter((x) => x.error);
    const lat = r.filter((x) => x.latencySec).map((x) => x.latencySec);
    const avgLat = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : "-";
    lines.push(`| ${MODELS[k].label} | ${checked.length ? `${passed.length}/${checked.length}` : "n/a"} | ${errored.length} | ${avgLat}s | $${MODELS[k].estPerScene.toFixed(2)} | $${(MODELS[k].estPerScene * 9).toFixed(2)} | ${r.length - errored.length}/${r.length} |`);
  }
  lines.push("", "## Failure detail", "");
  for (const x of rows.filter((x) => (x.qcChecked && !x.qcPass) || x.error)) {
    lines.push(`- **${MODELS[x.model].label} / ${x.scene}**: ${x.error ? `ERROR ${x.error}` : x.qcReasons.join("; ")}`);
  }
  await fs.writeFile(path.join(outDir, `SUMMARY-${args.set}.md`), lines.join("\n"));
  await fs.writeFile(path.join(outDir, `results-${args.set}.json`), JSON.stringify({ set: args.set, scenes: scenes.map((s) => s.name), rows }, null, 2));
  await fs.rm(path.join(outDir, "tmp"), { recursive: true, force: true }).catch(() => {});
  console.log(`\nDone. Results: ${outDir}\n${lines.slice(4, 6 + modelKeys.length).join("\n")}`);

  // The Render shell has no file download — push the small artifacts
  // (summary, sheets, results) to Supabase storage and print 7-day signed
  // URLs so the sheets can be reviewed off-box. Clips stay local (heavy).
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const runId = path.basename(outDir);
      const files = [`SUMMARY-${args.set}.md`, `results-${args.set}.json`, ...modelKeys.map((k) => `sheet-${args.set}-${k}.png`)];
      console.log("\nShareable links (7 days):");
      for (const f of files) {
        try {
          const buf = await fs.readFile(path.join(outDir, f));
          const objectPath = `bakeoff/${runId}/${f}`;
          const { error: upErr } = await sb.storage.from("listing-photos").upload(objectPath, buf, {
            contentType: f.endsWith(".png") ? "image/png" : f.endsWith(".json") ? "application/json" : "text/markdown",
            upsert: true
          });
          if (upErr) throw upErr;
          const { data, error: signErr } = await sb.storage.from("listing-photos").createSignedUrl(objectPath, 7 * 24 * 3600);
          if (signErr) throw signErr;
          console.log(`  ${f}: ${data.signedUrl}`);
        } catch (e) {
          console.warn(`  ${f}: upload failed (${e.message || e})`);
        }
      }
    } catch (e) {
      console.warn(`(share upload skipped: ${e.message || e})`);
    }
  }
}

main().catch((err) => { console.error(`bake-off failed: ${err.stack || err}`); process.exit(1); });
