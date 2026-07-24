// Mocked end-to-end test for prepareVoiceFirst: stubs global.fetch for the
// three ElevenLabs endpoints and exercises rung selection, photoId→ordinal
// mapping, unmapped-scene linger, and grid/caption assembly.
// Run: node render-worker/src/voice-first.e2e.test.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

process.env.ELEVENLABS_API_KEY = "test-key";

const { prepareVoiceFirst, stripAudioTags } = await import("../src/voice-first.mjs");

let failures = 0;
const ok = (cond, label) => {
  if (!cond) { failures++; console.error("  FAIL:", label); }
  else console.log("  ok:", label);
};

const MONOLOGUE = "[warm] Welcome to Desert Vista, where the views do the talking. The kitchen's ready for anything. [pause] Out back, the pool waits. Come see it this weekend.";
const SENTENCES = [
  { text: "Welcome to Desert Vista, where the views do the talking.", photos: ["p1"] },
  { text: "The kitchen's ready for anything.", photos: ["p2"] },
  { text: "Out back, the pool waits.", photos: ["p4"] },   // p3 deliberately unmapped
  { text: "Come see it this weekend.", photos: ["p5"] },
];
const CLEAN = SENTENCES.map((s) => s.text).join(" ");

function fakeWords(text, wps = 2.5) {
  const words = [];
  let t = 0.15;
  for (const tok of text.split(/\s+/)) {
    words.push({ text: tok, start: +t.toFixed(3), end: +(t + 1 / wps - 0.05).toFixed(3) });
    t += 1 / wps;
    if (/[.!?]$/.test(tok)) t += 0.4;
  }
  return words;
}

function makeFetch({ v3Fails = false, alignFails = false } = {}) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes("/forced-alignment")) {
      if (alignFails) return { ok: false, status: 500, text: async () => "align down" };
      // The form carries the clean transcript; align it with fake timing.
      const text = opts.body.get("text");
      return { ok: true, json: async () => ({ words: fakeWords(text) }) };
    }
    if (u.includes("/with-timestamps")) {
      const body = JSON.parse(opts.body);
      const words = fakeWords(body.text);
      const characters = [];
      const cs = [];
      const ce = [];
      for (const w of words) {
        for (let i = 0; i < w.text.length; i++) {
          characters.push(w.text[i]);
          cs.push(w.start + (i / w.text.length) * (w.end - w.start));
          ce.push(w.start + ((i + 1) / w.text.length) * (w.end - w.start));
        }
        characters.push(" ");
        cs.push(w.end);
        ce.push(w.end);
      }
      return {
        ok: true,
        json: async () => ({
          audio_base64: Buffer.from("fake-mp3").toString("base64"),
          alignment: { characters, character_start_times_seconds: cs, character_end_times_seconds: ce }
        })
      };
    }
    if (u.includes("/text-to-speech/")) {
      if (v3Fails) return { ok: false, status: 422, text: async () => "v3 rejected" };
      const body = JSON.parse(opts.body);
      ok(body.model_id === "eleven_v3", "v3 rung uses eleven_v3");
      ok(body.text === MONOLOGUE, "v3 reads the TAGGED monologue verbatim");
      return { ok: true, arrayBuffer: async () => Buffer.from("fake-mp3-v3").buffer };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}

const photoScenes = ["p1", "p2", "p3", "p4", "p5"].map((id) => ({ photoId: id, duration: 3.4 }));
const manifest = {
  narration: { monologue: MONOLOGUE, sentences: SENTENCES, direction: "warm tour guide" },
  brandKit: { voiceId: "test-voice" }
};
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vf-test-"));

// ── Case 1: expressive rung succeeds ──────────────────────────────────
console.log("\n== rung 1: v3 + forced alignment");
globalThis.fetch = makeFetch();
const r1 = await prepareVoiceFirst({ manifest, photoScenes, tempDir, jobId: "t1", resolveVoice: (v) => v || "fallback" });
ok(r1 && r1.rung === "v3+forced-align", `rung = ${r1?.rung}`);
ok(r1.grid.scenes.length === 5, `grid covers all 5 scenes (got ${r1.grid.scenes.length})`);
ok(r1.grid.scenes.map((s) => s.photoOrdinal).join(",") === "0,1,2,3,4", "scene order preserved incl. unmapped p3 (lingered)");
ok(r1.captionWords.length === CLEAN.split(/\s+/).length, "every word captioned");
ok(r1.captionWords.filter((w) => w.lineStart).length === 4, "4 caption line starts (one per sentence)");
ok(Math.abs(r1.grid.scenes[0].start) < 1e-9 && r1.grid.videoEndSec > 10, "grid timeline sane");
ok(r1.grid.sentenceSpansSec.every(Boolean), "sentence spans complete");

// ── Case 2: v3 down → proven rung ─────────────────────────────────────
console.log("\n== rung 2: v3 fails → with-timestamps fallback");
globalThis.fetch = makeFetch({ v3Fails: true });
const r2 = await prepareVoiceFirst({ manifest, photoScenes, tempDir, jobId: "t2", resolveVoice: (v) => v });
ok(r2 && /timestamps/.test(r2.rung), `rung = ${r2?.rung}`);
ok(r2.grid.scenes.length === 5, "fallback rung still grids all scenes");

// ── Case 3: alignment down → proven rung ──────────────────────────────
console.log("\n== rung 2b: forced-align fails → with-timestamps fallback");
globalThis.fetch = makeFetch({ alignFails: true });
const r3 = await prepareVoiceFirst({ manifest, photoScenes, tempDir, jobId: "t3", resolveVoice: (v) => v });
ok(r3 && /timestamps/.test(r3.rung), `rung = ${r3?.rung}`);

// ── Case 4: structural failures return null (legacy path) ─────────────
console.log("\n== structural failures fail open");
globalThis.fetch = makeFetch();
const badOrder = {
  ...manifest,
  narration: { ...manifest.narration, sentences: [
    { text: "One.", photos: ["p2"] }, { text: "Two.", photos: ["p1"] }
  ] }
};
ok((await prepareVoiceFirst({ manifest: badOrder, photoScenes, tempDir, jobId: "t4", resolveVoice: (v) => v })) === null, "out-of-order mapping → null");
ok((await prepareVoiceFirst({ manifest: { narration: null }, photoScenes, tempDir, jobId: "t5", resolveVoice: (v) => v })) === null, "missing narration → null");
delete process.env.ELEVENLABS_API_KEY;
ok((await prepareVoiceFirst({ manifest, photoScenes, tempDir, jobId: "t6", resolveVoice: (v) => v })) === null, "missing API key → null");
process.env.ELEVENLABS_API_KEY = "test-key";

// ── Case 5: VOICE_FIRST_V3=0 pins the proven rung ─────────────────────
console.log("\n== VOICE_FIRST_V3=0 pins proven rung");
process.env.VOICE_FIRST_V3 = "0";
const r5 = await prepareVoiceFirst({ manifest, photoScenes, tempDir, jobId: "t7", resolveVoice: (v) => v });
ok(r5 && /timestamps/.test(r5.rung), `rung = ${r5?.rung}`);
delete process.env.VOICE_FIRST_V3;

ok(stripAudioTags(MONOLOGUE) === CLEAN, "monologue strips to exact sentence join");

await fs.rm(tempDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
