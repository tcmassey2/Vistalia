// Vistalia — i2v model bake-off harness (v59, round 2).
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
  const room = scene.roomType;
  let base;
  if (room === "pool") base = CONSTRAINED.pool;
  else if (room === "exterior") base = CONSTRAINED.exterior;
  else if (room === "kitchen") base = CONSTRAINED.kitchen;
  else if (room === "bathroom") base = CONSTRAINED.generic;
  else base = CINEMATIC;
  return base + FIDELITY_SUFFIX;
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
  kling3std: {
    endpoint: "fal-ai/kling-video/v3/standard/image-to-video",
    label: "Kling V3 Standard",
    estPerScene: 0.5,
    buildInput: (p, img) => ({
      prompt: p,
      image_url: img,
      duration: "6",
      negative_prompt: NEGATIVE_PROMPT,
      generate_audio: false
    })
  },
  hailuo23fastpro: {
    endpoint: "fal-ai/minimax/hailuo-2.3/fast-pro/image-to-video",
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
  }
};

/* ── Small utils ─────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { full: false, dry: false, models: Object.keys(MODELS), scenes: null, out: null };
  for (const a of argv.slice(2)) {
    if (a === "--full") args.full = true;
    else if (a === "--dry") args.dry = true;
    else if (a.startsWith("--models=")) args.models = a.slice(9).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--scenes=")) args.scenes = a.slice(9).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--out=")) args.out = a.slice(6);
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

  let scenes = args.full ? SCENES : SCENES.filter((s) => s.name === "04-kitchen");
  if (args.scenes) scenes = SCENES.filter((s) => args.scenes.some((q) => s.name.includes(q)));
  if (scenes.length === 0) { console.error("no scenes selected"); process.exit(1); }

  const est = modelKeys.reduce((sum, k) => sum + MODELS[k].estPerScene * scenes.length, 0);
  console.log(`\n=== i2v bake-off ===`);
  console.log(`models : ${modelKeys.map((k) => MODELS[k].label).join(" | ")}`);
  console.log(`scenes : ${scenes.length} (${scenes.map((s) => s.name.slice(0, 2)).join(",")})`);
  console.log(`judge  : ${qcEnabled() ? "production QC (frame-vs-photo)" : "DISABLED — no OPENAI/GEMINI key; eyeball-only"}`);
  console.log(`est    : ~$${est.toFixed(2)} fal spend\n`);
  if (args.dry) { console.log("(dry run — no API calls)"); return; }
  if (!process.env.FAL_KEY) { console.error("FAL_KEY not set."); process.exit(1); }

  const outDir = args.out || path.join(process.cwd(), "bakeoff-results", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  await fs.mkdir(path.join(outDir, "clips"), { recursive: true });
  await fs.mkdir(path.join(outDir, "tmp"), { recursive: true });
  const fal = await loadFal();
  const rows = [];

  for (const modelKey of modelKeys) {
    const model = MODELS[modelKey];
    console.log(`\n── ${model.label} (${model.endpoint}) ──`);
    const frameDir = path.join(outDir, "frames", modelKey);
    await fs.mkdir(frameDir, { recursive: true });

    await pMap(scenes, SCENE_CONCURRENCY, async (scene) => {
      const row = { model: modelKey, scene: scene.name, roomType: scene.roomType };
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

    // Contact sheet: mid-frame of every scene, one image per model.
    await new Promise((resolve) => {
      const proc = spawn("ffmpeg", ["-y", "-v", "error", "-framerate", "1", "-i", path.join(frameDir, "%02d.png"), "-vf", `tile=${Math.min(scenes.length, 6)}x${Math.ceil(scenes.length / 6)}`, "-frames:v", "1", path.join(outDir, `sheet-${modelKey}.png`)]);
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
    });
  }

  /* Summary table */
  const lines = ["# i2v bake-off results", "", `date: ${new Date().toISOString()} · scenes: ${scenes.length} · judge: ${qcEnabled() ? "production QC" : "NONE"}`, "",
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
  await fs.writeFile(path.join(outDir, "SUMMARY.md"), lines.join("\n"));
  await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify({ scenes: scenes.map((s) => s.name), rows }, null, 2));
  await fs.rm(path.join(outDir, "tmp"), { recursive: true, force: true }).catch(() => {});
  console.log(`\nDone. Results: ${outDir}\n${lines.slice(4, 6 + modelKeys.length).join("\n")}`);
}

main().catch((err) => { console.error(`bake-off failed: ${err.stack || err}`); process.exit(1); });
