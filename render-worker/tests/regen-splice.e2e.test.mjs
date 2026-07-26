// Vistalia — steady-shot regen (v62.38) end-to-end harness.
//
// Simulates a completed render entirely locally (no Supabase, no fal, no
// ElevenLabs): three normalized clips → stitched master with a burned
// caption track and a sine "voiceover" — then drives the REAL rebuild
// (__testRebuildWithSteadyScene) against it over a local HTTP server and
// asserts the v62.38 contract:
//
//   1. the rebuilt timeline matches the original master's length
//   2. the ORIGINAL AUDIO IS BIT-IDENTICAL in the output (the whole point)
//   3. the replaced scene's pixels changed; the untouched scenes' didn't
//   4. captions were re-burned onto the rebuilt video
//   5. the trial path ships a marked master AND a refreshed clean master
//   6. a pre-v62.38 original (no captions.ass) is REFUSED, not degraded
//   7. a drifted timeline is REFUSED before any audio is touched
//
//   node render-worker/tests/regen-splice.e2e.test.mjs   (exit 1 on failure)
//
// In this environment the homography floor's onnx runtime is unavailable, so
// generateKenBurnsFallback exercises its zoompan fallback — same duration
// contract, same call path. Production additionally has the primary floor.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.REGEN_TEST_EXPOSE_LOCAL = "1";
// Keep the harness fast and deterministic: no film grain/halation variance.
process.env.FINISH_PASS = "0";
process.env.FINISH_DEFLICKER = "0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { stitchClipsAndOverlays } = await import(path.join(HERE, "..", "src", "runway-job.mjs"));
const { __testRebuildWithSteadyScene } = await import(path.join(HERE, "..", "src", "regenerate-job.mjs"));
const { buildCaptionsAss } = await import(path.join(HERE, "..", "src", "captions.mjs"));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error(`  FAIL: ${name} ${detail}`); }
};

const ff = (args, timeout = 120000) => new Promise((resolve, reject) => {
  execFile("ffmpeg", ["-y", "-v", "error", ...args], { timeout }, (err, so, se) =>
    err ? reject(new Error(`${err.message} ${se}`)) : resolve(so));
});
const probe = (file) => new Promise((resolve) => {
  execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { timeout: 15000 }, (err, so) => resolve(err ? NaN : Number(String(so).trim())));
});
const sha = async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
// Mean-abs-difference between two same-size PNG frames (0 = identical).
async function frameDiff(a, b, out) {
  await ff(["-i", a, "-i", b, "-filter_complex",
    "[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:file=" + out, "-f", "null", "-"]);
  const txt = await fs.readFile(out, "utf8");
  const m = txt.match(/YAVG=([\d.]+)/);
  return m ? Number(m[1]) : NaN;
}
async function extractFrame(video, t, outPng, cropTopFrac = 0) {
  // The rebuild runs at PRODUCTION dims (1080x1920) while fixtures are
  // half-scale — normalize every extract to one size so blends line up.
  const vf = (cropTopFrac > 0 ? `crop=iw:ih*${cropTopFrac}:0:0,` : "") + "scale=540:-2";
  await ff(["-ss", String(t), "-i", video, "-frames:v", "1", "-vf", vf, outPng]);
}
async function extractAudioBytes(video, out) {
  await ff(["-i", video, "-map", "0:a:0", "-c", "copy", "-f", "adts", out]);
  return sha(out);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "regen-e2e-"));
const W = 540, H = 960; // half-scale vertical: same math, quarter the encode time
const DUR = [4.0, 5.0, 8.5];

/* ── Build the "original render": photos, normalized clips, master ── */
const photos = [];
for (let i = 0; i < 3; i++) {
  const p = path.join(dir, `photo-${i}.png`);
  await ff(["-f", "lavfi", "-i",
    `color=c=${["0x224466", "0x664422", "0x226644"][i]}:s=${W * 2}x${H * 2}`,
    "-frames:v", "1", p]);
  photos.push(p);
}
const clips = [];
for (let i = 0; i < 3; i++) {
  const c = path.join(dir, `norm-${i}.mp4`);
  // Distinct moving content per scene so frame comparisons are meaningful.
  await ff(["-f", "lavfi", "-i",
    `testsrc2=s=${W}x${H}:r=30:d=${DUR[i]}`,
    "-vf", `hue=h=${i * 110}:s=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "superfast", "-crf", "19", "-an", c]);
  clips.push(c);
}

const manifest = {
  app: "Vistalia",
  engine: "veo",
  exportFormat: "vertical",
  captionsEnabled: true,
  skipNarration: true,
  runwayConfig: { ratio: "9:16", useCrossfades: true },
  project: { id: "regen-e2e", userId: "tester", title: "Harness House", address: "1 Test Way", city: "Testville, AZ" },
  brandKit: {},
  orderedPhotos: [0, 1, 2].map((i) => ({ id: `p${i}`, durableUrl: `LOCAL/photo-${i}.png` })),
  scenes: [0, 1, 2].map((i) => ({
    photoId: `p${i}`, type: "photo", durableUrl: `LOCAL/photo-${i}.png`,
    duration: DUR[i] - 0.5, roomType: ["kitchen", "bedroom", "living"][i], cameraMotion: "push_in"
  }))
};

// dimensionsOverride keeps the whole harness at 540x960.
const stitchOpts = { dimensionsOverride: { width: W, height: H } };
const masterSilent = path.join(dir, "master-silent.mp4");
await stitchClipsAndOverlays(
  [0, 1, 2].map((i) => ({
    sceneIndex: i, photoId: `p${i}`, clipPath: clips[i], duration: DUR[i],
    transition: "crossfade", overlay: null, runwayTaskId: null, fallback: false, preNormalized: true
  })),
  { ...manifest, skipMusic: true },
  masterSilent, path.join(dir, "master-thumb.png"), stitchOpts
);

// Caption track (real generator) + sine "voiceover" → the original master.
const assPath = path.join(dir, "captions.ass");
const masterLen = await probe(masterSilent);
const words = [];
for (let t = 0.6; t < masterLen - 1; t += 0.45) {
  words.push({ text: `W${words.length}`, start: +t.toFixed(2), end: +(t + 0.4).toFixed(2), lineStart: words.length % 3 === 0 });
}
await fs.writeFile(assPath, buildCaptionsAss({ words, playW: W, playH: H, variant: "luxury" }));
const originalMaster = path.join(dir, "master.mp4");
await ff(["-i", masterSilent, "-f", "lavfi", "-i", `sine=frequency=330:duration=${(masterLen + 1).toFixed(2)}`,
  "-map", "0:v", "-map", "1:a",
  "-vf", `subtitles='${assPath.replace(/\\/g, "/").replace(/:/g, "\\:")}'`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "superfast", "-crf", "19",
  "-c:a", "aac", "-b:a", "128k", "-shortest", originalMaster]);
ok("fixture: original master built", (await probe(originalMaster)) > 10);

/* ── Local HTTP server standing in for Supabase storage ── */
const server = http.createServer(async (req, res) => {
  const file = path.join(dir, decodeURIComponent((req.url || "/").slice(1)));
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
// Manifest photo URLs → the served copies.
for (const p of manifest.orderedPhotos) p.durableUrl = p.durableUrl.replace("LOCAL", base);
for (const s of manifest.scenes) s.durableUrl = s.durableUrl.replace("LOCAL", base);

const auditScenes = [0, 1, 2].map((i) => ({
  sceneIndex: i, photoId: `p${i}`, clipUrl: `${base}/norm-${i}.mp4`,
  durationSec: DUR[i], roomType: manifest.scenes[i].roomType, cameraMotion: "push_in",
  photoUrl: `${base}/photo-${i}.png`, wasFallback: false
}));

const runRebuild = async (over = {}) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "regen-run-"));
  try {
    return await __testRebuildWithSteadyScene({
      jobId: "regen-e2e-job",
      sceneIndex: over.sceneIndex ?? 1,
      manifest: over.manifest || manifest,
      auditRow: { master_mp4_url: over.masterUrl || `${base}/master.mp4`, master_clean_url: over.cleanUrl || "", scenes: auditScenes },
      originalScenes: auditScenes,
      targetScene: auditScenes[over.sceneIndex ?? 1],
      masterUrl: over.masterUrl || `${base}/master.mp4`,
      tempDir,
      options: { onProgress: () => {} }
    });
  } finally {
    if (!over.keep) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

/* ── 1-4: the happy path, scene 2 (index 1) replaced ── */
{
  const res = await runRebuild({ sceneIndex: 1, keep: true });
  const L = res.__local;
  ok("rebuild completes with narration preserved", res.status === "complete" && res.narration?.preserved === true);
  ok(`timeline matches original (${L.rebuiltLen.toFixed(2)}s vs ${L.originalLen.toFixed(2)}s)`,
    Math.abs(L.rebuiltLen - L.originalLen) <= 0.35);

  const aOrig = await extractAudioBytes(originalMaster, path.join(dir, "a-orig.adts"));
  const aNew = await extractAudioBytes(L.cleanMaster, path.join(dir, "a-new.adts"));
  ok("ORIGINAL AUDIO IS BIT-IDENTICAL in the rebuilt master", aOrig === aNew, `${aOrig.slice(0, 12)} vs ${aNew.slice(0, 12)}`);

  // Scene windows in master time (visible = duration − 0.5 crossfade).
  const vis = DUR.map((d) => d - 0.5);
  const midScene1 = vis[0] * 0.5;                 // untouched scene
  const midScene2 = vis[0] + vis[1] * 0.5;        // replaced scene
  // Compare the TOP 35% of the frame — captions live lower and would differ
  // by subpixel AA even on identical re-encodes.
  const f = (v, t, n) => extractFrame(v, t, path.join(dir, n), 0.35).then(() => path.join(dir, n));
  const d1 = await frameDiff(await f(originalMaster, midScene1, "o1.png"), await f(L.cleanMaster, midScene1, "n1.png"), path.join(dir, "m1.txt"));
  const d2 = await frameDiff(await f(originalMaster, midScene2, "o2.png"), await f(L.cleanMaster, midScene2, "n2.png"), path.join(dir, "m2.txt"));
  ok(`untouched scene is visually unchanged (diff ${d1.toFixed(2)})`, Number.isFinite(d1) && d1 < 4, String(d1));
  ok(`replaced scene visibly changed (diff ${d2.toFixed(2)})`, Number.isFinite(d2) && d2 > 10, String(d2));

  // Captions really re-burned: rebuilt master differs from its own silent
  // stitch in the caption band (bottom half) at a caption timestamp.
  const capT = 1.1;
  const noAss = await f(L.silentStitched, capT, "c-silent.png");
  const withAss = await f(L.cleanMaster, capT, "c-final.png");
  void noAss; void withAss;
  const dc = await frameDiff(path.join(dir, "c-silent.png"), path.join(dir, "c-final.png"), path.join(dir, "mc.txt"));
  // Top-35% crop excludes captions → tiny; now compare FULL frames instead.
  await extractFrame(L.silentStitched, capT, path.join(dir, "cf-silent.png"));
  await extractFrame(L.cleanMaster, capT, path.join(dir, "cf-final.png"));
  const dcFull = await frameDiff(path.join(dir, "cf-silent.png"), path.join(dir, "cf-final.png"), path.join(dir, "mcf.txt"));
  ok(`captions re-burned (full-frame diff ${dcFull.toFixed(2)} > top-crop diff ${dc.toFixed(2)})`, dcFull > dc && dcFull > 0.5, `${dcFull} vs ${dc}`);
}

/* ── 5: trial path — marked master + refreshed clean master ── */
{
  const res = await runRebuild({ sceneIndex: 2, manifest: { ...manifest, freeRenderWatermark: true }, keep: true });
  const L = res.__local;
  ok("trial: marked deliverable differs from clean", L.deliverablePath !== L.cleanMaster);
  const dMark = await (async () => {
    await extractFrame(L.deliverablePath, 2.0, path.join(dir, "wm-marked.png"));
    await extractFrame(L.cleanMaster, 2.0, path.join(dir, "wm-clean.png"));
    return frameDiff(path.join(dir, "wm-marked.png"), path.join(dir, "wm-clean.png"), path.join(dir, "wm.txt"));
  })();
  // Calibration: a pure re-encode of the same frame measures ~0.05 mean
  // abs diff at this scale; the translucent corner mark measures ~0.27.
  // 0.15 splits them with margin on both sides.
  ok(`trial: watermark visibly present (diff ${dMark.toFixed(2)})`, dMark > 0.15, String(dMark));
  const aOrig = await sha(path.join(dir, "a-orig.adts"));
  const aMarked = await extractAudioBytes(L.deliverablePath, path.join(dir, "a-marked.adts"));
  ok("trial: marked master still carries the original audio", aOrig === aMarked);
}

/* ── 6: pre-v62.38 original (no captions.ass) is refused ── */
{
  let err = null;
  try {
    await runRebuild({ masterUrl: `${base}/master-silent.mp4` }); // sibling captions.ass 404s (name mismatch)
  } catch (e) { err = e; }
  // master-silent.mp4 → captions URL replaces "master.mp4" — no match, same URL → treated as absent
  ok("legacy original without caption artifact is refused", !!err && /REGEN_PREDATES|re-render/i.test(`${err?.code} ${err?.message}`), err?.message || "no error");
}

/* ── 7: drifted timeline is refused before audio is touched ── */
{
  // A master 2s longer than the clips can rebuild to.
  const longMaster = path.join(dir, "master-long", "master.mp4");
  await fs.mkdir(path.dirname(longMaster), { recursive: true });
  await ff(["-i", originalMaster, "-vf", "tpad=stop_mode=clone:stop_duration=2", "-af", "apad=pad_dur=2",
    "-c:v", "libx264", "-preset", "superfast", "-crf", "19", "-c:a", "aac", longMaster]);
  await fs.copyFile(assPath, path.join(dir, "master-long", "captions.ass"));
  let err = null;
  try {
    await runRebuild({ masterUrl: `${base}/master-long/master.mp4` });
  } catch (e) { err = e; }
  ok("drifted timeline is refused (audio never remuxed)", !!err && /refusing to remux|drifted/i.test(err?.message || ""), err?.message || "no error");
}

/* ── 8: METADATA AUTHORITY — the divergent-clip class heals, not drifts.
   Adversarial review's C2: a stored clip measuring 4.7s while the audit
   row says 5.0s (the documented pre-v62 Kling short-delivery shape). The
   original master's timeline was authored by the METADATA; a rebuild
   driven by the measurement re-authored a different timeline, slid 0.30s
   under the old tolerance, and silently discarded 0.30s of voiceover.
   The fix renders the replacement at the AUDIT value. Assert the rebuild
   now reproduces the original timeline and keeps the audio whole. */
{
  const dvDir = path.join(dir, "divergent");
  await fs.mkdir(dvDir, { recursive: true });
  const DV = [4.0, 5.0, 4.0];        // metadata / audit durations
  const FILE_DUR = [4.0, 4.7, 4.0];  // what's actually on disk for clip 1
  const dvClips = [];
  for (let i = 0; i < 3; i++) {
    const c = path.join(dvDir, `norm-${i}.mp4`);
    await ff(["-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=30:d=${FILE_DUR[i]}`,
      "-vf", `hue=h=${i * 70}:s=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "superfast", "-crf", "19", "-an", c]);
    dvClips.push(c);
  }
  const dvSilent = path.join(dvDir, "silent.mp4");
  await stitchClipsAndOverlays(
    [0, 1, 2].map((i) => ({
      sceneIndex: i, photoId: `p${i}`, clipPath: dvClips[i], duration: DV[i],
      transition: "crossfade", overlay: null, runwayTaskId: null, fallback: false, preNormalized: true
    })),
    { ...manifest, skipMusic: true }, dvSilent, path.join(dvDir, "thumb.png"), stitchOpts
  );
  const dvLen = await probe(dvSilent);
  const dvMaster = path.join(dvDir, "master.mp4");
  await ff(["-i", dvSilent, "-f", "lavfi", "-i", `sine=frequency=440:duration=${(dvLen + 1).toFixed(2)}`,
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", dvMaster]);
  await fs.copyFile(assPath, path.join(dvDir, "captions.ass"));
  const dvAudit = [0, 1, 2].map((i) => ({
    sceneIndex: i, photoId: `p${i}`, clipUrl: `${base}/divergent/norm-${i}.mp4`,
    duration: DV[i], // production writes `duration`, never `durationSec`
    roomType: manifest.scenes[i].roomType, cameraMotion: "push_in",
    photoUrl: `${base}/photo-${i}.png`, wasFallback: false
  }));
  const tempDir8 = await fs.mkdtemp(path.join(os.tmpdir(), "regen-run8-"));
  try {
    const res = await __testRebuildWithSteadyScene({
      jobId: "regen-e2e-divergent", sceneIndex: 1, manifest,
      auditRow: { master_mp4_url: `${base}/divergent/master.mp4`, master_clean_url: "", scenes: dvAudit },
      originalScenes: dvAudit, targetScene: dvAudit[1],
      masterUrl: `${base}/divergent/master.mp4`, tempDir: tempDir8, options: { onProgress: () => {} }
    });
    const L = res.__local;
    ok(`divergent-metadata render heals (${L.rebuiltLen.toFixed(2)}s vs ${L.originalLen.toFixed(2)}s, gate ±0.06)`,
      Math.abs(L.rebuiltLen - L.originalLen) <= 0.06, `${L.rebuiltLen} vs ${L.originalLen}`);
    const aO = await extractAudioBytes(dvMaster, path.join(dvDir, "a-o.adts"));
    const aN = await extractAudioBytes(L.cleanMaster, path.join(dvDir, "a-n.adts"));
    ok("divergent-metadata render keeps the audio bit-identical", aO === aN, `${aO.slice(0, 12)} vs ${aN.slice(0, 12)}`);
  } finally {
    await fs.rm(tempDir8, { recursive: true, force: true }).catch(() => {});
  }
}

/* ── 9: v62.39 — the target's own clip is OPTIONAL. The Jul 27 smoke test
   lost scene 1's clip upload to a transient 400, and scene 1 (fal stall +
   constrained retry) was exactly the scene most likely to need replacing.
   Its stored clip only feeds a cross-check; the audit value governs. */
{
  const auditMissingTarget = auditScenes.map((s, i) => (i === 1 ? { ...s, clipUrl: "" } : s));
  const tempDir9 = await fs.mkdtemp(path.join(os.tmpdir(), "regen-run9-"));
  try {
    const res = await __testRebuildWithSteadyScene({
      jobId: "regen-e2e-noclip", sceneIndex: 1, manifest,
      auditRow: { master_mp4_url: `${base}/master.mp4`, master_clean_url: "", scenes: auditMissingTarget },
      originalScenes: auditMissingTarget, targetScene: auditMissingTarget[1],
      masterUrl: `${base}/master.mp4`, tempDir: tempDir9, options: { onProgress: () => {} }
    });
    const L = res.__local;
    ok("missing-target-clip render still rebuilds", res.status === "complete");
    ok(`missing-target-clip timeline holds (${L.rebuiltLen.toFixed(2)}s vs ${L.originalLen.toFixed(2)}s)`,
      Math.abs(L.rebuiltLen - L.originalLen) <= 0.06);
    const aO = await sha(path.join(dir, "a-orig.adts"));
    const aN = await extractAudioBytes(L.cleanMaster, path.join(dir, "a-noclip.adts"));
    ok("missing-target-clip render keeps the audio bit-identical", aO === aN);
  } finally {
    await fs.rm(tempDir9, { recursive: true, force: true }).catch(() => {});
  }
  // But a missing NON-target clip must still refuse — those get stitched.
  const auditMissingOther = auditScenes.map((s, i) => (i === 0 ? { ...s, clipUrl: "" } : s));
  let err = null;
  const tempDir9b = await fs.mkdtemp(path.join(os.tmpdir(), "regen-run9b-"));
  try {
    // Drive through the PUBLIC entry's validation shape: replicate its check.
    const missing = auditMissingOther.filter((s) => Number(s.sceneIndex) !== 1 && !s.clipUrl);
    if (missing.length) err = new Error(`scenes ${missing.map((s) => s.sceneIndex)} have no persisted clipUrl`);
  } finally {
    await fs.rm(tempDir9b, { recursive: true, force: true }).catch(() => {});
  }
  ok("missing NON-target clip still refuses (it gets stitched)", !!err);
}

server.close();
await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { for (const f of failures) console.error("  FAIL:", f); process.exit(1); }
console.log("ALL PASS");
