// End-to-end proof for v62.36: synthetic narration timeline → trim plan →
// real ffmpeg audio cut → rebuilt grid. Nothing mocked except the voice.
//
// The synthetic voice is calibrated to the pace band this codebase already
// claims to have measured across real renders — voice-first.mjs: "Measured
// pace across real renders is 2.34-2.80 words/sec". I do NOT try to
// reproduce one remembered render's exact seconds; I sweep the band and
// check the machinery behaves correctly at every point in it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  buildVoiceGrid, planDurationTrim, shiftWordsAfterCuts, wordsToSentences
} from "../render-worker/src/voice-first.mjs";

const INTRA = 0.07;  // breath between words inside a sentence
const INTER = 0.52;  // the pause a voice takes at a full stop

// Build a word timeline whose OVERALL pace is exactly `wps`, with the
// gap structure real speech has. Articulation is solved for, so sentence
// count and word count vary independently — which is the whole point.
function synth(wordsPerSentence, wps) {
  const W = wordsPerSentence.reduce((a, b) => a + b, 0);
  const S = wordsPerSentence.length;
  const artic = (W / wps - (W - S) * INTRA - (S - 1) * INTER) / W;
  if (artic <= 0) throw new Error(`unreachable pace ${wps} w/s for ${W}w/${S}s`);
  const words = [], sentences = [];
  let t = 0.9; // aligners rarely start at 0
  wordsPerSentence.forEach((n, si) => {
    const toks = [];
    for (let i = 0; i < n; i++) {
      words.push({ word: `w${si}_${i}`, start: +t.toFixed(4), end: +(t + artic).toFixed(4) });
      toks.push(`w${si}_${i}`);
      t += artic + (i === n - 1 ? INTER : INTRA);
    }
    sentences.push({ text: toks.join(" "), photos: [si] });
  });
  return { words, sentences, artic };
}
const gridOf = (s) => buildVoiceGrid({ sentences: s.sentences }, s.words);
const ceilingFor = (t) => t + Math.max(2, t * 0.08);

let pass = 0, fail = 0;
const ck = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.error("  FAIL:", n, d); } };

/* ── 1. The premise: at a FIXED articulation rate, sentence count alone
      moves both the duration and the apparent w/s. This is why a word
      budget cannot be converted to seconds. (synth() normally solves
      articulation to hit a target w/s — here we hold articulation fixed
      instead, which is what a real voice does.) ── */
function synthFixedArtic(wordsPerSentence, artic) {
  const words = [], sentences = [];
  let t = 0.9;
  wordsPerSentence.forEach((n, si) => {
    const toks = [];
    for (let i = 0; i < n; i++) {
      words.push({ word: `w${si}_${i}`, start: +t.toFixed(4), end: +(t + artic).toFixed(4) });
      toks.push(`w${si}_${i}`);
      t += artic + (i === n - 1 ? INTER : INTRA);
    }
    sentences.push({ text: toks.join(" "), photos: [si] });
  });
  return { words, sentences };
}
console.log("80 words, one fixed articulation rate, different sentence counts:");
const shapes = [[80], [40, 40], [16, 11, 10, 10, 9, 9, 8, 7], Array(12).fill(0).map((_, i) => (i < 8 ? 7 : 6))];
const rows = shapes.map((sh) => {
  const g = gridOf(synthFixedArtic(sh, 0.33));
  console.log(`   ${String(sh.length).padStart(2)} sentences -> ${g.videoEndSec.toFixed(1)}s video, ${g.stats.wps} w/s`);
  return { end: g.videoEndSec, wps: g.stats.wps, n: sh.length };
});
ck("more sentences = longer video at identical word count",
  rows.every((r, i) => i === 0 || r.end > rows[i - 1].end), JSON.stringify(rows.map((r) => r.end)));
ck("apparent w/s FALLS as sentence count rises — the rate is not a constant",
  rows.every((r, i) => i === 0 || r.wps < rows[i - 1].wps), JSON.stringify(rows.map((r) => r.wps)));
ck("the spread across sentence counts is material (>3s on a 30s order)",
  rows[rows.length - 1].end - rows[0].end > 3, `${(rows[rows.length - 1].end - rows[0].end).toFixed(2)}s`);

/* ── 2. Across the measured pace band, where does an 80-word script land? ── */
const SHAPE = [16, 11, 10, 10, 9, 9, 8, 7]; // 80 words / 8 sentences
console.log(`\n80 words / 8 sentences across the 2.34-2.80 w/s measured band (30s order, ceiling ${ceilingFor(30).toFixed(1)}s):`);
const band = [2.20, 2.34, 2.50, 2.68, 2.80];
let firedAt = 0, heldAt = 0;
for (const wps of band) {
  const s = synth(SHAPE, wps);
  const g = gridOf(s);
  const plan = planDurationTrim(wordsToSentences(s.sentences, s.words), g.videoEndSec, 30,
    { photosPerSentence: s.sentences.map((x) => x.photos.length) });
  const over = g.videoEndSec > ceilingFor(30);
  console.log(`   ${wps.toFixed(2)} w/s -> ${g.videoEndSec.toFixed(1)}s  ${over ? "OVER " : "in   "} ${plan ? `trim drops [${plan.drop.map((k) => `s${k + 1}`)}] -> ${plan.projectedSec.toFixed(1)}s` : "no trim"}`);
  ck(`trim fires iff over ceiling @ ${wps} w/s`, over === !!plan);
  if (plan) { firedAt++; ck(`@${wps}: lands in band`, plan.projectedSec <= ceilingFor(30) && plan.projectedSec >= 22.5, `${plan.projectedSec}`); }
  else heldAt++;
}
ck("the band straddles the ceiling (some trim, some don't)", firedAt > 0 && heldAt > 0, `${firedAt} fired / ${heldAt} held`);

/* ── 3. Full apply at the slow end, where the contract is actually broken ── */
const S3 = synth(SHAPE, 2.20);
const grid0 = gridOf(S3);
const perSentence = wordsToSentences(S3.sentences, S3.words);
ck("every sentence got its words", perSentence.every((r) => r.length > 0));
const plan = planDurationTrim(perSentence, grid0.videoEndSec, 30,
  { photosPerSentence: S3.sentences.map((s) => s.photos.length) });
ck("a trim is planned at 2.20 w/s", !!plan);
if (!plan) { console.error("cannot continue"); process.exit(1); }
ck("hook is never dropped", !plan.drop.includes(0));
ck("CTA is never dropped", !plan.drop.includes(SHAPE.length - 1));
ck("lands inside the ceiling", plan.projectedSec <= ceilingFor(30), `${plan.projectedSec}`);
ck("does not fall through the floor", plan.projectedSec >= 22.5, `${plan.projectedSec}`);

const droppedSet = new Set(plan.drop);
const survivors = S3.sentences.filter((_, i) => !droppedSet.has(i));
const keepOrd = survivors.flatMap((s) => s.photos).sort((a, b) => a - b);
const renum = new Map(keepOrd.map((o, i) => [o, i]));
const newSentences = survivors.map((s) => ({ text: s.text, photos: s.photos.map((o) => renum.get(o)) }));
const newWords = shiftWordsAfterCuts(S3.words, plan.spans);
const grid1 = buildVoiceGrid({ sentences: newSentences }, newWords);
console.log(`\napply: ${grid0.videoEndSec.toFixed(1)}s / ${grid0.scenes.length} scenes -> ${grid1.videoEndSec.toFixed(1)}s / ${grid1.scenes.length} scenes (30s order)`);
ck("rebuilt grid matches the prediction within 50ms",
  Math.abs(grid1.videoEndSec - plan.projectedSec) < 0.05, `predicted ${plan.projectedSec}, actual ${grid1.videoEndSec}`);
ck("one scene per surviving photo", grid1.scenes.length === keepOrd.length);
ck("no photos dropped by the rebuild", grid1.stats.droppedPhotos.length === 0);
ck("ordinals dense and ascending", grid1.scenes.every((s, i) => s.photoOrdinal === i));
// The cut must remove EXACTLY the dropped sentences' words — no more (it
// would eat a neighbour's opening word) and no fewer (a stray word from a
// dropped sentence would play over the wrong room). Labels are unique, so
// compare identities, not just counts. Note newWords are in the SHIFTED
// timeline; the span test below must run against the ORIGINAL words.
const expectSurvive = S3.words.filter((w) => !droppedSet.has(Number(w.word.split("_")[0].slice(1))));
ck("cut removes exactly the dropped sentences' words, no neighbours",
  newWords.length === expectSurvive.length &&
  newWords.every((w, i) => w.word === expectSurvive[i].word),
  `${newWords.length} kept vs ${expectSurvive.length} expected`);
ck("every original word inside a span is gone",
  S3.words.filter((w) => plan.spans.some((s) => w.end > s.start && w.start < s.end))
    .every((w) => !newWords.some((n) => n.word === w.word)));
ck("surviving word count = original minus dropped sentences",
  newWords.length === 80 - plan.drop.reduce((a, k) => a + SHAPE[k], 0), `${newWords.length}`);
ck("each surviving word shifted by exactly the span time before it",
  newWords.every((n) => {
    const orig = S3.words.find((w) => w.word === n.word);
    const shift = plan.spans.filter((s) => orig.start >= s.end).reduce((a, s) => a + (s.end - s.start), 0);
    return Math.abs((orig.start - shift) - n.start) < 1e-3;
  }));
ck("first word untouched, so the audio offset stays put", newWords[0].start === S3.words[0].start);
ck("no negative or out-of-order timestamps",
  newWords.every((w, i) => w.start >= 0 && w.end > w.start && (i === 0 || w.start >= newWords[i - 1].end - 1e-6)));

/* ── 4. REAL ffmpeg cut ── */
const dur = S3.words[S3.words.length - 1].end + 1.2;
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i",
  `sine=frequency=220:duration=${dur.toFixed(3)}`, "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "/tmp/vf-src.mp3"]);
const probe = (p) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).toString().trim());
const srcSec = probe("/tmp/vf-src.mp3");
const keep = [];
let cursor = 0;
for (const s of [...plan.spans].sort((a, b) => a.start - b.start)) {
  if (s.start > cursor + 0.01) keep.push([cursor, s.start]);
  cursor = Math.max(cursor, s.end);
}
keep.push([cursor, null]);
const parts = keep.map(([a, b], i) => `[0:a]atrim=start=${a.toFixed(4)}${b === null ? "" : `:end=${b.toFixed(4)}`},asetpts=N/SR/TB[k${i}]`);
const filter = `${parts.join(";")};${keep.map((_, i) => `[k${i}]`).join("")}concat=n=${keep.length}:v=0:a=1[out]`;
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", "/tmp/vf-src.mp3", "-filter_complex", filter,
  "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "/tmp/vf-cut.mp3"]);
const cutSec = probe("/tmp/vf-cut.mp3");
const removed = plan.spans.reduce((a, s) => a + (s.end - s.start), 0);
console.log(`ffmpeg: ${srcSec.toFixed(3)}s -> ${cutSec.toFixed(3)}s (expected ${(srcSec - removed).toFixed(3)}, removed ${removed.toFixed(3)})`);
ck("real audio cut removes exactly the planned time (±60ms mp3 framing)",
  Math.abs(cutSec - (srcSec - removed)) < 0.06, `${cutSec} vs ${(srcSec - removed).toFixed(3)}`);
ck("cut audio still covers every word the rebuilt grid expects",
  cutSec + 0.06 >= newWords[newWords.length - 1].end, `${cutSec} vs last word ${newWords[newWords.length - 1].end}`);

/* ── 5. Refuse to act when nothing is wrong ── */
const okS = synth([10, 9, 9, 8, 8, 7], 2.5);
const okG = gridOf(okS);
ck("in-band narration left completely alone",
  planDurationTrim(wordsToSentences(okS.sentences, okS.words), okG.videoEndSec, 30) === null, `${okG.videoEndSec}s`);
ck("a 60s order does not trim a 37s script", planDurationTrim(perSentence, grid0.videoEndSec, 60) === null);
ck("no target = no action", planDurationTrim(perSentence, grid0.videoEndSec, 0) === null);
const tinyS = synth([40, 40, 40], 2.2);
ck("3-sentence script is never cut (nothing but hook and CTA)",
  planDurationTrim(wordsToSentences(tinyS.sentences, tinyS.words), gridOf(tinyS).videoEndSec, 30) === null);
const bigS = synth(Array(14).fill(9), 2.2);
const bigPlan = planDurationTrim(wordsToSentences(bigS.sentences, bigS.words), gridOf(bigS).videoEndSec, 30,
  { photosPerSentence: bigS.sentences.map((s) => s.photos.length) });
ck("never cuts below the 5-scene floor",
  !bigPlan || 14 - bigPlan.drop.length >= 5, `${bigPlan ? 14 - bigPlan.drop.length : "n/a"} left`);
console.log(`14-scene / 126-word script @2.2 w/s: ${gridOf(bigS).videoEndSec.toFixed(1)}s -> ${bigPlan ? `${bigPlan.projectedSec.toFixed(1)}s, ${14 - bigPlan.drop.length} scenes` : "no trim"}`);

/* ── 6. v62.36a: the out-of-range span that used to desync silently ──
   atrim past EOF yields an empty segment and concat accepts it, so the cut
   removes less than asked while shiftWordsAfterCuts moves every later word
   by the full amount. Adversarial review measured +8.0s of silent drift.
   cutAudioSpans now measures its own output. Prove the guard fires. */
{
  const vfMod = await import("../render-worker/src/voice-first.mjs");
  const src = "/tmp/vf-guard.mp3";
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=40",
    "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", src]);
  const srcD = probe(src);
  const cut = vfMod.__testCutAudioSpans;
  ck("cutAudioSpans is reachable for test", typeof cut === "function");
  if (typeof cut === "function") {
    // honest span — must succeed and land on the arithmetic
    const okOut = await cut({ audioPath: src, spans: [{ start: 10, end: 15 }], tempDir: "/tmp", jobId: "guard-ok" });
    ck("honest span still succeeds", Math.abs(probe(okOut) - (srcD - 5)) < 0.15, `${probe(okOut)} vs ${srcD - 5}`);
    fs.rmSync(okOut, { force: true });
    // span running 8s past EOF — the silent-desync case
    let threw = null;
    try { await cut({ audioPath: src, spans: [{ start: 30, end: 48 }], tempDir: "/tmp", jobId: "guard-bad" }); }
    catch (e) { threw = e.message; }
    ck("out-of-range span is REFUSED, not silently shortened", !!threw, `no throw`);
    ck("the refusal names the arithmetic", !!threw && /refusing to desync the stem/.test(threw), threw || "");
    ck("the refused cut leaves no orphan mp3", !fs.existsSync("/tmp/guard-bad-vf-trimmed.mp3"));
    console.log(`guard: span [30,48] on a ${srcD.toFixed(2)}s file -> ${threw ? "REFUSED" : "ACCEPTED (BAD)"}`);
    // span entirely past EOF
    let threw2 = null;
    try { await cut({ audioPath: src, spans: [{ start: 50, end: 60 }], tempDir: "/tmp", jobId: "guard-bad2" }); }
    catch (e) { threw2 = e.message; }
    ck("span entirely past EOF is refused", !!threw2, "no throw");
  }
  fs.rmSync(src, { force: true });
}

fs.rmSync("/tmp/vf-src.mp3", { force: true });
fs.rmSync("/tmp/vf-cut.mp3", { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
