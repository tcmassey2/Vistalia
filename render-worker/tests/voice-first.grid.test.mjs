// Simulation harness for voice-first.mjs grid math (no network, no ffmpeg).
// Run: node render-worker/src/voice-first.test.mjs
import {
  buildVoiceGrid, stripAudioTags, wordsToSentences,
  LEAD_IN_SEC, TAIL_PAD_SEC, MIN_SCENE_SEC, MAX_SCENE_VISIBLE_SEC
} from "../src/voice-first.mjs";

let failures = 0;
const ok = (cond, label) => {
  if (!cond) { failures++; console.error("  FAIL:", label); }
  else console.log("  ok:", label);
};

function synthWords(sentences, { wps = 2.55, sentencePause = 0.42, commaPause = 0.22 } = {}) {
  const words = [];
  let tCur = 0.12;
  const wordDur = 1 / wps - 0.06;
  for (const s of sentences) {
    for (const tok of s.text.split(/\s+/)) {
      words.push({ word: tok, start: +tCur.toFixed(3), end: +(tCur + wordDur).toFixed(3) });
      tCur += wordDur + 0.06;
      if (/,$/.test(tok)) tCur += commaPause;
    }
    tCur += sentencePause;
  }
  return words;
}

function scenario(name, sentences, opts = {}) {
  console.log("\n== " + name);
  const words = synthWords(sentences, opts.synth);
  const grid = buildVoiceGrid({ sentences }, words, opts.grid);
  const { scenes, stats } = grid;
  ok(scenes[0].start === 0, "first scene starts at 0");
  for (let i = 1; i < scenes.length; i++) {
    ok(Math.abs(scenes[i].start - scenes[i - 1].end) < 1e-6, `scene ${i} contiguous`);
  }
  ok(stats.minSceneSec >= MIN_SCENE_SEC - 1e-6, `min scene ${stats.minSceneSec}s >= ${MIN_SCENE_SEC}s`);
  ok(stats.maxSceneSec <= MAX_SCENE_VISIBLE_SEC + 1e-6, `max scene ${stats.maxSceneSec}s <= ${MAX_SCENE_VISIBLE_SEC}s (spill enforced)`);
  const seq = scenes.map((s) => s.photoOrdinal);
  ok(seq.every((p, i) => i === 0 || p > seq[i - 1]), "photo order strictly ascending, no repeats");
  const lastWordEnd = grid.narrationOffsetSec + words[words.length - 1].end;
  ok(grid.videoEndSec >= lastWordEnd - 1e-6, "video covers all speech");
  ok(grid.narrationOffsetSec + words[0].start >= LEAD_IN_SEC - 1e-6, "lead-in before first word");
  console.log("  stats:", JSON.stringify(stats));
  console.log("  video:", grid.videoEndSec + "s, scenes:", seq.join(","));
  return grid;
}

// 1: spec shape — 83w / 7 sentences / 9 photos (m80's scene count).
const S1 = [
  { text: "Welcome to 24024 North Pinnacle Peak, a five bedroom estate with views that stop you mid sentence.", photos: [0] },
  { text: "Step through the entry and the great room opens around you, all light and stone.", photos: [1] },
  { text: "The kitchen's built for real cooking, double islands, pro range, room for everyone.", photos: [2, 3] },
  { text: "Each of the five suites feels like its own retreat.", photos: [4, 5] },
  { text: "Out back, the pool runs to the edge of the desert.", photos: [6] },
  { text: "Evenings here are what Arizona was made for.", photos: [7] },
  { text: "Come see it in person, this one won't wait.", photos: [8] },
];
const g1 = scenario("spec shape: 83w / 7 sentences / 9 photos", S1);
ok(g1.stats.sceneCount === 9, "all 9 photos got scenes");
ok(g1.stats.droppedPhotos.length === 0, "no drops");
ok(g1.sentenceSpansSec.length === 7 && g1.sentenceSpansSec.every(Boolean), "sentence spans complete");

// 2: degenerate 2-line collapse class — must still yield a watchable grid.
const S2 = [
  { text: "Welcome to 1000 Canary Court, a home that photographs like a dream.", photos: [0, 1, 2, 3] },
  { text: "Schedule your private tour today.", photos: [4, 5, 6, 7, 8] },
];
const g2 = scenario("degenerate: 2 sentences / 9 photos (fallback class)", S2);
ok(g2.stats.sceneCount + g2.stats.droppedPhotos.length === 9, "photos shown or honestly dropped");

// 3: 60s luxury with hero linger + a monster sentence (spill test).
const S3 = [
  { text: "Tucked behind private gates in Silverleaf, this residence rewrites what a desert estate can be, from the moment the pivot door swings open onto twenty two foot ceilings and a wall of glass framing Camelback Mountain like a private painting.", photos: [0] },
  { text: "Nearly nine thousand square feet, and not one of them wasted.", photos: [1] },
  { text: "A chef's kitchen anchors the heart of the home, twin islands, custom walnut, quiet luxury everywhere.", photos: [2, 3] },
  { text: "The primary wing is a world of its own.", photos: [4] },
  { text: "Four more suites give family and guests room to breathe.", photos: [5, 6] },
  { text: "Outside, the resort begins, negative edge pool, sunken fire lounge, and a kitchen built for hundred degree evenings.", photos: [7, 8] },
  { text: "A separate casita keeps visits easy and private.", photos: [9] },
  { text: "Sunsets from the upper terrace go on for miles.", photos: [10] },
  { text: "Homes like this reach the market once a decade.", photos: [11] },
  { text: "Your private showing is one call away.", photos: [] },
];
const g3 = scenario("60s luxury: monster opener spills, CTA lingers", S3);
ok(g3.stats.warnings.some((w) => /spills/.test(w)), "monster sentence spilled (warned)");
ok(new Set(g3.scenes.map((s) => s.photoOrdinal)).size === 12, "all 12 photos distinct");

// 4: tag strip + transcript integrity.
const tagged = "[warm] Welcome home. [pause] The kitchen's ready, [excited] and the views go on forever.";
ok(stripAudioTags(tagged) === "Welcome home. The kitchen's ready, and the views go on forever.", "tag strip exact");

// 5: fast clone — run merges keep min scene honest.
const g5 = scenario("fast clone 3.4wps: 8 sentences / 10 photos", [
  { text: "Welcome to Desert Ridge.", photos: [0] },
  { text: "Five beds, five and a half baths.", photos: [1] },
  { text: "Chef's kitchen.", photos: [2] },
  { text: "Split floor plan with dual primaries.", photos: [3, 4] },
  { text: "Home theater and a gym.", photos: [5] },
  { text: "Heated pool and spa.", photos: [6, 7] },
  { text: "Three car garage.", photos: [8] },
  { text: "Priced to move, come tour it today.", photos: [9] },
], { synth: { wps: 3.4, sentencePause: 0.3 } });
ok(g5.stats.minSceneSec >= MIN_SCENE_SEC - 1e-6, "fast pace respects min scene");

// 5b: monster FINAL run — backward spill: previous scene holds, no speech lost.
const S5b = [
  { text: "Welcome to the estate.", photos: [0] },
  { text: "The kitchen anchors everything.", photos: [1] },
  { text: "And then there's the closing pitch, a long unhurried meditation on desert light, resale value, school districts, morning coffee on the terrace, and the particular silence money buys, before we finally invite you to call.", photos: [2] },
];
const g5b = scenario("monster CTA: backward spill keeps all speech", S5b);
ok(g5b.stats.warnings.some((w) => /previous scene holds|ALERT/.test(w)), "backward spill warned");
{
  const wordsAll = synthWords(S5b);
  const lastEnd = g5b.narrationOffsetSec + wordsAll[wordsAll.length - 1].end;
  ok(g5b.videoEndSec >= lastEnd + TAIL_PAD_SEC - 1e-6, "video still covers ALL speech incl. tail pad");
}

// 6: wordsToSentences resyncs on tokenizer drift (numerals).
const drift = wordsToSentences(
  [{ text: "Welcome to 24024 North Pinnacle Peak today." }],
  [
    { word: "Welcome", start: 0, end: 0.3 }, { word: "to", start: 0.3, end: 0.4 },
    { word: "twenty", start: 0.4, end: 0.6 }, { word: "four", start: 0.6, end: 0.8 },
    { word: "thousand", start: 0.8, end: 1.0 }, { word: "twenty", start: 1.0, end: 1.2 },
    { word: "four", start: 1.2, end: 1.4 }, { word: "North", start: 1.4, end: 1.6 },
    { word: "Pinnacle", start: 1.6, end: 1.9 }, { word: "Peak", start: 1.9, end: 2.1 },
    { word: "today", start: 2.1, end: 2.4 },
  ]
);
ok(drift[0].length === 11, "trailing tokenizer extras ride the last sentence");

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
