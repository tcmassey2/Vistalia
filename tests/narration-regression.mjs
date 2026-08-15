// Vistalia — narration regression suite (v53.8).
//
// Born the night of m73 ("every time we fix one thing it breaks 2 other
// things"). Narration is a seven-stage chain — plan → verify → polish →
// clamp → TTS → mixer → captions — and every defect we ever shipped was a
// cross-stage interaction that stage-local testing missed. This suite
// makes each shipped defect a PERMANENT fixture: run it before any change
// to create-edit-plan.js, voice-mixer.mjs, or captions.mjs.
//
//   node tests/narration-regression.mjs      (exit 1 on any failure)
//
// It tests the deterministic layers (clamp, floor, caption grouping) by
// extracting them from source — no API keys, no network — plus prompt
// lint: the LLM prompts must keep carrying the rules the fixtures encode.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const planSrc = fs.readFileSync(path.join(ROOT, "api/create-edit-plan.js"), "utf8");
const capSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/captions.mjs"), "utf8");

// Paren-aware function extraction (destructured params broke the naive
// brace counter — v55 webhook harness lesson).
function grab(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i === -1) throw new Error(`missing function ${name}`);
  const j = src.indexOf("{", src.indexOf(")", i));
  let d = 1, k = j + 1;
  while (d > 0 && k < src.length) {
    const c = src[k];
    if (c === "{") d++;
    else if (c === "}") d--;
    k++;
  }
  return src.slice(i, k);
}
eval(`globalThis.clamp = ${grab(planSrc, "clampNarrationSentenceSafe").replace(/^function \w+/, "function")}`);
eval(`globalThis.floor = ${grab(planSrc, "enforceNarrationFloor").replace(/^function \w+/, "function")}`);
eval(`globalThis.groupWords = ${grab(capSrc, "groupWords").replace(/^export function \w+/, "function").replace(/^function \w+/, "function")}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const lastWord = (s) => String(s || "").replace(/[.\s]+$/, "").split(/\s+/).pop() || "";
// The complete set of endings that have SHIPPED in a customer video. A
// clamp output ending on any of these is a regression, full stop.
const SHIPPED_BAD_ENDINGS = /^(crowns?|fills?|adds?|blends?|complements?|compliments?|beneath|along|features?|boasts?|provides?|is|outdoor|welcoming|inviting|envelops?|striking)$/i;

/* ── m27/m66/m70-72: clamp must never emit a shipped-defect ending ── */
const clampCases = [
  ["A gleaming metal roof crowns the home.", 4],                       // m71
  ["Natural light fills the space.", 3],                               // m71
  ["The brick exterior adds character.", 3],                           // m72
  ["Durable granite countertops blend beautifully.", 3],               // m72
  ["Timeless tile work complements the design.", 4],                   // m72
  ["The kitchen features generous cabinetry beneath the counters.", 5],// m70
  ["A sheltered porch invites quiet outdoor living.", 5],              // m71
  ["The kitchen boasts premium appliances everywhere.", 3],            // m27
  ["The office is bathed in warm natural light.", 6],                  // m38
  ["Tall wood cabinetry envelops the kitchen walls.", 3],              // Jul 27 (v62.43)
  ["Unique textures define the fireplace's striking presence.", 5],    // Jul 27 (v62.43)
];
for (const [text, budget] of clampCases) {
  const out = clamp(text, budget);
  check(`clamp("${text.slice(0, 32)}…", b=${budget}) ending`, !SHIPPED_BAD_ENDINGS.test(lastWord(out)), `got "${out}"`);
  check(`clamp("${text.slice(0, 32)}…") no 1-2 word fragment`, out === "" || out.split(/\s+/).length >= 3, `got "${out}"`);
}

/* ── regressions that must SURVIVE the clamp untouched ── */
check("copula-adj survives (m38)", clamp("The office is bright.", 6) === "The office is bright.");
check("object verb survives", clamp("Sliding doors extend the living area.", 6) === "Sliding doors extend the living area.");
check("adverb ending survives", clamp("This stunning residence stands proudly.", 6) === "This stunning residence stands proudly.");

/* ── m71 line 1: addresses are never chopped mid-address ── */
const addr = clamp("Experience 356A County Road 7's welcoming charm.", 6);
check("address never chopped (m71)", !/\d/.test(addr) || addr.includes("7's welcoming charm"), `got "${addr}"`);
const digitMid = clamp("This home offers 3 spacious bedrooms upstairs.", 5);
check("digit mid-line never dangles", lastWord(digitMid) !== "3", `got "${digitMid}"`);

/* ── m73: deterministic floor — dupes silenced, CTA forced ── */
const m73 = [
  "This home features a curved driveway.",
  "This living area features a fireplace.",
  "This living area features a fireplace.",
  "This living area features a modern fireplace.",
  "This living area.",
  "This kitchen features spacious islands and cabinetry.",
  "This kitchen features spacious islands.",
  "This kitchen features bright cabinetry.",
].map((l) => ({ narrationLine: l }));
const fr = floor(m73);
check("m73 floor silences exact dupes", fr.dupesSilenced === 1, JSON.stringify(fr));
check("m73 floor forces CTA", /tour/i.test(m73[7].narrationLine), m73[7].narrationLine);
check("m73 floor flags monotony", fr.openerMonotony === true, JSON.stringify(fr));
const healthy = [
  "A stone fireplace anchors the living room.",
  "Morning light pours across the island.",
  "Schedule your private tour today.",
].map((l) => ({ narrationLine: l }));
const fh = floor(healthy);
check("healthy script untouched by floor", fh.dupesSilenced === 0 && !fh.ctaForced && !fh.openerMonotony, JSON.stringify(fh));

/* ── m59-era: caption pages never straddle limits ── */
const capWords = [
  { text: "GATHERING", start: 0.0, end: 0.4, lineStart: true },
  { text: "A", start: 0.4, end: 0.5 },
  { text: "KITCHEN", start: 0.5, end: 0.9 },
  { text: "WITH", start: 2.2, end: 2.4 },   // >0.45s gap → new page
  { text: "LIGHT", start: 2.4, end: 2.8 },
];
const pages = groupWords(capWords);
check("caption pages ≤3 words", pages.every((p) => p.words.length <= 3), JSON.stringify(pages.map((p) => p.words.length)));
check("caption gap splits pages", pages.length >= 2, `${pages.length} pages`);
check("caption pages never overlap", pages.every((p, i) => i === 0 || pages[i - 1].end <= p.start), "overlap found");

/* ── prompt lint: the rules the fixtures encode must stay in the prompts ── */
check("polish prompt bans verb endings", planSrc.includes("Never end a line on a transitive verb"));
check("polish prompt teaches spoken length", planSrc.includes("SPOKEN length"));
check("polish prompt keeps CTA rule", planSrc.includes("NON-NEGOTIABLE") && planSrc.includes('"tour"'));
check("verify prompt bans the m73 template", planSrc.includes('NEVER the skeleton "This <room> features <thing>"'));
check("verify prompt keeps agreement rule", planSrc.includes('"this area", "these areas"'));
check("floor runs on polish failure path", /catch[\s\S]{0,400}enforceNarrationFloor|enforceNarrationFloor[\s\S]{0,200}narrationGuard/.test(planSrc));

/* ── v62.27 DURATION CEILING: voice-first makes the video as long as the voice ──
   The Jul 25 21:58 render: 30s order (9 scenes), Director returned 127 words
   against a 70-85 band, shipped a 47.7s video. There was a floor in code and
   a ceiling only in the prompt. This is the real script from that render. */
// v62.40: the word budget is a two-term measured model now (words + full-stop
// pauses) — extract it plus its constants so trimNar and the fixtures below
// use the CODE's numbers, never a hardcoded band.
eval(`globalThis.SPEECH_SEC_PER_WORD = ${(planSrc.match(/const SPEECH_SEC_PER_WORD = ([\d.]+)/) || [])[1]}`);
eval(`globalThis.SPEECH_SEC_PER_STOP = ${(planSrc.match(/const SPEECH_SEC_PER_STOP = ([\d.]+)/) || [])[1]}`);
eval(`globalThis.SPEECH_PAD_SEC = ${(planSrc.match(/const SPEECH_PAD_SEC = ([\d.]+)/) || [])[1]}`);
eval(`globalThis.expectedSentenceCount = ${grab(planSrc, "expectedSentenceCount").replace(/^function \w+/, "function")}`);
// v62.65: narrationWordBudget now consults the per-voice model — extract it too.
eval(`globalThis.VOICE_SPEECH_MODELS = ${(planSrc.match(/const VOICE_SPEECH_MODELS = (\{[\s\S]*?\});/) || [])[1]}`);
eval(`globalThis.speechModelFor = ${grab(planSrc, "speechModelFor").replace(/^function \w+/, "function")}`);
eval(`globalThis.narrationWordBudget = ${grab(planSrc, "narrationWordBudget").replace(/^function \w+/, "function")}`);
eval(`globalThis.trimNar = ${grab(planSrc, "trimNarrationToBudget").replace(/^function \w+/, "function")}`);

/* ── v62.40: the budget model must keep reproducing the calibrated renders.
   These two rows are REAL production measurements (worker CALIBRATION
   lines, Jul 27). If someone edits the constants, these fixtures demand
   the new constants still explain the observed physics. */
{
  const CALIBRATED = [
    { words: 78, sentences: 5, measuredSec: 37.5 },
    { words: 82, sentences: 5, measuredSec: 37.7 }
  ];
  for (const r of CALIBRATED) {
    const pred = SPEECH_PAD_SEC + r.words * SPEECH_SEC_PER_WORD + (r.sentences - 1) * SPEECH_SEC_PER_STOP;
    check(`v62.40: model reproduces the ${r.words}w calibrated render within 1.5s`,
      Math.abs(pred - r.measuredSec) < 1.5, `predicted ${pred.toFixed(1)} vs ${r.measuredSec}`);
  }
  const b30 = narrationWordBudget(30), b60 = narrationWordBudget(60);
  check(`v62.40: 30s budget is honest (~64w, was 78)`, b30 >= 58 && b30 <= 70, String(b30));
  check(`v62.40: 60s budget is honest (~132w, was 155)`, b60 >= 120 && b60 <= 145, String(b60));
  // A budget-sized script must land INSIDE the worker's trim ceiling — the
  // whole point of the retune is that typical renders stop trimming.
  for (const [t, b] of [[30, b30], [60, b60]]) {
    const stops = expectedSentenceCount(t) - 1;
    const lands = SPEECH_PAD_SEC + b * SPEECH_SEC_PER_WORD + stops * SPEECH_SEC_PER_STOP;
    const ceiling = t + Math.max(2, t * 0.08);
    check(`v62.40: a ${t}s budget-sized script lands under the worker ceiling (${lands.toFixed(1)}s <= ${ceiling.toFixed(1)}s)`,
      lands <= ceiling, `${lands.toFixed(1)}`);
  }
}
{
  const real = [
    "Welcome to 4935 E Berneil Dr in Paradise Valley, a stunning 6-bedroom, 8-bath home with over 7,700 square feet of living space.",
    "Step inside to a bright kitchen featuring dual islands with dark stone countertops and natural wood cabinetry.",
    "The spacious living area offers a cozy fireplace and expansive windows overlooking the backyard.",
    "Just beyond, the primary bedroom boasts sweeping views and direct access to the pool area.",
    "The outdoor space is a true retreat with a dramatic rock waterfall pool and spa.",
    "Every detail, from the sleek black cabinetry in the butler's pantry to the elegant bathroom finishes, speaks to quality.",
    "Living here means enjoying luxury and comfort in one of Arizona's finest neighborhoods.",
    "Contact Vistalia AI at their brokerage to schedule your private tour today."
  ];
  const wc = (t) => String(t).split(/\s+/).filter(Boolean).length;
  const nar = { monologue: real.join(" "), direction: "warm", source: "director",
                sentences: real.map((t, i) => ({ text: t, photos: [`p${i + 1}`] })) };
  check("fixture is the real 127-word overrun", wc(nar.monologue) === 127);
  const out = globalThis.trimNar(nar, { targetDurationSec: 30 });
  check("over-band narration is trimmed", !!out);
  const after = out ? wc(out.monologue) : 0;
  // v62.40: bounds derive from the code's own budget (was hardcoded 70-85
  // when the budget was flat 77.5). Sentence-granular trimming can stop up
  // to one sentence (~22w) under the ceiling.
  const ceil30 = Math.round(narrationWordBudget(30) * 1.1);
  check(`trim lands inside the 30s ceiling (${after}w <= ${ceil30})`, after > 0 && after <= ceil30);
  check(`trim does not gut the script (${after}w >= ${ceil30 - 25})`, after >= ceil30 - 25);
  check("hook preserved", !!out && out.sentences[0].text === real[0]);
  check("CTA preserved", !!out && out.sentences[out.sentences.length - 1].text === real[real.length - 1]);
  const ph = out ? out.sentences.flatMap((s) => s.photos) : [];
  check("no photoId is covered twice", ph.length === new Set(ph).size);
  /* v62.31: the first version merged a dropped sentence's photos into its
     neighbour, so a line written about the pool played over the bathroom —
     Troy: "the voiceover does not match the scene structure". A sentence must
     keep EXACTLY the photos it was authored for; dropped scenes come back as
     __trim.orphaned and the caller removes them from the tour. */
  const authored = new Map(nar.sentences.map((s) => [s.text, s.photos.join(",")]));
  check("no manufactured multi-photo sentences",
    !!out && out.sentences.every((s) => authored.get(s.text) === s.photos.join(",")));
  check("dropped sentences return their photos as orphans",
    !!out && Array.isArray(out.__trim.orphaned) && out.__trim.orphaned.length === out.__trim.cuts);
  check("orphans + survivors account for every original photo",
    !!out && new Set([...ph, ...out.__trim.orphaned]).size === 8);
  check("monologue equals sentences joined", !!out && out.monologue === out.sentences.map((s) => s.text).join(" "));
  // v62.40: "in-band" moved. The old fixture blessed 78 words as in-band —
  // the exact count both calibrated renders measured at 37.5s on a 30s
  // order. A genuinely in-band script now is ~4 sentences under the
  // derived ceiling.
  const inBand = real.slice(0, 4);
  const inBandWords = wc(inBand.join(" "));
  check(`in-band narration is left alone (${inBandWords}w <= ${Math.round(narrationWordBudget(30) * 1.1)})`,
    inBandWords <= Math.round(narrationWordBudget(30) * 1.1) &&
    globalThis.trimNar(
      { sentences: inBand.map((t, i) => ({ text: t, photos: [`p${i}`] })), monologue: inBand.join(" ") },
      { targetDurationSec: 30 }) === null);
  check("127w against a 60s order is not over band", globalThis.trimNar(nar, { targetDurationSec: 60 }) === null);
}
check("ceiling is enforced in code, not only in the prompt", /trimNarrationToBudget\(/.test(planSrc) && /OVER BAND trimmed/.test(planSrc));

/* ── Amy-class lint: lead emails must never claim fake deadlines ── */
const tplSrc = fs.readFileSync(path.join(ROOT, "api/_lib/email-templates.js"), "utf8");
const freeVideoBlock = tplSrc.slice(tplSrc.indexOf("freeVideoWaiting"), tplSrc.indexOf("paymentFailed"));
check("ladder emails: no trial language", !/free trial|trial (ends|wraps|expired)/i.test(freeVideoBlock));
check("ladder emails: no fake lockout", !/stops responding|locked|expire/i.test(freeVideoBlock));
check("ladder emails: opt-out link present", freeVideoBlock.includes("optOutUrl"));

/* ══════════════════════════════════════════════════════════════════════
   v62.35 — "the voiceover is still off track"

   Smoke test project-1785041392707: 8 sentences over 7 scenes whose swept
   room types were kitchen, exterior, kitchen, bedroom, bedroom, living,
   bathroom. The mapping was complete and ascending, so every structural
   check we owned passed — and the video still said "the bathroom
   showcases elegant marble finishes" over a bedroom. The monologue is the
   v62 deliverable but the image-grounding rule only ever lived on the
   per-scene narrationLine guidance. These fixtures pin both halves: the
   prompt must carry the rule, and the deterministic check must catch it
   when the Director ignores it anyway.
   ══════════════════════════════════════════════════════════════════════ */
eval(`globalThis.ROOM_WORDS = ${planSrc.slice(planSrc.indexOf("const ROOM_WORDS = ["), planSrc.indexOf("];", planSrc.indexOf("const ROOM_WORDS = [")) + 2).replace(/^const ROOM_WORDS = /, "")}`);
eval(`globalThis.ROOM_EQUIV = ${planSrc.slice(planSrc.indexOf("const ROOM_EQUIV = ["), planSrc.indexOf("];", planSrc.indexOf("const ROOM_EQUIV = [")) + 2).replace(/^const ROOM_EQUIV = /, "")}`);
eval(`globalThis.roomTypesNamedIn = ${grab(planSrc, "roomTypesNamedIn").replace(/^function \w+/, "function")}`);
eval(`globalThis.sameRoomClass = ${grab(planSrc, "sameRoomClass").replace(/^function \w+/, "function")}`);
eval(`globalThis.roomMismatches = ${grab(planSrc, "narrationRoomMismatches").replace(/^function \w+/, "function")}`);

// The actual shipped scene order and sentences from that render.
const smokeRooms = { p1: "kitchen", p2: "exterior", p3: "kitchen", p4: "bedroom", p5: "bedroom", p6: "living", p7: "bathroom" };
const smokeSents = [
  { text: "Welcome to 4935 E Berneil Dr in Paradise Valley.", photos: ["p1"] },
  { text: "Step inside to the grand entryway illuminated warmly at dusk.", photos: ["p2"] },
  { text: "Clean lines and generous counters make it easy to cook here.", photos: ["p3"] },
  { text: "Upstairs, light spills across wide plank floors.", photos: ["p4"] },
  { text: "The bathroom showcases elegant marble finishes.", photos: ["p5"] },
  { text: "Relax in the inviting outdoor seating area.", photos: ["p6"] },
  { text: "Soaking tub, double vanity, and quiet at the end of the hall.", photos: ["p7"] }
];
const smokeHits = roomMismatches(smokeSents, smokeRooms);
check("v62.35: the shipped smoke test is caught", smokeHits.length >= 2, `got ${smokeHits.length}`);
check("v62.35: catches bathroom-over-bedroom", smokeHits.some((h) => h.index === 4 && h.claim === "bathroom" && h.actual[0] === "bedroom"));
check("v62.35: catches outdoor-over-living", smokeHits.some((h) => h.index === 5 && h.claim === "outdoor" && h.actual[0] === "living"));
check("v62.35: does NOT flag the correct bathroom sentence", !smokeHits.some((h) => h.index === 6), JSON.stringify(smokeHits.find((h) => h.index === 6) || null));
check("v62.35: does NOT flag the address hook (names no room)", !smokeHits.some((h) => h.index === 0));
check("v62.35: two mismatches is an error, not a warning", /contradictions\.length >= 2/.test(planSrc) && /errors\.push\(`\$\{contradictions\.length\}/.test(planSrc));

// False positives are the real risk: a check that rejects good narration
// ships stiff derived lines on every render. Each of these must pass clean.
const fpRooms = { k: "kitchen", l: "living", b: "bedroom", d: "detail", x: "bathroom", o: "outdoor", e: "exterior" };
const falsePositives = [
  ["transition naming two rooms", [{ text: "Just beyond the kitchen, the living room opens up.", photos: ["l"] }]],
  ["'bathed in light' is not a bathroom", [{ text: "The whole floor is bathed in afternoon light.", photos: ["l"] }]],
  ["'breakfast bar' is not a kitchen claim", [{ text: "A breakfast bar seats four in comfort.", photos: ["k"] }]],
  ["linger sentence (no photos) is skipped", [{ text: "The bathroom is a retreat.", photos: [] }]],
  ["detail scenes are too vague to contradict", [{ text: "Marble runs right up the kitchen wall.", photos: ["d"] }]],
  ["correct room passes", [{ text: "The kitchen opens straight onto the terrace.", photos: ["k"] }]],
  ["multi-photo sentence, one photo matches", [{ text: "The primary bedroom sits at the quiet end.", photos: ["b", "d"] }]],
  ["unknown photoId is skipped, not flagged", [{ text: "The bathroom is all marble.", photos: ["nope"] }]],
  ["'deck' outdoors over an outdoor scene", [{ text: "The deck wraps the whole rear elevation.", photos: ["o"] }]],
  // Traps found while writing this suite — each would have thrown away a
  // perfectly good monologue on a routine render.
  ["bed/bath STATS are not a room claim", [{ text: "Four bed, three bath, and a lot of light.", photos: ["l"] }]],
  ["'bath' in a stats opener over an exterior", [{ text: "Five bed, four bath, on half an acre.", photos: ["k"] }]],
  ["a vanity is not automatically a bathroom", [{ text: "A vanity tucks into the corner by the window.", photos: ["b"] }]],
  ["'pool table' is a game room, not a pool", [{ text: "A pool table anchors the far end.", photos: ["l"] }]],
  ["'den' is not a living-room claim", [{ text: "The den stays quiet all afternoon.", photos: ["k"] }]],
  // Label adjacency — the classifier cannot reliably split these, so a
  // sentence naming one over the other is not evidence of anything. Each
  // of these is correct copy that the first cut of this check rejected.
  ["a deck IS the exterior", [{ text: "The deck wraps the back of the house.", photos: ["e"] }]],
  ["a patio over an exterior photo", [{ text: "A wide patio catches the last of the sun.", photos: ["e"] }]],
  ["a driveway over an outdoor photo", [{ text: "The driveway sweeps up past mature oaks.", photos: ["o"] }]],
  ["a sitting room off the primary", [{ text: "A sitting room tucks off the primary.", photos: ["b"] }]],
  ["'poolside' still reads as outdoor", [{ text: "Poolside, the whole valley opens up.", photos: ["o"] }]],
  ["'pool-table' hyphenated is still not a pool", [{ text: "A pool-table anchors the far end.", photos: ["l"] }]],
  // v62.40 — the two phrase families the audit flagged as FPs, both of
  // which then appeared in production hooks two renders running:
  ["'6-bedroom, 8-bath' stats hook over an exterior", [{ text: "Welcome home — a stunning 6-bedroom, 8-bath estate with mountain views.", photos: ["e"] }]],
  ["'3 bedroom' unhyphenated stats", [{ text: "This 3 bedroom charmer sits on a corner lot.", photos: ["e"] }]],
  ["'overlooking the backyard' is a view, not a room", [{ text: "Expansive windows fill the wall, overlooking the backyard and pool beyond.", photos: ["l"] }]],
  ["'views of the pool beyond the fireplace'", [{ text: "The fireplace anchors the wall, with views of the pool beyond.", photos: ["l"] }]],
  ["'outdoor living area' is not a living-room claim", [{ text: "The outdoor living area wraps around the firepit.", photos: ["o"] }]]
];
for (const [name, sents] of falsePositives) {
  const hits = roomMismatches(sents, fpRooms);
  check(`v62.35 no false positive: ${name}`, hits.length === 0, JSON.stringify(hits));
}
// v62.40: "living area" is DETECTABLE now — the real mismatch it was
// missing, and the real match it must not flag.
{
  const hit = roomMismatches([{ text: "The spacious living area unfolds with high ceilings.", photos: ["b"] }],
    { ...fpRooms, b: "bathroom" });
  check("v62.40: 'living area' over a bathroom is now caught", hit.length === 1, JSON.stringify(hit));
  const okHit = roomMismatches([{ text: "The spacious living area unfolds with high ceilings.", photos: ["l"] }], fpRooms);
  check("v62.40: 'living area' over a living room passes", okHit.length === 0, JSON.stringify(okHit));
}

/* ── prompt lint: the monologue must carry the grounding rule ── */
const monoGuide = planSrc.slice(planSrc.indexOf("MOST IMPORTANT — THE SPOKEN TOUR"), planSrc.indexOf("narration.direction:"));
check("v62.35 prompt: monologue carries the grounding rule", /TRUST THE IMAGE/i.test(monoGuide));
check("v62.35 prompt: monologue forbids naming unseen rooms", /Never name a room/i.test(monoGuide));
check("v62.35 prompt: monologue forbids the generic-tour failure", /generic walkthrough from memory/i.test(monoGuide));
check("v62.35 prompt: opening sentence is written for scene 1", /opening sentence plays over scene 1/i.test(monoGuide));

/* ── v62.35 floor: motion must not thin out as scenes get longer ── */
const hgSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/homography-drift.mjs"), "utf8");
check("v62.35 floor: duration compensation exists", /REF_DURATION_SEC/.test(hgSrc) && /const gain = Math\.min\(/.test(hgSrc));
check("v62.35 floor: gain never scales DOWN (short clips unchanged)", /Math\.max\(1, \(Number\(durationSec\)/.test(hgSrc));
check("v62.35 floor: gain is capped", /Math\.min\(2\.8,/.test(hgSrc));
// The palette is a TOTAL displacement, so shipping velocity ∝ 1/duration.
// Reproduce the gain arithmetic and assert the fix flattens it.
const gainAt = (d) => Math.min(2.8, Math.max(1, d / 3.5));
check("v62.35 floor: 3.5s reference is untouched", gainAt(3.5) === 1);
check("v62.35 floor: 3.0s (and shorter) is untouched", gainAt(3.0) === 1 && gainAt(2.2) === 1);
check("v62.35 floor: 8.811s gets ~2.5x the move", Math.abs(gainAt(8.811) - 2.517) < 0.01, String(gainAt(8.811)));
// Velocity ∝ gain/duration. Post-fix it must be flat within 10% of the
// reference across the whole voice-first scene range (MIN_SCENE 1.8s →
// Kling visible ceiling 9.5s), where before it fell to 34%.
const vel = (d) => (gainAt(d) / d) * 3.5;
for (const d of [3.5, 5.0, 7.0, 8.811, 9.5]) {
  check(`v62.35 floor: velocity flat at ${d}s`, Math.abs(vel(d) - 1) < 0.1, `ratio ${vel(d).toFixed(3)}`);
}
check("v62.35 floor: shipping behaviour really was 34% at 8.811s", Math.abs((3.5 / 8.811) - 0.397) < 0.01);

/* ══════════════════════════════════════════════════════════════════════
   v62.36 — the duration contract, in seconds

   The customer orders 30 or 60s. Under voice-first the video's length IS
   the narration's length, but every gate on it was denominated in WORDS,
   and words do not convert to seconds at a fixed rate: the pauses a voice
   takes at a full stop scale with SENTENCE COUNT. An in-band 80-word
   script shipped a 37.6s video on a 30s order.

   These fixtures use a synthetic voice whose gap structure is real and
   whose pace is swept across the band this repo already claims to have
   measured (voice-first.mjs: "2.34-2.80 words/sec"). The point is not to
   reproduce one render's seconds — it is that the machinery does the
   right thing at every point in that band, and nothing at all outside it.
   ══════════════════════════════════════════════════════════════════════ */
{
  const vf = await import(path.join(ROOT, "render-worker/src/voice-first.mjs"));
  const INTRA = 0.07, INTER = 0.52;
  // Hold ARTICULATION fixed (what a voice actually does) and let the
  // sentence count move the total — the premise, stated as a test.
  const synth = (wordsPerSentence, artic) => {
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
  };
  // Solve articulation so the OVERALL pace is exactly `wps`.
  const atPace = (wps, shape) => {
    const W = shape.reduce((a, b) => a + b, 0), S = shape.length;
    return synth(shape, (W / wps - (W - S) * INTRA - (S - 1) * INTER) / W);
  };
  const gridOf = (s) => vf.buildVoiceGrid({ sentences: s.sentences }, s.words);
  const ceilingFor = (t) => t + Math.max(2, t * 0.08);
  const SHAPE = [16, 11, 10, 10, 9, 9, 8, 7]; // 80 words / 8 sentences

  /* the premise: at one articulation rate, sentence count alone moves both
     the duration and the apparent w/s — so no single divisor can be right */
  const rows = [[80], [40, 40], SHAPE, Array(12).fill(0).map((_, i) => (i < 8 ? 7 : 6))]
    .map((sh) => gridOf(synth(sh, 0.33)))
    .map((g) => ({ end: g.videoEndSec, wps: g.stats.wps }));
  check("v62.36: more sentences = longer video at identical word count",
    rows.every((r, i) => i === 0 || r.end > rows[i - 1].end), JSON.stringify(rows.map((r) => r.end)));
  check("v62.36: apparent w/s falls as sentence count rises",
    rows.every((r, i) => i === 0 || r.wps < rows[i - 1].wps), JSON.stringify(rows.map((r) => r.wps)));
  check("v62.36: the spread is material on a 30s order (>3s)",
    rows[rows.length - 1].end - rows[0].end > 3, `${(rows[rows.length - 1].end - rows[0].end).toFixed(2)}s`);

  /* the gate: fires iff over the ceiling, across the measured pace band */
  let fired = 0, held = 0;
  for (const wps of [2.20, 2.34, 2.50, 2.68, 2.80]) {
    const s = atPace(wps, SHAPE);
    const g = gridOf(s);
    const p = vf.planDurationTrim(vf.wordsToSentences(s.sentences, s.words), g.videoEndSec, 30,
      { photosPerSentence: s.sentences.map((x) => x.photos.length) });
    const over = g.videoEndSec > ceilingFor(30);
    check(`v62.36: trim fires iff over ceiling @ ${wps} w/s`, over === !!p, `${g.videoEndSec.toFixed(1)}s, plan=${!!p}`);
    if (p) {
      fired++;
      check(`v62.36: @${wps} w/s lands inside the order`, p.projectedSec <= ceilingFor(30), `${p.projectedSec}`);
      check(`v62.36: @${wps} w/s does not undershoot`, p.projectedSec >= 30 * 0.75, `${p.projectedSec}`);
      check(`v62.36: @${wps} w/s keeps hook and CTA`, !p.drop.includes(0) && !p.drop.includes(SHAPE.length - 1));
    } else held++;
  }
  check("v62.36: the band straddles the ceiling", fired > 0 && held > 0, `${fired} fired / ${held} held`);

  /* the apply: picture and voice must come out of the same arithmetic */
  const S3 = atPace(2.20, SHAPE);
  const g0 = gridOf(S3);
  const per = vf.wordsToSentences(S3.sentences, S3.words);
  const plan = vf.planDurationTrim(per, g0.videoEndSec, 30, { photosPerSentence: S3.sentences.map((s) => s.photos.length) });
  check("v62.36: a trim is planned at the slow end of the band", !!plan);
  if (plan) {
    const dropSet = new Set(plan.drop);
    const survivors = S3.sentences.filter((_, i) => !dropSet.has(i));
    const keepOrd = survivors.flatMap((s) => s.photos).sort((a, b) => a - b);
    const renum = new Map(keepOrd.map((o, i) => [o, i]));
    const newSents = survivors.map((s) => ({ text: s.text, photos: s.photos.map((o) => renum.get(o)) }));
    const newWords = vf.shiftWordsAfterCuts(S3.words, plan.spans);
    const g1 = vf.buildVoiceGrid({ sentences: newSents }, newWords);
    check("v62.36: rebuilt grid matches the prediction within 50ms",
      Math.abs(g1.videoEndSec - plan.projectedSec) < 0.05, `predicted ${plan.projectedSec}, actual ${g1.videoEndSec}`);
    check("v62.36: one scene per surviving photo", g1.scenes.length === keepOrd.length);
    check("v62.36: rebuild drops no photos", g1.stats.droppedPhotos.length === 0);
    check("v62.36: ordinals stay dense and ascending", g1.scenes.every((s, i) => s.photoOrdinal === i));
    check("v62.36: first word untouched, so the audio offset holds", newWords[0].start === S3.words[0].start);
    check("v62.36: timestamps stay ordered and non-negative",
      newWords.every((w, i) => w.start >= 0 && w.end > w.start && (i === 0 || w.start >= newWords[i - 1].end - 1e-6)));
    // Exactly the dropped sentences' words go — eating a neighbour's opening
    // word, or leaving one behind, is the desync this whole file guards.
    const expect = S3.words.filter((w) => !dropSet.has(Number(w.word.split("_")[0].slice(1))));
    check("v62.36: cut removes exactly the dropped sentences' words",
      newWords.length === expect.length && newWords.every((w, i) => w.word === expect[i].word),
      `${newWords.length} vs ${expect.length}`);
    check("v62.36: each survivor shifted by exactly the span time before it",
      newWords.every((n) => {
        const o = S3.words.find((w) => w.word === n.word);
        const sh = plan.spans.filter((s) => o.start >= s.end).reduce((a, s) => a + (s.end - s.start), 0);
        return Math.abs((o.start - sh) - n.start) < 1e-3;
      }));
  }

  /* refusals — a gate that fires when it shouldn't is worse than none */
  const okS = atPace(2.5, [10, 9, 9, 8, 8, 7]);
  check("v62.36: in-band narration is left completely alone",
    vf.planDurationTrim(vf.wordsToSentences(okS.sentences, okS.words), gridOf(okS).videoEndSec, 30) === null);
  check("v62.36: a 60s order does not trim a 38s script",
    vf.planDurationTrim(per, g0.videoEndSec, 60) === null);
  check("v62.36: no target = no action", vf.planDurationTrim(per, g0.videoEndSec, 0) === null);
  const tiny = atPace(2.2, [40, 40, 40]);
  check("v62.36: a 3-sentence script is never cut (hook and CTA only)",
    vf.planDurationTrim(vf.wordsToSentences(tiny.sentences, tiny.words), gridOf(tiny).videoEndSec, 30) === null);
  const big = atPace(2.2, Array(14).fill(9));
  const bigPlan = vf.planDurationTrim(vf.wordsToSentences(big.sentences, big.words), gridOf(big).videoEndSec, 30,
    { photosPerSentence: big.sentences.map((s) => s.photos.length) });
  check("v62.36: never cuts below the 5-scene floor",
    !bigPlan || 14 - bigPlan.drop.length >= 5, `${bigPlan ? 14 - bigPlan.drop.length : "n/a"} left`);

  /* ── v62.36a: a cut must EARN its place ──
     The first cut of this greedy took any drop that cleared the floor, so a
     33.0s video 0.6s over the ceiling could lose its only droppable sentence
     and land at 22.8s — a third of the script deleted to end up FARTHER from
     the 30s the customer bought than doing nothing. Found by adversarial
     sweep, 3.7% of near-ceiling shapes. The fixture is the exact input; the
     property sweep below is what stops the whole class. */
  {
    const gapSynth = (counts, artic, intra, stop, photosPer) => {
      const words = [], sentences = [];
      let t = 0.9;
      counts.forEach((n, si) => {
        const toks = [];
        for (let i = 0; i < n; i++) {
          words.push({ word: `w${si}_${i}`, start: +t.toFixed(4), end: +(t + artic).toFixed(4) });
          toks.push(`w${si}_${i}`);
          t += artic + (i === n - 1 ? stop : intra);
        }
        sentences.push({ text: toks.join(" "), photos: photosPer[si] });
      });
      return { words, sentences };
    };
    const s = gapSynth([9, 15, 25, 21, 6], 0.347, 0.048, 0.357, [[0], [1], [], [2, 3], [4]]);
    const g = vf.buildVoiceGrid({ sentences: s.sentences }, s.words);
    const p = vf.planDurationTrim(vf.wordsToSentences(s.sentences, s.words), g.videoEndSec, 30,
      { photosPerSentence: s.sentences.map((x) => x.photos.length) });
    check("v62.36a: the 33.0s->22.8s over-cut is over the ceiling to begin with",
      g.videoEndSec > 30 + Math.max(2, 30 * 0.08), `${g.videoEndSec}`);
    check("v62.36a: it is NOT cut to 22.8s — no cut beats a bad cut",
      !p || Math.abs(p.projectedSec - 30) < Math.abs(g.videoEndSec - 30),
      `${g.videoEndSec.toFixed(1)}s -> ${p ? p.projectedSec.toFixed(1) : "null"}s`);
  }
  // The property, swept: a returned trim ALWAYS lands closer to the order
  // than leaving it alone. Deterministic shapes, no RNG.
  {
    let checked = 0, worse = 0, undershot = 0;
    for (let nS = 4; nS <= 12; nS++) {
      for (let base = 5; base <= 17; base += 3) {
        for (const wps of [2.1, 2.3, 2.5, 2.7]) {
          for (const tgt of [30, 60]) {
            const shape = Array.from({ length: nS }, (_, i) => base + ((i * 7) % 11));
            const s = atPace(wps, shape);
            const g = gridOf(s);
            const p = vf.planDurationTrim(vf.wordsToSentences(s.sentences, s.words), g.videoEndSec, tgt,
              { photosPerSentence: s.sentences.map((x) => x.photos.length) });
            if (!p) continue;
            checked++;
            if (Math.abs(p.projectedSec - tgt) > Math.abs(g.videoEndSec - tgt) + 1e-9) worse++;
            if (p.projectedSec < tgt * 0.75) undershot++;
          }
        }
      }
    }
    check(`v62.36a: no trim lands farther from the order (${checked} trims swept)`, worse === 0, `${worse} worse`);
    check("v62.36a: no trim falls through the 75% floor", undershot === 0, `${undershot} under`);
    check("v62.36a: the sweep actually exercised the trim", checked > 100, `${checked}`);
  }

  /* the worker must actually consult the order it was given */
  const wjSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/runway-job.mjs"), "utf8");
  const vfSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/voice-first.mjs"), "utf8");
  check("v62.36: the worker reads manifest.targetDurationSec", /manifest\?\.targetDurationSec/.test(vfSrc));
  check("v62.36: the trim runs before clip submission",
    vfSrc.indexOf("DURATION CONTRACT") < vfSrc.indexOf("return { grid, audioPath"));
  check("v62.36: the caller reduces photoScenes on a trim", /voiceFirst\?\.keepOrdinals/.test(wjSrc));
  check("v62.36: the trim fails open", /duration trim failed[\s\S]{0,120}shipping the full-length voice/.test(vfSrc));
  check("v62.36: calibration is logged for the plan-side divisor", /CALIBRATION/.test(vfSrc));
  // v62.36a, all three found by adversarial review — each is a silent
  // failure mode, so each gets a lint that will fail loudly if removed.
  check("v62.36a: the cut audio is measured, not assumed",
    /refusing to desync the stem/.test(vfSrc) && /probeDurationSec\(outPath\)/.test(vfSrc));
  check("v62.36a: a rejected trim takes its orphan mp3 with it",
    /fs\.unlink\(newAudio\)/.test(vfSrc));
  check("v62.36a: 'change nothing' is a scored candidate",
    /let best = \{ k: null/.test(vfSrc) && /if \(best\.k === null\) break/.test(vfSrc));
  check("v62.36a: the UNDER warning is emitted after any trim",
    vfSrc.indexOf("DURATION UNDER") > vfSrc.indexOf("DURATION TRIM:"));
  check("v62.36a: the caller validates before deleting scenes",
    /does not reconcile[\s\S]{0,200}reverting to legacy/.test(wjSrc) &&
    wjSrc.indexOf("does not reconcile") < wjSrc.indexOf("photoScenes.length = 0"));
}

/* ══════════════════════════════════════════════════════════════════════
   v62.38 — steady-shot regen: every adversarially-proven defect, pinned.
   The e2e harness (render-worker/tests/regen-splice.e2e.test.mjs) proves
   the behaviours; these source lints make the specific regressions loud.
   ══════════════════════════════════════════════════════════════════════ */
{
  const vmSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/voice-mixer.mjs"), "utf8");
  const rjSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/runway-job.mjs"), "utf8");
  const rgSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/regenerate-job.mjs"), "utf8");
  const apiSrc = fs.readFileSync(path.join(ROOT, "api/regenerate-scene.js"), "utf8");

  // B0: the upload gate reads narration.captionsAssPath — BOTH mixer paths
  // must return it, or the entire regen feature is unreachable dead code
  // that fails every captioned render with advice that reproduces itself.
  const returnsWithSquare = vmSrc.match(/captionsSquareAssPath\s*[,}]/g) || [];
  const returnsWithMaster = vmSrc.match(/^\s*captionsAssPath,\s*$/gm) || [];
  check("v62.38: both mixer returns carry captionsAssPath (the upload gate's field)",
    returnsWithMaster.length >= 2, `${returnsWithMaster.length} of ${returnsWithSquare.length}`);
  check("v62.38: the render actually persists captions.ass",
    /uploadCaptionsArtifact\(\{/.test(rjSrc) && /narration\?\.captionsAssPath/.test(rjSrc));

  // A4/A5: -shortest inside the ±tolerance deleted the voiceover's final
  // word. The mux must pad, never truncate, and prove the audio after.
  check("v62.38: regen mux has NO -shortest argument",
    !/"-shortest"/.test(rgSrc)); // quoted = an actual ffmpeg arg; comments explain its absence
  check("v62.38: length tolerance is sub-frame-ish (≤0.06s)",
    /LENGTH_TOLERANCE_SEC = 0\.0[0-6]/.test(rgSrc));
  check("v62.38: post-mux audio duration is asserted",
    /probeAudioDurationSec\(cleanMaster\)/.test(rgSrc) && /voiceover was not preserved intact/.test(rgSrc));

  // C: the replacement speaks METADATA (the timeline's author), never the
  // measurement — measurement is a cross-check log only.
  check("v62.38: floor renders at the audit duration",
    /durationSec: auditDuration/.test(rgSrc) && /rebuilding at the audit value/.test(rgSrc));

  // E: the watermark-laundering door — the tier guard must fail CLOSED on
  // missing auth (the old open branch let an unauthenticated request carry
  // a client-posted freeRenderWatermark straight to the worker).
  const nonBearerBranch = apiSrc.slice(apiSrc.indexOf('auth.startsWith("Bearer ")'), apiSrc.indexOf('auth.slice(7)'));
  check("v62.38: regen auth fails closed (no ok:true in the non-Bearer branch)",
    !/ok:\s*true/.test(nonBearerBranch), nonBearerBranch.slice(0, 120));

  // F: an upload failure must never patch the audit row — an empty URL in
  // a PATCH is a delete of the customer's finished video.
  check("v62.38: upload failure throws before any audit patch",
    /if \(!newMasterUrl && !upload\?\.storageSkipped\)/.test(rgSrc) &&
    rgSrc.indexOf("the original render is untouched") < rgSrc.indexOf("updateRenderAudit({"));
  check("v62.38: audit patch only writes truthy URLs",
    /if \(newMasterUrl\) \{[\s\S]{0,200}updateRenderAudit/.test(rgSrc));

  // D residue: headshot compositing gates on !isPre like card/watermark.
  check("v62.38: preNormalized clips skip the headshot re-composite",
    /const clipHeadshot = isPre \? null : cornerHeadshotPath/.test(rjSrc));

  // G: QC provenance survives the regen round-trip.
  check("v62.38: regen carries sweepReplaced/floorReason/attempts through",
    /usedPhotoMotionFloor: d\.scene\.engineUsed === "photo_motion"/.test(rgSrc) &&
    /sweepReplaced: Boolean\(d\.scene\.sweepReplaced\)/.test(rgSrc));

  /* ── v62.39 — what the Jul 27 smoke test surfaced ── */
  // The target's own clip is a cross-check, not a dependency: the scene
  // whose upload failed is the scene most likely to need replacing.
  check("v62.39: regen requires only the N−1 OTHER clips",
    /Number\(s\.sceneIndex\) !== Number\(sceneIndex\) && !s\.clipUrl/.test(rgSrc));
  check("v62.39: missing target clip skips the cross-check, not the rebuild",
    /skipping the duration cross-check/.test(rgSrc));
  // Per-scene clip uploads retry once and log a diagnosable failure.
  check("v62.39: scene clip upload retries once",
    /clip upload failed twice/.test(rjSrc) && /setTimeout\(r, 1500\)/.test(rjSrc));
  // The plan's rejection reason rides the manifest to the worker log.
  check("v62.39: derived narration carries sourceReason",
    /sourceReason: String\(reason \|\| ""\)\.slice\(0, 300\)/.test(planSrc));
  const vfSrc2 = fs.readFileSync(path.join(ROOT, "render-worker/src/voice-first.mjs"), "utf8");
  check("v62.39: worker NOTE line prints the plan-side reason",
    /Plan-side reason: \$\{narration\.sourceReason\}/.test(vfSrc2));

  /* ── v62.41: the QC ladder is three DIFFERENT hypotheses, not a reseed.
     Troy: "tone back the 3rd Kling prompt attempt — the goal is to avoid
     the KB fallback all together." Near-static asks are Kling's own boil
     trigger, so the old strict-static reseed mostly re-rolled attempt 2's
     defect into the floor. */
  check("v62.41: third attempt is the gentle re-roll, not a strict reseed",
    /gentleReroll: true/.test(rjSrc) &&
    !/third = await generateVeoSceneClip\(scene, manifest, tempDir, index, \{ constrained: true, strictConstrained: true \}\)/.test(rjSrc));
  check("v62.41: exteriors get a third attempt again (no straight-to-floor skip)",
    !/exterior: no reveal roll, PREMIUM PHOTO MOTION floor/.test(rjSrc));
  check("v62.41: gentle prose exists for generic, pool, and exterior",
    /gentleGeneric:/.test(rjSrc) && /gentlePool:/.test(rjSrc) && /gentleExterior:/.test(rjSrc));
  check("v62.41: gentle prose is strictly forward — the v46 invariant survives",
    /never backward/.test(rjSrc) && /no reveal of new area at the frame edges/.test(rjSrc));
  // v62.90 superseded the v62.41 mapping: rung 2 (QC regen) now rides
  // steady and rung 3 (gentle re-roll) rides the rewritten strict, so the
  // Kling ladder de-escalates monotonically instead of putting the most
  // static ask at rung 2 (the Eddie Robinson scene-1 "KB style" clip).
  check("v62.41/v62.90: Kling motion mapping is the monotonic ladder",
    /gentleReroll \? "strict" : constrained \? "steady" : "bold"/.test(rjSrc));

  /* ── v62.42: narration provenance is logged at prepareVoiceFirst ENTRY,
     before any bail can swallow it — the Jul 27 square render's preflight
     bail was the third consecutive escape of the "why not the Director's
     monologue" reason. */
  const vfSrc3 = fs.readFileSync(path.join(ROOT, "render-worker/src/voice-first.mjs"), "utf8");
  const entryIdx = vfSrc3.indexOf('narration source is "');
  const preflightIdx = vfSrc3.indexOf("narration too thin to carry");
  check("v62.42: source+reason logs BEFORE the preflight bail",
    entryIdx > -1 && preflightIdx > -1 && entryIdx < preflightIdx);
  check("v62.42: the preflight bail names the source itself",
    /source=\$\{narration\.source \|\| "director"\}/.test(vfSrc3));

  /* ── v62.43: room mismatches REPAIR the monologue, never discard it.
     The Jul 27 render proved the demotion's cost: no address, clamped
     fragments, a third fewer words, 21.8s on a 30s order. */
  check("v62.43: repairNarrationRooms exists and is called on room demotions",
    /async function repairNarrationRooms\(/.test(planSrc) &&
    // v62.106 widened the lane: repairSource is parsed.narration on the
    // demoted path and the adopted narration on the single-mismatch path.
    /await repairNarrationRooms\(repairSource, offenders/.test(planSrc) &&
    /repairSource = roomDemoted && parsed\?\.narration\?\.monologue/.test(planSrc));
  check("v62.43: repair failure ships the Director's ORIGINAL (warn policy), not derived",
    /roomMismatchPolicy: "warn"/.test(planSrc) &&
    /roomMismatchPolicy !== "warn"/.test(planSrc));
  check("v62.43: non-offender sentences are equality-enforced in code",
    /changed without permission/.test(planSrc));
  check("v62.43: repair source label is director+room-repaired",
    /"director\+room-repaired"/.test(planSrc));
  check("v62.43: the derived path speaks the address (Welcome-hook from the intro card)",
    /Welcome to \$\{addrLine\}/.test(planSrc) && /introCard\?\.headline/.test(planSrc));
  check("v62.43: the Director's hook must carry the street address",
    /open by naming the street address naturally/.test(planSrc));

  /* ── v62.44: the plan can never again die of its own polish. The Jul 27
     Quartz Mountain plan was killed at Vercel's 90s ceiling because
     v62.17's expansion and v62.43's repair stacked serial 30s calls onto
     a budget that v35.2's own comment had already declared full. */
  check("v62.44: maxDuration raised and mirrored in a runtime constant",
    /maxDuration: 120/.test(planSrc) && /const PLAN_WALL_SEC = 120/.test(planSrc));
  check("v62.44: optional calls are wall-clock gated",
    /planOptionalBudgetMs/.test(planSrc) &&
    /repairBudget >= 12000/.test(planSrc) && /expandBudget >= 12000/.test(planSrc));
  check("v62.44: skipping a rewrite is loud, with elapsed time",
    /room-repair SKIPPED \(only/.test(planSrc) && /expansion SKIPPED \(only/.test(planSrc));
  check("v62.44: both rewrite calls accept a shrinking timeout",
    /timeoutMs = 30000/.test(planSrc.slice(planSrc.indexOf("async function expandNarrationToBudget"))) &&
    (planSrc.match(/\}, timeoutMs\);/g) || []).length >= 2);

  /* ── v62.45: rails, not drones — with the Spanish string one env flip away. */
  const vjSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/veo-job.mjs"), "utf8");
  check("v62.45: gimbal suffix is the default bold rung",
    /KLING_MOTION_GIMBAL/.test(vjSrc) && /invisible rails/.test(vjSrc) &&
    /no arcs, no banking, no speed changes/.test(vjSrc));
  check("v62.45: the v62.11 Spanish string survives byte-exact behind KLING_BOLD_LEGACY",
    /KLING_BOLD_LEGACY/.test(vjSrc) &&
    /gently arcing to reveal depth toward the scene's focal point/.test(vjSrc));
  check("v62.45: acceleration bans joined the negative prompt",
    /abrupt speed changes, jerky camera acceleration/.test(vjSrc));
  check("v62.45: steady and strict rungs untouched",
    /Controlled cinematic camera: one slow, smooth, perfectly stabilized/.test(vjSrc) &&
    /Minimal cinematic camera: a single very slow, short/.test(vjSrc));

  /* ── v62.48: the log must not lie about a suffixed director source. The
     Jul 27 render shipped "director+room-repaired+trimmed" — the Director's
     own monologue, address hook intact — and the worker WARNED "the per-scene
     lines were joined instead. Expect a stiffer read. (pre-v62.39 plan)".
     Wrong on every clause. Suffixed director sources are INFO truth lines;
     only genuinely non-director sources warn. */
  check("v62.48: both worker log gates understand director suffixes",
    (vfSrc3.match(/narration\.source\.startsWith\("director"\)/g) || []).length >= 2);
  check("v62.48: suffixed director sources log as the Director's monologue, not a demotion",
    /Director's monologue, shipped after plan-side/.test(vfSrc3) &&
    /Director's monologue, adjusted plan-side/.test(vfSrc3));
  check("v62.48: suffix describer translates the pass names",
    /function describeDirectorPasses\(/.test(vfSrc3) &&
    /"room-repaired": "room-repair"/.test(vfSrc3) &&
    /trimmed: "duration-trim"/.test(vfSrc3));
  check("v62.48: the stiffer-read warning still exists for non-director sources",
    /the per-scene lines were joined instead\. Expect a stiffer read\./.test(vfSrc3));
  check("v62.48: room-repair adoption stamps a sourceReason",
    /rewritten plan-side to their actual rooms/.test(planSrc));
  check("v62.48: expansion and trim adoptions carry the earlier pass's reason",
    /nar\.sourceReason && !probe\.narration\.sourceReason/.test(planSrc) &&
    /overNar\.sourceReason && !probe\.narration\.sourceReason/.test(planSrc));

  /* ── v62.49: the motion probe grew a smoothness read. Mean YDIF is a
     quantity meter (slideshow guard); jitter (stddev/mean of the per-frame
     series, frame 0 dropped) is the smoothness meter the gimbal verdict
     needs. Telemetry only — no gate may ever hang off it. */
  const rjSrc2 = fs.readFileSync(path.join(ROOT, "render-worker/src/runway-job.mjs"), "utf8");
  const leadSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/lead-auto-render.mjs"), "utf8");
  check("v62.49/51: motion probe computes smoothness on the series minus frame 0",
    /const run = xs\.slice\(1\);/.test(rjSrc2) && /jitter = sdOf\(env, m\) \/ m;/.test(rjSrc2));
  check("v62.49: the v60.5 mean is untouched (all frames, same formula)",
    /const mean = xs\.reduce\(\(a, b\) => a \+ b, 0\) \/ xs\.length;/.test(rjSrc2));
  check("v62.49: smoothness is logged per scene and as a median summary",
    /jitter=\$\{m\.jitter\.toFixed\(2\)\}/.test(rjSrc2) &&
    /median jitter/.test(rjSrc2));
  check("v62.49: smoothness is telemetry only — no jitter threshold gates anything",
    !/jitter [<>]=? ?[\d.]/.test(rjSrc2) && /telemetry only/.test(rjSrc2));

  /* ── v62.51: the 9-scene Jul 27 render showed v62.49's jitter correlating
     −0.84 with motion level — it was tasting foliage redraw noise on slow
     clips, not the camera. Decompose: envelope (9-frame moving average) →
     jitter = camera speed changes; residual → shimmer = frame-to-frame
     redraw (the same physics QC calls temporal instability). Verified on
     synthetics: boiling slow pan → jitter 0.04 / shimmer 0.52; speed ramp
     → jitter 0.45 / shimmer 0.01; rails → 0 / 0 at any speed. */
  check("v62.51: envelope/residual decomposition present",
    /9-frame window/.test(rjSrc2) &&
    /shimmer = sdOf\(resid, 0\) \/ m;/.test(rjSrc2));
  check("v62.51: shimmer is logged per scene and in the summary",
    /shimmer=\$\{m\.shimmer\.toFixed\(2\)\}/.test(rjSrc2) && /median shimmer/.test(rjSrc2));
  check("v62.51: shimmer is telemetry only too — no threshold gates anything",
    !/shimmer [<>]=? ?[\d.]/.test(rjSrc2));

  /* ── v62.50: the Cheney Dr blind spots. "A bathroom showcases tile
     counters and a tub" played over the home gym (amenity photos were
     NEVER judged), and "The home gym offers natural light and equipment"
     played over the breakfast nook ("gym" named zero known room types).
     These tests run the REAL extracted machinery against the exact
     production sentences, not regexes about the code. */
  {
    const start = planSrc.indexOf("const ROOM_WORDS");
    const end = planSrc.indexOf("function attachNarration");
    check("v62.50: room machinery is extractable for functional testing", start > 0 && end > start);
    const m = new Function(
      planSrc.slice(start, end) +
      "; return { narrationRoomMismatches, roomTypesNamedIn, sameRoomClass, narrationWordBudget };"
    )();
    const rooms = new Map([["p1", "exterior"], ["p4", "amenity"], ["p5", "living"], ["p6", "bathroom"], ["pd", "detail"]]);
    const flag = (text, photos) => m.narrationRoomMismatches([{ text, photos }], rooms).length === 1;
    check("v62.50: bathroom claim over an amenity photo is now flagged (Cheney s4)",
      flag("A bathroom showcases tile counters and a tub.", ["p4"]));
    check("v62.50: 'home gym' now counts as an amenity claim and flags over living (Cheney s5)",
      flag("The home gym offers natural light and equipment.", ["p5"]));
    check("v62.50: gym over an actual amenity photo stays clean",
      !flag("The home gym offers natural light and equipment.", ["p4"]));
    check("v62.50: kitchen claim over a detail closeup stays exempt (faucet-closeup rule)",
      !flag("The kitchen shines with granite counters.", ["pd"]));
    check("v62.50: soft claims (bedroom) over amenity stay unjudged",
      !flag("The bedroom is a quiet retreat.", ["p4"]));
    check("v62.50: view clauses still don't count as claims",
      !flag("A bright corner overlooking the home gym below.", ["p5"]));
    check("v62.50: bathroom over bathroom is still clean (no over-trigger)",
      !flag("A bathroom showcases tile counters and a tub.", ["p6"]));
    check("v62.50: repair prompt translates the amenity bucket into usable guidance",
      /a flexible amenity space \(gym, home office, media room/.test(planSrc));

    /* ── v62.69: the Invergordon linger blind spot. "Outside, enjoy the
       inviting pool and covered patio…" shipped as a linger ([]) riding
       the kitchen run — and lingers were SKIPPED by the room check, so
       the one sentence class that plays over another sentence's photos
       was the one class never judged. 9.5s of pool narration over the
       kitchen, at 23 seconds, caught by ear. Lingers are judged against
       the photos they ride now. */
    {
      const rooms69 = new Map([["pk", "kitchen"], ["po", "outdoor"], ["pd", "detail"]]);
      const mm = (sents) => m.narrationRoomMismatches(sents, rooms69);
      check("v62.69: pool/patio linger over a kitchen run is flagged (Invergordon s4)",
        (() => {
          const r = mm([
            { text: "The kitchen features warm wood cabinetry and gleaming marble countertops.", photos: ["pk"] },
            { text: "Outside, enjoy the inviting pool and covered patio, ideal for entertaining.", photos: [] }
          ]);
          return r.length === 1 && r[0].index === 1 && r[0].claim === "outdoor" && r[0].linger === true;
        })());
      check("v62.69: linger that stays in its own room is clean",
        mm([
          { text: "The kitchen features warm wood cabinetry.", photos: ["pk"] },
          { text: "This kitchen was made for slow mornings.", photos: [] }
        ]).length === 0);
      check("v62.69: linger naming no room (lifestyle close / CTA) is clean",
        mm([
          { text: "The kitchen features warm wood cabinetry.", photos: ["pk"] },
          { text: "Schedule your private tour today.", photos: [] }
        ]).length === 0);
      check("v62.69: a leading linger with nothing on screen stays skipped; a later owned mismatch is still caught",
        (() => {
          const r = mm([
            { text: "A warm welcome awaits.", photos: [] },
            { text: "The kitchen features warm wood cabinetry.", photos: ["po"] }
          ]);
          return r.length === 1 && r[0].index === 1 && r[0].claim === "kitchen" && r[0].linger === false;
        })());
      check("v62.69: a linger rides the NEAREST owner, not the first (patio linger after outdoor owner is clean)",
        mm([
          { text: "The kitchen features warm wood cabinetry.", photos: ["pk"] },
          { text: "Out back, a covered patio waits.", photos: ["po"] },
          { text: "The patio is made for quiet evenings.", photos: [] }
        ]).length === 0);
      check("v62.69: linger over a detail closeup stays exempt (faucet rule extends to lingers)",
        mm([
          { text: "Every finish is considered.", photos: ["pd"] },
          { text: "The kitchen shines with granite counters.", photos: [] }
        ]).length === 0);
      check("v62.69: repair prompt tells a linger offender the photo is the one ON SCREEN",
        /the photo\$\{o\.linger \? " on screen while it plays" : ""\} shows/.test(planSrc));

      /* ── v62.76: the Indian Bend entryway. "Step through the elegant
         entryway framed by lush landscaping and a tranquil fountain"
         shipped over a BATHROOM — "entryway" named zero known room
         types, the Cheney "home gym" class all over again. "entry" is a
         claim-only type: honest over exterior/outdoor/living, flagged
         over wet rooms and bedrooms. */
      {
        const rooms76 = new Map([["pb", "bathroom"], ["px", "exterior"], ["pl", "living"], ["po2", "outdoor"], ["pbed", "bedroom"]]);
        const mm76 = (sents) => m.narrationRoomMismatches(sents, rooms76);
        check("v62.76: the exact Indian Bend sentence now flags over a bathroom",
          (() => {
            const r = mm76([{ text: "Step through the elegant entryway framed by lush landscaping and a tranquil fountain.", photos: ["pb"] }]);
            return r.length === 1 && r[0].claim === "entry";
          })());
        check("v62.76: entryway over a front-entry exterior is clean",
          mm76([{ text: "The entryway welcomes you with a custom iron door.", photos: ["px"] }]).length === 0);
        check("v62.76: foyer over a living-classified interior is clean",
          mm76([{ text: "The foyer opens to soaring ceilings.", photos: ["pl"] }]).length === 0);
        check("v62.76: entry courtyard over an outdoor photo is clean",
          mm76([{ text: "A gated entryway with a stone path.", photos: ["po2"] }]).length === 0);
        check("v62.76: entryway over a bedroom flags (no entry-bedroom equivalence)",
          mm76([{ text: "The entryway sets the tone for the home.", photos: ["pbed"] }]).length === 1);
        check("v62.76: entry + living in one sentence stays a two-room transition (skipped)",
          mm76([{ text: "Just past the entryway, the living room opens up.", photos: ["pb"] }]).length === 0);
      }
    }

    /* ── v62.65: per-voice speech models, run FUNCTIONALLY. Troy's cloned
       voice measured 0.346s/word + 0.595s/stop (Jul 28 CALIBRATION) vs
       the flat 0.395/1.185 — four renders landed 80-93% of their order
       because the budget modeled a slower voice than the one reading. */
    check("v62.65: the measured voice gets a bigger word budget than the flat model",
      m.narrationWordBudget(30, "otrs2Z7sCUTBvhUvjLsP") > m.narrationWordBudget(30));
    check("v62.71: the cloned-voice 30s budget lands at 74 words (0.367/0.604, Jul 29 CALIBRATION)",
      m.narrationWordBudget(30, "otrs2Z7sCUTBvhUvjLsP") === 74,
      String(m.narrationWordBudget(30, "otrs2Z7sCUTBvhUvjLsP")));
    check("v62.65: unknown voices keep the conservative flat constants",
      m.narrationWordBudget(30, "someUnknownVoiceId") === m.narrationWordBudget(30));
    check("v62.65: every live budget call site carries the resolved voice",
      (planSrc.match(/narrationWordBudget\(targetDurationSec, planVoiceId\)/g) || []).length >= 2 &&
      (planSrc.match(/voiceId: planVoiceId/g) || []).length >= 7 &&
      /const planVoiceId = resolveVoiceId\(brandKit\?\.voiceId\);/.test(planSrc) &&
      /narrationWordBudget\(clampedDuration, resolveVoiceId\(brandKit\?\.voiceId\)\)/.test(planSrc));
    check("v62.65: constants updated only from CALIBRATION lines, per the rule",
      /Update entries ONLY from worker CALIBRATION lines, never by feel\./.test(planSrc));
  }

  /* v62.50 worker belt: the grid duration assignment is positional — assert
     photoOrdinal === i instead of assuming it, revert to legacy on breach. */
  check("v62.50: worker asserts the grid's positional contract before assigning durations",
    /gs\.photoOrdinal !== i/.test(rjSrc2) &&
    /does not match scene order/.test(rjSrc2));

  /* ── v62.72/74: the stall hedge, and what its first night taught. It
     fired on 4/7 scenes and every primary won anyway — Kling was slow,
     not stalled, and scene 7's timer counted fal-slot queue time as
     silence. The clock now arms at slot acquisition, defaults to 240s,
     and logs the primary's true silent seconds on every hedge line. */
  {
    const vjSrc74 = fs.readFileSync(path.join(ROOT, "render-worker/src/veo-job.mjs"), "utf8");
    check("v62.75: hedge delay defaults to 300s (above every measured healthy completion)",
      /FAL_HEDGE_DELAY_MS \?\? 300000/.test(rjSrc2));
    check("v62.75: subscribe ceiling back at 360s — the hedge covers the slow tail, the ceiling calls the dead",
      /FAL_SCENE_TIMEOUT_MS\) \|\| 360000/.test(vjSrc74));
    check("v62.74: the hedge clock arms at fal-slot acquisition, not at call time",
      /onSlotAcquired: \(\) => armHedge\(\)/.test(rjSrc2) &&
      /armHedge = \(\) =>/.test(rjSrc2));
    check("v62.74: generateVeoClip reports slot acquisition to its caller",
      /onSlotAcquired = null/.test(vjSrc74) &&
      /acquireFalSlot\(\);[\s\S]{0,260}onSlotAcquired\(\)/.test(vjSrc74));
    check("v62.72: hedge exhaustion floors instead of paying a third generation",
      /FAL_HEDGE_EXHAUSTED/.test(rjSrc2) && /hedge_exhausted/.test(rjSrc2));
    check("v62.74: hedge telemetry logs seconds since the fal slot",
      /after its fal slot/.test(rjSrc2));
  }

  /* ── v62.77: square captions scale down (Troy, after the first
     native-square smoke test: "Lets make the captions smaller for the
     square", then picked the smallest rendered candidate: "Use the
     smallest ones"). v62.18's width-parity remains the VERTICAL law —
     output byte-identical — while squarer-than-9:16 canvases take a
     0.75 em scale, tunable via CAPTIONS_SQUARE_SCALE (clamped 0.5-1). Run
     FUNCTIONALLY against the real module, not regexes. */
  {
    const cap = await import(path.join(ROOT, "render-worker/src/captions.mjs"));
    const w77 = [{ text: "private", start: 0.2, end: 0.6, lineStart: true }, { text: "tour", start: 0.6, end: 1.0 }];
    const fsOf = (ass) => Number((ass.match(/Style: Cap,[^,]+,(\d+),/) || [])[1]);
    const envBefore = process.env.CAPTIONS_SQUARE_SCALE;
    delete process.env.CAPTIONS_SQUARE_SCALE;
    const vert = fsOf(cap.buildCaptionsAss({ words: w77, playW: 1080, playH: 1920, variant: "luxury" }));
    const sq = fsOf(cap.buildCaptionsAss({ words: w77, playW: 1080, playH: 1080, variant: "luxury" }));
    check("v62.77: square captions land at ~75% of vertical type at the same width",
      sq / vert > 0.70 && sq / vert < 0.80, `vert=${vert} sq=${sq}`);
    process.env.CAPTIONS_SQUARE_SCALE = "0.7";
    const sq70 = fsOf(cap.buildCaptionsAss({ words: w77, playW: 1080, playH: 1080, variant: "luxury" }));
    const vertEnv = fsOf(cap.buildCaptionsAss({ words: w77, playW: 1080, playH: 1920, variant: "luxury" }));
    check("v62.77: CAPTIONS_SQUARE_SCALE tunes square without touching vertical",
      sq70 < sq && vertEnv === vert, `sq70=${sq70} vertEnv=${vertEnv}`);
    process.env.CAPTIONS_SQUARE_SCALE = "2";
    const sqClamp = fsOf(cap.buildCaptionsAss({ words: w77, playW: 1080, playH: 1080, variant: "luxury" }));
    check("v62.77: the scale clamps at 1 — square can never exceed width-parity",
      sqClamp === vert, `sqClamp=${sqClamp} vert=${vert}`);
    if (envBefore === undefined) delete process.env.CAPTIONS_SQUARE_SCALE;
    else process.env.CAPTIONS_SQUARE_SCALE = envBefore;
  }

  /* ── v62.78: the render-complete notify line can no longer lie. The api
     returns HTTP 200 with {sent:false, skipped:true} when RESEND_API_KEY
     is missing on Vercel, and the worker logged "email sent" off r.ok
     alone — a week of sent-lines covering zero deliveries (the free
     funnel's deliverable IS this email). */
  {
    const svSrc = fs.readFileSync(path.join(ROOT, "render-worker/server.mjs"), "utf8");
    check("v62.78: worker reads the notify response body — a 200 is not a delivery",
      /info\?\.sent === true/.test(svSrc) && /email SKIPPED for/.test(svSrc));
    check("v62.78: the skip line names the cause and the consequence",
      /RESEND_API_KEY missing on Vercel; nothing was delivered\./.test(svSrc));
  }

  /* ── v62.52: two findings from the Via Del Arbor banner + the curation
     question. (1) The plan API has reported errorCategory since v60.1 and
     the webapp blamed every fallback on "heavy traffic" — now the banner
     names inaccessible-photo and timeout causes and logs the requestId.
     (2) The render button never knew uploads were in flight — an early
     click silently rendered the subset that had finished. (3) Curation
     scored pure marketability and its prompt PROMOTED twilight shots into
     the hero slot — the exact class that boiled and floored scene 1 twice;
     motionRisk now rides every scored photo as a tie-breaker, never a
     reject. */
  const curSrc = fs.readFileSync(path.join(ROOT, "api/curate-photos.js"), "utf8");
  check("v62.52: curation schema requires motionRisk",
    /"motionRisk", "tourOrder"/.test(curSrc) && /motionRisk: \{ type: "number", minimum: 0, maximum: 100 \}/.test(curSrc));
  check("v62.52: risk prompt names the measured failure classes (dusk foliage boil first)",
    /twilight\/dusk shots where foliage fills much of the frame/.test(curSrc) &&
    /dense tree canopies, hedges, or ivy/.test(curSrc));
  check("v62.52: motionRisk is a tie-breaker, never a reject",
    /motionRisk NEVER rejects a photo/.test(curSrc) &&
    /lower motionRisk one opens/.test(curSrc));

  /* ── v62.76: annotated aerials are curated out. The Indian Bend render
     shipped a red property-boundary outline into a Cinematic Luxury cut —
     QC preserved it faithfully because faithfulness is QC's job; the
     selector is the only honest place to stop it. */
  check("v62.76: curation prompt rejects photos with drawn markup (boundary outlines, callouts)",
    /ANNOTATED PHOTOS/.test(curSrc) &&
    /property-boundary outlines/.test(curSrc) &&
    /tourOrder=0, pickWorthiness no higher than 15/.test(curSrc));
  check("v62.76: clean aerials keep their score — only drawn graphics reject",
    /clean aerial with NO drawn graphics keeps its normal score/.test(curSrc));
  check("v62.52: absent motionRisk defaults neutral (50), not zero",
    /clampNumber\(row\.motionRisk \?\? 50, 0, 100\)/.test(curSrc));
  const psSrc = fs.readFileSync(path.join(ROOT, "webapp/src/screens/ProjectScreen.tsx"), "utf8");
  check("v62.52: render button gates on in-flight uploads",
    /const canRender = photos\.length >= 3 && !isRendering && mediaBusy === 0;/.test(psSrc));
  check("v62.52: upload batch holds the gate and releases in finally",
    /adjustMediaBusy\(\+1\)/.test(psSrc) && /adjustMediaBusy\(-1\)/.test(psSrc));
  check("v62.52: fallback banner names the cause instead of always blaming traffic",
    /cat === "inaccessible_image_url"/.test(psSrc) &&
    /cat === "timeout"/.test(psSrc) &&
    /requestId=\$\{planResult\.requestId\}/.test(psSrc));
  const llSrc = fs.readFileSync(path.join(ROOT, "webapp/src/components/ListingLinkImport.tsx"), "utf8");
  check("v62.52: listing import holds the same gate",
    /adjustMediaBusy\(\+1\)/.test(llSrc) && /adjustMediaBusy\(-1\)/.test(llSrc));
  const stSrc = fs.readFileSync(path.join(ROOT, "webapp/src/lib/store.ts"), "utf8");
  check("v62.52: mediaBusy clamps at zero so a stray decrement can't wedge the button",
    /adjustMediaBusy: \(delta\) => set\(\(s\) => \(\{ mediaBusy: Math\.max\(0, s\.mediaBusy \+ delta\) \}\)\)/.test(stSrc));

  /* ── v62.56 (Via Del Arbor zero-photo import): the server names WHY an
     import came back photoless (proxy failure, transfer failure) and WHERE
     the facts came from (factsSource) — the UI dropped all of it into a
     generic toast, the same bug class v62.52 fixed on the plan banner.
     Meanwhile the extractor was live-verified innocent: the shipped regex
     matches 33/33 photos on the actual Zillow page. */
  {
    const llSrc2 = fs.readFileSync(path.join(ROOT, "webapp/src/components/ListingLinkImport.tsx"), "utf8");
    check("v62.56/60: zero-photo toast surfaces the server's own reason, account verdict first",
      /the photos didn't make it: \$\{failNote\}/.test(llSrc2) &&
      /\|\| serverWarnings\[0\] \|\| "";/.test(llSrc2));
    check("v62.56: photoSource/factsSource logged client-side for one-glance diagnosis",
      /photoSource=\$\{result\.photoSource \|\| "\?"\} factsSource=\$\{result\.factsSource \|\| "\?"\}/.test(llSrc2));
    const apiSrc2 = fs.readFileSync(path.join(ROOT, "webapp/src/lib/api.ts"), "utf8");
    check("v62.56: factsSource is typed on the import response",
      /factsSource\?: string;/.test(apiSrc2));
  }

  /* ── v62.57: the proxy ladder's budget trap. Tier 1's timeout was
     min(45s, remaining-of-40s) — the whole page budget — so a tier that
     TIMED OUT (vs failing fast) starved every later tier below the 12s
     floor. And realtor.com started on the tier v58.2 had already measured
     as hopeless there (Kasada), burning credits + the budget the working
     tier needed. First v62.56 toast caught it live. */
  {
    const imSrc = fs.readFileSync(path.join(ROOT, "api/import-listing.js"), "utf8");
    check("v62.57: realtor.com goes straight to the tier that works there",
      /\/\(\^\|\\\.\)realtor\\\.com\$\/\.test\(host\)\s*\?\s*\["ultra_premium=true"\]/.test(imSrc));
    check("v62.57/59/61: tier windows are host-aware — Zillow premium keeps its historical 40s",
      /\? \(rescueEligible \? 38000 : 70000\)/.test(imSrc) &&
      /: \(zillowHost \? 40000 : 22000\);/.test(imSrc));
    check("v62.59: proxy attempts get ScraperAPI's full recommended window",
      /const PROXY_PAGE_TIMEOUT_MS = 70000;/.test(imSrc));
    check("v62.60: a fully-failed proxy run asks the account endpoint for the verdict",
      /api\.scraperapi\.com\/account\?api_key=/.test(imSrc) &&
      /CREDITS EXHAUSTED, every fetch will fail until the plan renews/.test(imSrc) &&
      /concurrency saturated; retries are queuing/.test(imSrc));
    const llSrc4 = fs.readFileSync(path.join(ROOT, "webapp/src/components/ListingLinkImport.tsx"), "utf8");
    check("v62.60: the account verdict outranks per-tier symptoms in the toast",
      /CREDITS EXHAUSTED\|concurrency saturated/.test(llSrc4));
    check("v62.62: proxy exceptions name their real class — AbortError is a timeout, the rest are not",
      /err\?\.name === "AbortError"/.test(imSrc) &&
      /failed instantly: \$\{err\?\.cause\?\.code \|\| err\?\.name \|\| "network error"\}/.test(imSrc) &&
      /status\.scraperapi\.com/.test(imSrc));
    check("v62.57: a budget-skipped tier is a response warning, not just a console line",
      /ran out of time before the \$\{tier\.split\("="\)\[0\]\} tier could run/.test(imSrc));
  }

  /* ── v62.58: realtor.com's Kasada wall outlasted even the fixed ladder
     (second v62.56-era toast: "ultra_premium timed out"). Stop fighting it
     head-on: 120s ceiling, 75s page phase, direct fetch demoted to the
     no-key dev path, and a cross-portal rescue — the parsed address is
     fetched on ZILLOW (where premium demonstrably works), guarded by a
     street-number + name-token identity check so the wrong house is
     impossible (functionally tested in import-extraction.mjs). */
  {
    const imSrc2 = fs.readFileSync(path.join(ROOT, "api/import-listing.js"), "utf8");
    check("v62.58: import ceiling raised to 120s with a 75s page phase",
      /maxDuration: 120/.test(imSrc2) && /t0 \+ 75000/.test(imSrc2));
    check("v62.58: direct fetch runs only without a proxy key",
      /pagePhotoUrls\.length === 0 && !proxyKey/.test(imSrc2));
    check("v62.58: Zillow address rescue exists, identity-guarded, non-zillow hosts only",
      /zillow_address_rescue/.test(imSrc2) &&
      /samePropertyAddress\(address, zAddr\)/.test(imSrc2) &&
      /!\/\(\^\|\\\.\)zillow\\\.com\$\/\.test\(host\)/.test(imSrc2));
    check("v62.58: rescue success is a response warning the toast can show",
      /photos pulled from the Zillow listing at this address instead/.test(imSrc2));
    const apiSrc3 = fs.readFileSync(path.join(ROOT, "webapp/src/lib/api.ts"), "utf8");
    check("v62.58: client abort outlasts the server's grown budget",
      /ctrl\.abort\(\), 140_000/.test(apiSrc3));
    const llSrc3 = fs.readFileSync(path.join(ROOT, "webapp/src/components/ListingLinkImport.tsx"), "utf8");
    check("v62.58: the rescue note surfaces in the success toast",
      /only exposed\|Zillow listing at this address/.test(llSrc3));
  }

  /* ── v62.67 (Pegasus, "ceiling fan" + "brutal hero fallback"): two
     fixes. (a) An out-of-order BIJECTION no longer demotes the Director —
     the scenes reorder to follow the monologue (repeats stay fatal); the
     demotion is what shipped the derived lane's appliance prose. (b)
     Floors over 6.5s render as TWO beats (scene's own move, then a
     different family at opposite flip) joined by a 0.7s crossfade —
     functionally verified: 10s in, 10.03s out, two-beat log present;
     4s path byte-identical. */
  check("v62.67: repeats and broken order are separate diagnoses",
    /let hasRepeat = false;/.test(planSrc) && /let orderBroken = false;/.test(planSrc) &&
    /if \(hasRepeat\) errors\.push\("photo mapping repeats or breaks scene order"\);/.test(planSrc));
  check("v62.67: an out-of-order bijection reorders scenes and keeps the Director",
    /scenes REORDERED to follow the monologue/.test(planSrc) &&
    /if \(!hasRepeat && orderBroken\)/.test(planSrc) &&
    /sceneOrderById\.clear\(\);/.test(planSrc));
  {
    const hdSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/homography-drift.mjs"), "utf8");
    check("v62.67: floors over 6.5s render as two beats with a 0.7s crossfade",
      /const TWO_BEAT_MIN_SEC = 6\.5;/.test(hdSrc) && /const XFADE_SEC = 0\.7;/.test(hdSrc) &&
      /__segment: true/.test(hdSrc) && /two-beat drift/.test(hdSrc));
    check("v62.67: the second beat changes move family and flip parity",
      /sceneIndex: sceneIndex \+ 3, cameraMotion: "lateral_pan"/.test(hdSrc));
  }

  /* ── v62.66: the "took too long" root cause. The Director sent RAW
     full-resolution upload URLs at detail:high — OpenAI downloaded
     100-200MB before thinking, every manual-upload plan. Vision URLs now
     route through Supabase's CDN resize endpoint (verified enabled by
     live probe), with a one-probe global revert if the feature ever
     goes away. */
  check("v62.66: vision URLs route through the CDN resize endpoint at 1280px",
    /function visionSizedUrl\(url\)/.test(planSrc) &&
    /\/storage\/v1\/render\/image\/public\//.test(planSrc) &&
    /width=1280&quality=78/.test(planSrc));
  check("v62.66: non-storage URLs pass through untouched",
    /if \(!\/\\\/storage\\\/v1\\\/object\\\/public\\\/\/\.test\(u\)\) return u;/.test(planSrc));
  check("v62.66: visionPhotos carry originalUrl and one probe reverts all on failure",
    /originalUrl: p\.url,/.test(planSrc) &&
    /url: visionSizedUrl\(p\.url\)/.test(planSrc) &&
    /image transforms unavailable/.test(planSrc) &&
    /for \(const p of visionPhotos\) p\.url = p\.originalUrl;/.test(planSrc));

  /* ── v62.64 (Pinnacle Peak): a 12-photo set got ONE OpenAI attempt (the
     reduced retry only existed >12), and the Gemini failover both lacked
     its key on Vercel AND would have run on a fixed 45s that could blow
     the 120s ceiling. Sets >8 get a lighter second attempt; attempt 2 and
     the failover are wall-clock budgeted; a <10s failover window skips
     loudly instead of trying doomed. */
  check("v62.64: photo sets over 8 get a second, lighter vision attempt",
    /visionPhotos\.length > 8\s*\?\s*\[visionPhotos, visionPhotos\.slice\(0, 8\)\]/.test(planSrc));
  check("v62.64: attempt 2 is wall-clock budgeted, floored at 12s",
    /Math\.min\(30000, Math\.max\(12000, \(PLAN_WALL_SEC - 25 - planElapsedSec\(\)\) \* 1000\)\)/.test(planSrc));
  check("v62.64: the Gemini failover takes what remains of the wall, never a fixed 45s",
    /geminiBudgetMs/.test(planSrc) && /\}, geminiBudgetMs\);/.test(planSrc) &&
    /Gemini failover SKIPPED — only/.test(planSrc));

  /* ── v62.63: the lead auto-render lane recovers. The Jul 27 ScraperAPI
     outage under the old one-shot policy permanently buried every lead
     that arrived during the incident. Transient failures now retry at
     +15m/+1h/+4h (3 max, full pipeline re-run); submit 4xx stays
     terminal; without migration 38 the code degrades to one-shot.
     State machine functionally tested in render-worker/tests/
     lead-retry.test.mjs (12 cases). */
  {
    const laSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/lead-auto-render.mjs"), "utf8");
    check("v62.63: backoff ladder sized to a real supplier incident",
      /const RETRY_BACKOFF_MIN = \[15, 60, 240\];/.test(laSrc));
    check("v62.63: submit 4xx is semantic and terminal; 5xx/network retries",
      /retryable: !\(sub\.status >= 400 && sub\.status < 500\)/.test(laSrc));
    check("v62.63: plan fallback retries the pipeline but never renders the template",
      /plan-fallback\(\$\{plan\.json\?\.errorCategory \|\| "\?"\}\)/.test(laSrc) &&
      /never render the template/i.test(laSrc));
    check("v62.63: due retries are claimed by exact status so workers can't double-run",
      /auto_render_status=eq\.\$\{encodeURIComponent\(lead\.auto_render_status\)\}/.test(laSrc));
    check("v62.63: missing migration 38 degrades to one-shot, loudly",
      /run migration 38/.test(laSrc) && /retryColumnsMissing/.test(laSrc));
    check("v62.63: migration 38 exists — additive columns + partial index",
      fs.existsSync(path.join(ROOT, "supabase/migrations/38_lead_auto_render_retries.sql")) &&
      /auto_render_attempts/.test(fs.readFileSync(path.join(ROOT, "supabase/migrations/38_lead_auto_render_retries.sql"), "utf8")));
  }

  /* ── v62.55: the Meta pixel, finished. pixel.ts existed with PageView/
     Lead/Purchase wired; the funnel Troy's UGC campaign optimizes on
     (ad → signup → free watermarked render → $39 unlock) was missing its
     middle: StartTrial on the free render, InitiateCheckout on the
     paywall click. All of it no-ops until VITE_META_PIXEL_ID is set in
     the Vercel build env. */
  const pxSrc = fs.readFileSync(path.join(ROOT, "webapp/src/lib/pixel.ts"), "utf8");
  check("v62.55: StartTrial event exists with the $39 predicted_ltv",
    /"StartTrial"/.test(pxSrc) && /predicted_ltv: 39/.test(pxSrc) &&
    /content_name: "free_watermarked_render"/.test(pxSrc));
  check("v62.55: InitiateCheckout carries tier value from the price map",
    /trackInitiateCheckout/.test(pxSrc) && /"InitiateCheckout"/.test(pxSrc) &&
    /payg: 39/.test(pxSrc));
  check("v62.55: checkout return still scrubs params so refresh can't double-fire Purchase",
    /searchParams\.delete\("checkout"\)/.test(pxSrc) && /replaceState/.test(pxSrc));
  check("v62.55: every event no-ops without the env-gated pixel id",
    (pxSrc.match(/if \(!PIXEL_ID\) return;/g) || []).length >= 4);
  const pwSrc = fs.readFileSync(path.join(ROOT, "webapp/src/components/PaywallModal.tsx"), "utf8");
  check("v62.55: paywall click fires InitiateCheckout before the Stripe redirect",
    /trackInitiateCheckout\(tier\);/.test(pwSrc) &&
    /import \{ trackInitiateCheckout \} from "\.\.\/lib\/pixel";/.test(pwSrc));
  check("v62.55: StartTrial fires on render acceptance, gated to the free-render class, best-effort",
    /trackStartTrial\(\)/.test(psSrc) &&
    /String\(u\.tier\) === "trial" && Number\(u\.render_credits \|\| 0\) < 1/.test(psSrc) &&
    /\.catch\(\(\) => \{\}\);/.test(psSrc));
  const asSrc = fs.readFileSync(path.join(ROOT, "webapp/src/screens/AuthScreen.tsx"), "utf8");
  check("v62.55: signup still fires the pixel Lead",
    /trackLead\(\);/.test(asSrc));

  /* ── v62.114: the watermark's THIRD swing — obnoxious again, this time
     on data. v62.54 built a wall (breathing centre FREE PREVIEW + echoes
     + banner); v62.79 killed it ("that is too much") and went quiet; with
     the quiet mark live, trial users watched, downloaded the marked
     master free, and left (Victor, Aug 14) — 84 paid leads Aug 10-14,
     checkout clicks, zero purchases. Troy, Aug 15: "make the watermark
     obnoxious again." The new mark splits the prior swings: ONE large
     translucent diagonal 'vistalia.ai · PREVIEW' across mid-frame + the
     v62.79 corner bug — and STILL no wall. These tests guard both
     directions at once: the diagonal must exist, the wall must not
     return. */
  check("v62.114: diagonal centre mark — translucent, rotated, centred, bordered",
    (() => {
      const fn = rjSrc2.match(/export function buildTrialMarkFilterGraph[\s\S]*?\n}/);
      return !!fn && /text='vistalia\.ai  ·  PREVIEW'/.test(fn[0]) &&
        /rotate=-0\.4189:c=none/.test(fn[0]) &&
        /fontcolor=white@0\.45/.test(fn[0]) &&
        /x=\(w-text_w\)\/2:y=\(h-text_h\)\/2/.test(fn[0]);
    })());
  check("v62.114: the corner bug keeps its serif, shadow, and launch position",
    (() => {
      const fn = rjSrc2.match(/export function buildTrialMarkFilterGraph[\s\S]*?\n}/);
      return !!fn && /VistaliaSerif-SemiBold\.ttf/.test(fn[0]) &&
        /text='vistalia\.ai'/.test(fn[0]) && /x=36:y=40/.test(fn[0]) &&
        /shadowcolor=black@0\.55/.test(fn[0]) && !/box=1/.test(fn[0]);
    })());
  check("v62.114: two drawtext layers exactly — diagonal + bug, and no v62.54 wall",
    (() => {
      const fn = rjSrc2.match(/export function buildTrialMarkFilterGraph[\s\S]*?\n}/);
      return !!fn && (fn[0].match(/drawtext=/g) || []).length === 2 &&
        !/FREE PREVIEW/.test(rjSrc2.replace(/\/\/[^\n]*/g, "")) &&
        !/text='VISTALIA'/.test(rjSrc2) &&
        !/upgrade at vistalia\.ai to remove/.test(rjSrc2);
    })());
  check("v62.114: one argv builder feeds all three trial-mark lanes",
    (() => {
      const regenSrc114 = fs.readFileSync(path.join(ROOT, "render-worker/src/regenerate-job.mjs"), "utf8");
      return (rjSrc2.match(/buildTrialMarkArgs\(/g) || []).length === 3 &&
        /buildTrialMarkArgs,/.test(regenSrc114) &&
        (regenSrc114.match(/buildTrialMarkArgs\(/g) || []).length === 1 &&
        !/buildFreeRenderWatermark/.test(rjSrc2.replace(/\/\/[^\n]*/g, "")) &&
        !/buildFreeRenderWatermark/.test(regenSrc114);
    })());
  check("v62.79: agent lower-third speaks the card's voice, not boxed plates",
    (() => {
      const fn = rjSrc2.match(/function buildWatermarkDrawtext[\s\S]*?\n}/)[0];
      return !/box=1/.test(fn) && /0xC7A76C/.test(fn) && /toUpperCase\(\)/.test(fn);
    })());

  /* ── v62.80: the lead auto-render manifest must carry the v62 monologue.
     buildManifest copied the plan field by field and omitted `narration`,
     so every auto-rendered lead fell to the legacy voice path: the street
     address — mandated as the monologue's opening sentence — was never
     spoken, and the voice read as clipped fragments. Silent for five
     delivered customer videos before Troy caught it by ear. */
  // v62.93 gated the spine behind LEAD_RENDERS_VOICELESS (music-only trial
  // default) — the spine must still ride whenever the flag is OFF.
  check("v62.80/v62.93: lead manifest carries plan narration behind the voiceless gate",
    /narration: LEAD_RENDERS_VOICELESS \? null : \(editPlan\.narration \|\| null\)/.test(leadSrc));
  check("v62.80/v62.93: the legacy narration fields ride alongside, gated the same way",
    /narrationScript: LEAD_RENDERS_VOICELESS \? "" : \(editPlan\.narrationScript \|\| ""\)/.test(leadSrc) &&
    /narrationLine: scene\.narrationLine \|\| ""/.test(leadSrc));
  check("v62.80: the plan prompt still mandates the spoken address",
    /the spoken address is the one sentence every listing video must carry/.test(planSrc));

  /* ── v62.53: the Director's scene selection carries the same risk
     tie-breaker as import curation — it picks WHICH photos become scenes
     and which one opens, where both scene-1 floors began. */
  check("v62.53: Director prompt carries the AI MOTION RISK tie-breaker",
    /AI MOTION RISK — every selected photo becomes an AI-animated video scene/.test(planSrc) &&
    /Risk NEVER outranks marketability — it breaks ties\./.test(planSrc));
  check("v62.53: Director risk guidance names the scene-1 stakes",
    /This matters MOST for scene 1/.test(planSrc) &&
    /boil on the very first thing the viewer sees/.test(planSrc));
  check("v62.53: curation and Director agree on the first failure class",
    /twilight\/dusk shots where foliage fills much of the frame/.test(planSrc) &&
    /twilight\/dusk shots where foliage fills much of the frame/.test(curSrc));
}

/* ── v62.88: the repetitive-voiceover fix (638 Eddie Robinson Sr Dr) ───── */
{
  // Pull the real implementations under their real names so intra-calls
  // resolve. ROOM_WORDS is already on globalThis from the v62.40 block.
  eval(`globalThis.roomTypesNamedIn = ${grab(planSrc, "roomTypesNamedIn").replace(/^function \w+/, "function")}`);
  eval(`globalThis.NARRATION_DEDUP_STOP = ${(planSrc.match(/const NARRATION_DEDUP_STOP = (new Set\(\[[\s\S]*?\]\));/) || [])[1]}`);
  eval(`globalThis.narrationContentWords = ${grab(planSrc, "narrationContentWords").replace(/^function \w+/, "function")}`);
  eval(`globalThis.isNearDuplicateNarration = ${grab(planSrc, "isNearDuplicateNarration").replace(/^function \w+/, "function")}`);
  eval(`globalThis.dedupeConsecutiveNarrationSentences = ${grab(planSrc, "dedupeConsecutiveNarrationSentences").replace(/^function \w+/, "function")}`);
  eval(`globalThis.repairAdjacentPhotoRepeats = ${grab(planSrc, "repairAdjacentPhotoRepeats").replace(/^function \w+/, "function")}`);

  // The exact pair that shipped on Aug 11 (worker log, verbatim).
  const kitchenA = "The kitchen features sleek stainless steel appliances paired with crisp white cabinetry that gleams under soft lighting.";
  const kitchenB = "The kitchen’s modern stainless steel appliances perfectly complement the clean, white cabinetry, creating a fresh and functional cooking space.";
  check("v62.88: the Eddie Robinson kitchen pair reads as a near-duplicate",
    isNearDuplicateNarration(kitchenA, kitchenB) === true);

  // Legitimate neighbors must NOT collapse.
  check("v62.88: a room transition is not a duplicate",
    isNearDuplicateNarration(
      "The dining space flows seamlessly into a modern kitchen with sleek countertops.",
      "This home offers comfortable bedrooms and stylish bathrooms for your daily retreat."
    ) === false);
  check("v62.88: two different rooms with shared adjectives are not duplicates",
    isNearDuplicateNarration(
      "The primary bedroom offers soft natural light and warm wood floors.",
      "The living room pairs warm wood tones with a stone fireplace."
    ) === false);

  // The join collapses the rerun and the photos ride as a linger.
  const joined = [
    { text: "Welcome to 638 Eddie Robinson Sr Dr.", photos: ["p1"] },
    { text: kitchenA, photos: ["p2"] },
    { text: kitchenB, photos: ["p3"] },
    { text: "Schedule your private tour today.", photos: ["p4"] }
  ];
  const drops = dedupeConsecutiveNarrationSentences(joined);
  check("v62.88: derived join drops exactly the rerun sentence",
    drops.length === 1 && joined.length === 3 && /modern stainless steel/.test(drops[0]));
  check("v62.88: the dropped sentence's photo rides the previous scene as a linger",
    joined[1].photos.join(",") === "p2,p3");

  // Director repair: an ADJACENT re-mention becomes a linger…
  const ordOf = new Map([["a", 0], ["b", 1], ["c", 2]]);
  const dwell = [
    { text: "s1", photos: ["a"] },
    { text: "s2", photos: ["a", "b"] },
    { text: "s3", photos: ["c"] }
  ];
  const repairedDwell = repairAdjacentPhotoRepeats(dwell, ordOf);
  check("v62.88: adjacent re-mention repaired to a linger (Director's read survives)",
    repairedDwell === 1 && dwell[1].photos.join(",") === "b");
  // …while a genuine double-back stays for the fatal scan.
  const doubleBack = [
    { text: "s1", photos: ["a"] },
    { text: "s2", photos: ["b"] },
    { text: "s3", photos: ["a"] }
  ];
  const repairedBack = repairAdjacentPhotoRepeats(doubleBack, ordOf);
  check("v62.88: non-adjacent repeat is NOT repaired — stays fatal downstream",
    repairedBack === 0 && doubleBack[2].photos.join(",") === "a");

  // Wiring: repair runs before the fatal repeat verdict; dedup runs inside
  // the derived join before the address hook.
  check("v62.88: repair is wired ahead of the repeat verdict",
    planSrc.indexOf("repairAdjacentPhotoRepeats(sentences") !== -1 &&
    planSrc.indexOf("repairAdjacentPhotoRepeats(sentences") < planSrc.indexOf('errors.push("photo mapping repeats'));
  check("v62.88: dedupe is wired into the derived join before the address hook",
    planSrc.indexOf("dedupeConsecutiveNarrationSentences(sentences)") !== -1 &&
    planSrc.indexOf("dedupeConsecutiveNarrationSentences(sentences)") < planSrc.indexOf("const addrLine"));
}

/* ── v62.89: the photo-swap rung (minimize Ken Burns floors) ──────────── */
{
  const rjSrc89 = fs.readFileSync(path.join(ROOT, "render-worker/src/runway-job.mjs"), "utf8");
  const vqSrc89 = fs.readFileSync(path.join(ROOT, "render-worker/src/veo-qc.mjs"), "utf8");
  eval(`globalThis.pickSwapCandidate = ${grab(rjSrc89, "pickSwapCandidate").replace(/^function \w+/, "function")}`);
  eval(`globalThis.narrationTextForPhoto = ${grab(rjSrc89, "narrationTextForPhoto").replace(/^function \w+/, "function")}`);

  const photos = [
    { id: "p1", publicUrl: "u1" },
    { id: "p2", publicUrl: "u2" },
    { id: "p3", publicUrl: "u3" },
    { id: "p4", publicUrl: "u4" },
    { id: "p5", publicUrl: "u5" },
    { id: "p6", publicUrl: "u6" }
  ];
  const mani = { orderedPhotos: photos, scenes: [{ photoId: "p1" }, { photoId: "p3" }, { photoId: "p5" }] };
  const failing = { photoId: "p3", roomType: "kitchen" };

  // Listing exports group rooms — the unused photo NEXT TO the failing one
  // is likeliest the same room. p2/p4/p6 are unused; p2 and p4 tie at
  // distance 1 and the earlier wins.
  check("v62.89: picks the nearest unused neighbor of the failing photo",
    pickSwapCandidate(failing, mani)?.id === "p2");
  check("v62.89: excludeIds (claimed/rejected candidates) are respected",
    pickSwapCandidate(failing, mani, { excludeIds: new Set(["p2"]) })?.id === "p4");
  check("v62.89: every photo used by a scene → no candidate",
    pickSwapCandidate(
      { photoId: "p1" },
      { orderedPhotos: photos.slice(0, 2), scenes: [{ photoId: "p1" }, { photoId: "p2" }] }
    ) === null);
  check("v62.89: candidates without a usable URL are filtered out",
    pickSwapCandidate(failing, {
      orderedPhotos: [photos[0], { id: "p2" }, photos[2], photos[3], photos[4], photos[5]],
      scenes: mani.scenes
    })?.id === "p4");
  check("v62.89: the failing photo itself is never its own candidate",
    pickSwapCandidate(
      { photoId: "p1" },
      { orderedPhotos: photos.slice(0, 2), scenes: [{ photoId: "p2" }] }
    ) === null);
  check("v62.89: room-labeled unused photos take priority over proximity",
    pickSwapCandidate(failing, {
      orderedPhotos: [photos[0], photos[1], photos[2], photos[3], photos[4], { id: "p6", publicUrl: "u6", roomType: "Kitchen" }],
      scenes: mani.scenes
    })?.id === "p6");

  const nMani = { narration: { sentences: [
    { text: "Welcome home.", photos: ["p1"] },
    { text: "The kitchen gleams with stainless appliances.", photos: ["p2"] },
    { text: "White cabinetry wraps the island.", photos: ["p2", "p3"] },
    { text: "Schedule your tour.", photos: [] }
  ] } };
  check("v62.89: narrationTextForPhoto joins exactly the sentences mapped to the photo",
    narrationTextForPhoto(nMani, "p2") === "The kitchen gleams with stainless appliances. White cabinetry wraps the island." &&
    narrationTextForPhoto(nMani, "p1") === "Welcome home.");
  check("v62.89: pre-v62 manifests (no narration.sentences) yield empty text",
    narrationTextForPhoto({}, "p2") === "" && narrationTextForPhoto({ narration: {} }, "p2") === "");

  // ── Wiring: the rung sits BEFORE the floor at both surrender points. ──
  check("v62.89: rung wired at both floor sites, ahead of each floor",
    (rjSrc89.match(/await attemptPhotoSwapRung\(scene, index/g) || []).length === 2 &&
    rjSrc89.indexOf("const swappedA") !== -1 &&
    rjSrc89.indexOf("const swappedA") < rjSrc89.indexOf("failed twice (") &&
    rjSrc89.indexOf("const swappedB") !== -1 &&
    rjSrc89.indexOf("const swappedB") < rjSrc89.indexOf("hard-failed all three attempts"));
  check("v62.89: a substitute ships ONLY on a completed full QC pass (fail-closed)",
    /!verdict\.checked \|\| !verdict\.pass/.test(rjSrc89) &&
    /fail-closed for substitutes/.test(rjSrc89));
  check("v62.89: swapped source threaded to the final sweep's reference",
    rjSrc89.includes("scene.__deliveryAspectUrl = swapSrcUrl"));
  check("v62.89: swap clone keeps scene identity — strips URL fields and plan prompts only",
    /durable_url: "", publicUrl: "", public_url: "", imageUrl: ""/.test(rjSrc89) &&
    /veoPrompt: "", veo_prompt: "", runwayPrompt: "", runway_prompt: ""/.test(rjSrc89) &&
    !/photoId: candidate\.id/.test(rjSrc89));
  check("v62.89: candidates are claimed before any await (concurrent scenes can't collide)",
    rjSrc89.indexOf("swapConsumedIds.add(String(candidate.id))") !== -1 &&
    rjSrc89.indexOf("swapConsumedIds.add(String(candidate.id))") < rjSrc89.indexOf("await qcSwapCandidatePhoto"));
  check("v62.89: audit rows carry swap provenance for floor-rate queries",
    rjSrc89.includes("swappedPhotoId: original.swappedPhotoId || null") &&
    rjSrc89.includes("swappedPhotoUrl"));
  check("v62.89: kill switch and per-job cap exist",
    rjSrc89.includes("PHOTO_SWAP_RUNG") && rjSrc89.includes("MAX_SWAPS_PER_JOB"));
  check("v62.89: vision gate exported, fails CLOSED, and rejects non-room junk photos",
    vqSrc89.includes("export async function qcSwapCandidatePhoto") &&
    /match: false, checked: false/.test(vqSrc89) &&
    /floor plans, site maps/.test(vqSrc89) &&
    rjSrc89.includes('qcSwapCandidatePhoto } from "./veo-qc.mjs"'));
}

/* ── v62.90: constrained Kling rungs stay real moving shots (Eddie s1) ── */
{
  const vj90 = fs.readFileSync(path.join(ROOT, "render-worker/src/veo-job.mjs"), "utf8");
  const rj90 = fs.readFileSync(path.join(ROOT, "render-worker/src/runway-job.mjs"), "utf8");
  const between = (src, start) => {
    const i = src.indexOf(start);
    if (i === -1) return "";
    return src.slice(i, src.indexOf(";", i));
  };
  const steadyActive = between(vj90, "const KLING_MOTION_SUFFIX = KLING_CALM_LEGACY ? KLING_MOTION_SUFFIX_LEGACY :");
  const strictActive = between(vj90, "const KLING_MOTION_STRICT = KLING_CALM_LEGACY ? KLING_MOTION_STRICT_LEGACY :");
  const strictLegacy = between(vj90, "const KLING_MOTION_STRICT_LEGACY =");

  check("v62.90: active STRICT demands continuous real motion, drops the museum-static asks",
    strictActive.includes("never stops moving") &&
    strictActive.includes("not a still photograph") &&
    !strictActive.includes("small fraction of travel") &&
    !strictActive.includes("otherwise perfectly still"));
  check("v62.90: active STEADY asks for visible constant-speed travel with pronounced parallax",
    steadyActive.includes("constant-speed") &&
    steadyActive.includes("pronounced natural perspective parallax") &&
    steadyActive.includes("never a static hold"));
  check("v62.90: legacy strings preserved behind the KLING_CALM_LEGACY escape hatch",
    strictLegacy.includes("small fraction of travel") &&
    strictLegacy.includes("museum-grade calm") &&
    vj90.includes("KLING_CALM_LEGACY ? KLING_MOTION_SUFFIX_LEGACY") &&
    vj90.includes("KLING_CALM_LEGACY ? KLING_MOTION_STRICT_LEGACY") &&
    vj90.includes('process.env.KLING_CALM_LEGACY || "0"'));
  check("v62.90: the sacred v62.45 gimbal BOLD string is untouched",
    vj90.includes("motorized slider on") && vj90.includes("invisible rails"));
  check("v62.90: Kling ladder de-escalates monotonically — QC regen rides steady, gentle re-roll rides strict",
    rj90.includes('motionStyle: gentleReroll ? "strict" : constrained ? "steady" : "bold"') &&
    !rj90.includes('motionStyle: strictConstrained ? "strict"') &&
    rj90.includes("INVERTED-LADDER FIX"));
}

/* ── v62.91: Pryor OK — absent-room set-guard + QC contents inventory ──── */
{
  const plan91 = fs.readFileSync(path.join(ROOT, "api/create-edit-plan.js"), "utf8");
  const vq91 = fs.readFileSync(path.join(ROOT, "render-worker/src/veo-qc.mjs"), "utf8");
  eval(`globalThis.setAbsent = ${grab(plan91, "narrationSetAbsentRoomOffenses").replace(/^function \w+/, "function")}`);

  // The Pryor cut, reconstructed: living ×2, bathroom ×2, staged-closet
  // detail ×2 — and the exact bedrooms sentence that shipped off-track.
  const rooms = new Map([["p1", "living"], ["p2", "living"], ["p3", "bathroom"], ["p4", "detail"], ["p5", "detail"], ["p6", "bathroom"]]);
  const cut = ["living", "living", "bathroom", "detail", "detail", "bathroom"];
  const pryor = [
    { text: "Welcome to 1021 N 4345th Rd in Pryor Oklahoma.", photos: ["p1"] },
    { text: "Step inside to a bright open space with vaulted ceilings and a modern fireplace.", photos: ["p2"] },
    { text: "Bedrooms offer spacious layouts with ample sunlight and the bathrooms showcase clean contemporary finishes.", photos: ["p3"] },
    { text: "Enjoy organized closets and thoughtful storage throughout.", photos: ["p4", "p5"] },
    { text: "This home blends comfort and style perfectly.", photos: ["p6"] },
    { text: "Contact the listing agent at their brokerage to see it today.", photos: [] }
  ];
  const off = setAbsent(pryor, rooms, cut);
  check("v62.91: the Pryor bedrooms sentence is caught — one offense, right sentence, right claim",
    off.length === 1 && off[0].index === 2 && off[0].claim === "bedroom");
  check("v62.91: the closets sentence survives (no ROOM_WORD, detail-mapped)",
    !off.some((o) => o.index === 3));
  check("v62.91: a bedroom scene in the cut clears the same sentence",
    setAbsent(pryor, rooms, [...cut, "bedroom"]).length === 0);
  check("v62.91: asymmetry — a living claim IS satisfied by bedroom-only scenes",
    setAbsent(
      [{ text: "The living room glows with light.", photos: ["b1"] }],
      new Map([["b1", "bedroom"]]), ["bedroom"]
    ).length === 0);
  check("v62.91: closeup benefit of the doubt — kitchen claim over detail-only photos is exempt",
    setAbsent(
      [{ text: "The kitchen shines with brass fixtures.", photos: ["d1"] }],
      new Map([["d1", "detail"]]), ["detail", "living"]
    ).length === 0);
  check("v62.91: multi-room sentences are judged per claim (no single-name skip)",
    (() => {
      const o = setAbsent(
        [{ text: "The kitchen flows into the bathroom beautifully.", photos: ["x1"] }],
        new Map([["x1", "bathroom"]]), ["bathroom", "living"]
      );
      return o.length === 1 && o[0].claim === "kitchen";
    })());
  check("v62.91: offender shape matches the repair lane (index/claim/actual/linger) and lingers ride prior photos",
    (() => {
      const o = setAbsent(
        [{ text: "A bright space.", photos: ["x1"] }, { text: "The kitchen gleams.", photos: [] }],
        new Map([["x1", "bathroom"]]), ["bathroom"]
      );
      return o.length === 1 && o[0].index === 1 && o[0].claim === "kitchen" &&
        Array.isArray(o[0].actual) && o[0].actual[0] === "bathroom" && o[0].linger === true;
    })());
  check("v62.91: NARRATION_SET_GUARD=0 kill switch disables the guard",
    (() => {
      process.env.NARRATION_SET_GUARD = "0";
      const r = setAbsent(pryor, rooms, cut);
      delete process.env.NARRATION_SET_GUARD;
      return r.length === 0;
    })());

  // Wiring: enforcement carries the room-repair magic phrase; the repair
  // lane concatenates + dedupes both offender kinds.
  check("v62.91: set-guard error text feeds the existing room-repair lane",
    plan91.includes("name a room the photo does not show anywhere in this cut") &&
    /name a room the photo does not show/.test("1 sentence(s) name a room the photo does not show anywhere in this cut"));
  check("v62.91: repair lane receives both offender kinds, deduped by sentence index",
    plan91.includes("[...narrationRoomMismatches(origSents, roomById), ...setOffenders]") &&
    plan91.includes("offenderSeen.has(o.index)"));

  // QC contents inventory: in the SHARED inspection core (per-clip + sweep),
  // with garments added to the temporal boil list.
  check("v62.91: QC prompt carries the storage/staging CONTENTS INVENTORY",
    vq91.includes("CONTENTS INVENTORY") &&
    vq91.includes("EMPTIED ITSELF") &&
    vq91.includes("same contents, not") &&
    vq91.includes("compare the LAST frame against the") );
  check("v62.91: garments join the temporal structure-rewrite list; sweep shares the core",
    vq91.includes("racks of hanging clothes, folded garment") &&
    vq91.includes('logTag: "sweep"'));
}

/* ── v62.92: repair-with-eyes + dining claim word ──────────────────────── */
{
  const plan92 = fs.readFileSync(path.join(ROOT, "api/create-edit-plan.js"), "utf8");

  // dining: claim-only room word, satisfied by kitchen/living, flagged over the rest.
  check("v62.92: dining phrases register as claims; dinner-party copy does not",
    [...roomTypesNamedIn("The dining area glows warmly.")].join() === "dining" &&
    [...roomTypesNamedIn("A sunny breakfast nook off the kitchen.")].includes("dining") &&
    roomTypesNamedIn("Perfect for dinner parties on the patio.").has("dining") === false);
  check("v62.92: dining is satisfied by kitchen and living labels, not bathroom",
    sameRoomClass("dining", "kitchen") && sameRoomClass("kitchen", "dining") &&
    sameRoomClass("dining", "living") && !sameRoomClass("dining", "bathroom") &&
    !sameRoomClass("dining", "exterior"));
  check("v62.92: a dining claim over a bathroom photo is a per-photo mismatch; over a kitchen it is not",
    roomMismatches(
      [{ text: "The dining area glows warmly.", photos: ["x"] }], new Map([["x", "bathroom"]])
    ).length === 1 &&
    roomMismatches(
      [{ text: "The dining area glows warmly.", photos: ["x"] }], new Map([["x", "kitchen"]])
    ).length === 0);
  check("v62.92: set-guard — dining claim with no kitchen/living/dining anywhere in the cut is an offense",
    setAbsent(
      [{ text: "The dining area glows warmly.", photos: ["x"] }],
      new Map([["x", "bathroom"]]), ["bathroom", "bedroom"]
    ).length === 1 &&
    setAbsent(
      [{ text: "The dining area glows warmly.", photos: ["x"] }],
      new Map([["x", "bathroom"]]), ["kitchen", "bathroom"]
    ).length === 0);

  // Offenders now carry their mapped photo ids for the repair call.
  check("v62.92: both offender kinds carry photoIds (the repair's eyes)",
    (() => {
      const m = roomMismatches(
        [{ text: "The bathroom shines with marble.", photos: ["p9"] }], new Map([["p9", "kitchen"]])
      );
      const s = setAbsent(
        [{ text: "The kitchen gleams brightly.", photos: ["p9"] }], new Map([["p9", "bathroom"]]), ["bathroom"]
      );
      return m.length === 1 && m[0].photoIds?.join() === "p9" &&
             s.length === 1 && s[0].photoIds?.join() === "p9";
    })());

  // Repair-with-eyes wiring: images attached, features-first rules, variety
  // rule, no-carryover rule, capped+deduped, text-only fail-open intact.
  const repairSrc = grab(plan92, "repairNarrationRooms");
  check("v62.92: repair call attaches offender photos as input_image at low detail",
    repairSrc.includes('type: "input_image"') &&
    repairSrc.includes('detail: "low"') &&
    repairSrc.includes("photo for sentence") &&
    repairSrc.includes("imageParts.length < 4"));
  check("v62.92: rewrite rules — features-first, no carried-over claims, hard variety rule",
    repairSrc.includes("PHOTO ATTACHED: describe what THAT photo actually shows") &&
    repairSrc.includes("NEVER carry feature claims over") &&
    repairSrc.includes("VARIETY IS A HARD RULE"));
  check("v62.92: repair fails open to text-only when no photo URL resolves",
    repairSrc.includes("photoUrlById") &&
    /if \(url && !seenUrl\.has\(url\)/.test(repairSrc));
  check("v62.92: call site hands the repair a photoId→URL map from the plan's photos",
    plan92.includes("const photoUrlById = new Map((photos || []).map((p) => [") &&
    plan92.includes("{ roomById, photoUrlById, listingDetails, selectedStyle, timeoutMs: repairBudget }"));
}

/* ── v62.93: voiceless trial default + selection guard + feature-verify ── */
{
  const plan93 = fs.readFileSync(path.join(ROOT, "api/create-edit-plan.js"), "utf8");
  const lead93 = fs.readFileSync(path.join(ROOT, "render-worker/src/lead-auto-render.mjs"), "utf8");

  // #3 — trial URL renders default to music-only, flippable without deploy.
  check("v62.93: voiceless default ON, env-flippable (LEAD_RENDERS_VOICELESS)",
    lead93.includes('process.env.LEAD_RENDERS_VOICELESS || "1"') &&
    lead93.includes("skipNarration: LEAD_RENDERS_VOICELESS") &&
    lead93.includes("captionsEnabled: !LEAD_RENDERS_VOICELESS") &&
    lead93.includes("includeNarration: !LEAD_RENDERS_VOICELESS"));
  check("v62.93: the worker log names voiceless mode on every lead job",
    lead93.includes('VOICELESS — music-only'));

  // #1a — thumbnail-class photos dropped, fail-open.
  check("v62.93: thumbnail filter drops <40KB photos only when ≥6 full-res remain, fail-open on missing sizes",
    lead93.includes("LEAD_PHOTO_MIN_BYTES") &&
    lead93.includes("large.length >= 6") &&
    lead93.includes("sized.length === photos.length"));

  // #1b — the Director carries hard diversity rules + the headline asset rule.
  check("v62.93: Director prompt carries SCENE DIVERSITY hard rules",
    plan93.includes("SCENE DIVERSITY — HARD RULES") &&
    plan93.includes("At most TWO scenes may show the home's exterior") &&
    plan93.includes("washer/dryer, water heater, or storage racking"));
  check("v62.93: THE HEADLINE ASSET RULE names the Floramar failure class",
    plan93.includes("THE HEADLINE ASSET RULE") &&
    plan93.includes("waterfront home whose video never shows the water has failed"));
  check("v62.93: diversity telemetry runs on reconciled labels after verify-repair",
    plan93.includes("SELECTION DIVERSITY violated despite v62.93 prompt rules") &&
    plan93.includes("selection mix:") &&
    plan93.indexOf("await verifyAndRepairScenes(normalizedPlan") < plan93.indexOf("SELECTION DIVERSITY violated"));

  // #2 — feature-verify: fail-open, scoped, capped, feeding the eyes-on repair lane.
  const fvSrc = grab(plan93, "verifyNarrationFeatures");
  check("v62.93: feature-verify judges only concrete claims and fails OPEN when uncertain",
    fvSrc.includes("CONCRETE VISUAL claims") &&
    fvSrc.includes("When uncertain, or when the claim could") &&
    fvSrc.includes("supported=true"));
  check("v62.93: hook and CTA exempt, short sentences skipped, capped at 6 calls",
    fvSrc.includes("i === 0 || i === sentences.length - 1") &&
    fvSrc.includes(".split(/\\s+/).length < 5") &&
    fvSrc.includes("jobs.slice(0, 6)") &&
    fvSrc.includes("NARRATION_FEATURE_VERIFY"));
  check("v62.93: feature offenders carry the repair lane's full shape",
    fvSrc.includes("featureClaim: true") &&
    fvSrc.includes("photoIds: [j.photoId]") &&
    fvSrc.includes("claim: String(verdict.unsupported)"));
  check("v62.93: feature-verify wired after room-repair, before the lengthen pass, stamping its own source",
    plan93.indexOf("FEATURE-VERIFY: the monologue meets the pixels") !== -1 &&
    plan93.indexOf("room-repair unavailable") < plan93.indexOf("FEATURE-VERIFY: the monologue meets the pixels") &&
    plan93.indexOf("FEATURE-VERIFY: the monologue meets the pixels") < plan93.indexOf("v62.17: if the narration came in under") &&
    plan93.includes('replace(/^director/, "director+feature-repaired")'));
}

/* ── v62.94: double-back repair + derived smoothing + relevance harvest ── */
{
  const plan94 = fs.readFileSync(path.join(ROOT, "api/create-edit-plan.js"), "utf8");
  const imp94 = fs.readFileSync(path.join(ROOT, "api/import-listing.js"), "utf8");
  eval(`globalThis.dbRepair = ${grab(plan94, "repairDoubleBackPhotoRepeats").replace(/^function \w+/, "function")}`);
  eval(`globalThis.factsFrom = ${grab(imp94, "factsFromHtml").replace(/^function \w+/, "function")}`);

  // Double-back repair: the later mention drops, the sentence lingers.
  const ordsDb = new Map([["a", 0], ["b", 1], ["c", 2]]);
  const db1 = [
    { text: "s1", photos: ["a"] },
    { text: "s2", photos: ["b"] },
    { text: "s3", photos: ["a", "c"] }
  ];
  const dropped1 = dbRepair(db1, ordsDb);
  check("v62.94: non-adjacent re-mention dropped, first mentions and fresh photos survive",
    dropped1.length === 1 && dropped1[0].sentence === 2 && dropped1[0].id === "a" &&
    db1[2].photos.join(",") === "c" && db1[0].photos.join(",") === "a");
  const db2 = [
    { text: "s1", photos: ["a"] },
    { text: "s2", photos: ["b"] },
    { text: "s3", photos: ["a"] }
  ];
  dbRepair(db2, ordsDb);
  check("v62.94: a sentence emptied by the repair becomes a linger (Pretoria's fix)",
    db2[2].photos.length === 0);
  const db3 = [{ text: "s1", photos: ["a"] }, { text: "s2", photos: ["b"] }, { text: "s3", photos: ["c"] }];
  check("v62.94: a clean mapping is untouched",
    dbRepair(db3, ordsDb).length === 0 && db3[2].photos.join(",") === "c");
  check("v62.94: wiring — snapshot cap leaves chaos fatal, source stamps doubleback-repaired",
    plan94.includes("beyond the repair cap") &&
    plan94.includes('"director+doubleback-repaired"') &&
    plan94.lastIndexOf("repairAdjacentPhotoRepeats(sentences") < plan94.lastIndexOf("repairDoubleBackPhotoRepeats(sentences"));

  // Remarks harvest: agent copy in, synthetic meta line out.
  const agentCopy = "Welcome to this beautifully maintained waterfront retreat with a new roof in 2024, deep-water dock with lift, chef's kitchen with quartz island, and a screened lanai overlooking the canal. Minutes to the Gulf by boat.";
  const html94 =
    '<meta name="description" content="Zillow has 73 photos of this $450,000 3 beds, 2 baths, 1,800 sqft home">' +
    '<script>{"x":{"description":"{\\"nested\\":true}"},"description":"' + agentCopy + '","other":1}</script>';
  const facts94 = factsFrom(html94);
  check("v62.94: remarks harvested from embedded page JSON, synthetic Zillow meta line rejected",
    typeof facts94?.remarks === "string" &&
    facts94.remarks.includes("deep-water dock") &&
    !/^zillow has/i.test(facts94.remarks));
  check("v62.94: pages without agent copy yield no remarks key",
    !("remarks" in (factsFrom('<meta name="description" content="Zillow has 5 photos of this home">') || {})));
  check("v62.94: RentCast yearBuilt/lotSize/propertyType ride the facts",
    imp94.includes("yearBuilt: rec.yearBuilt") &&
    imp94.includes("lotSize: rec.lotSize") &&
    imp94.includes("propertyType: rec.propertyType"));

  // Derived smoothing: exact-count contract, offense gate, kill switch.
  const smSrc = grab(plan94, "smoothDerivedNarration");
  check("v62.94: smoothing holds sentence count, targets the word budget, bans fair-housing topics",
    smSrc.includes("minItems: n, maxItems: n") &&
    smSrc.includes("narrationWordBudget(targetDurationSec, voiceId)") &&
    smSrc.includes("Never mention schools"));
  check("v62.94: smoothing wired on derived source only, rejected on any new room offense, stamped +smoothed",
    plan94.includes('String(narD.source).startsWith("derived-from-lines")') &&
    plan94.includes("derived smoothing REJECTED") &&
    plan94.includes("${narD.source}+smoothed") &&
    plan94.includes("DERIVED_SMOOTHING"));

  // Relevance guidance + fair-housing fence + feature-verify carve-out.
  check("v62.94: Director guidance carries facts-in-hook, remarks mining, and the fair-housing fence",
    plan94.includes("USE THE LISTING FACTS") &&
    plan94.includes("MINE THE REMARKS") &&
    plan94.includes("FAIR HOUSING — ABSOLUTE") &&
    plan94.includes("Speak the price ONLY when the style is MLS or Investor"));
  check("v62.94: feature-verify ignores listing-attributed facts a photo could never show",
    plan94.includes("listing-attributed facts a photo could never show"));
}

/* ── v62.95: the free-text listing resolver (Steve Katsaros gap) ───────── */
{
  const res95 = fs.readFileSync(path.join(ROOT, "api/resolve-listing.js"), "utf8");
  const sync95 = fs.readFileSync(path.join(ROOT, "api/meta-leads-sync.js"), "utf8");
  const lead95 = fs.readFileSync(path.join(ROOT, "render-worker/src/lead-auto-render.mjs"), "utf8");
  eval(`globalThis.looksLikeListingQuery = ${grab(res95, "looksLikeListingQuery").replace(/^export function \w+/, "function").replace(/^function \w+/, "function")}`);
  eval(`globalThis.hdUrl = ${grab(res95, "homedetailsUrlFromHtml").replace(/^export function \w+/, "function").replace(/^function \w+/, "function")}`);

  check("v62.95: full addresses and MLS numbers qualify as resolvable queries",
    looksLikeListingQuery("4320 Floramar Terrace, New Port Richey FL") === true &&
    looksLikeListingQuery("33578 E 160th Avenue Hudson CO 80642") === true &&
    looksLikeListingQuery("MLS# 2534567") === true);
  check("v62.95: fragments, replies, emails, and URLs stay in the manual lane",
    looksLikeListingQuery("110 Hunter") === false &&
    looksLikeListingQuery("Send me sample.") === false &&
    looksLikeListingQuery("steve@stevekatsaros.com") === false &&
    looksLikeListingQuery("https://www.zillow.com/homedetails/x_zpid/") === false &&
    looksLikeListingQuery("123 456 789") === false);
  check("v62.95: homedetails URL extracted from canonical, hdpUrl, and og:url shapes",
    hdUrl('<link rel="canonical" href="https://www.zillow.com/homedetails/4320-Floramar-Terrace/46349025_zpid/"/>') ===
      "https://www.zillow.com/homedetails/4320-Floramar-Terrace/46349025_zpid/" &&
    hdUrl('{"hdpUrl":"/homedetails/110-Hunter-Rd/123_zpid/"}') ===
      "https://www.zillow.com/homedetails/110-Hunter-Rd/123_zpid/" &&
    hdUrl('<link rel="canonical" href="https://www.zillow.com/new-port-richey-fl/"/>') === "");

  // parseFieldData promotes address-like text (URL behavior unchanged).
  eval(`globalThis.parseFields = ${grab(sync95, "parseFieldData").replace(/^function \w+/, "function")}`);
  const promoted = parseFields([{ name: "your listing link", values: ["4320 Floramar Terrace, New Port Richey FL"] }]);
  const fragment = parseFields([{ name: "your listing link", values: ["110 Hunter"] }]);
  const urlLead = parseFields([{ name: "your listing link", values: ["https://www.zillow.com/homedetails/x/1_zpid/"] }]);
  check("v62.95: sync promotes full addresses, keeps fragments manual, leaves URLs untouched",
    promoted.listingUrl === "4320 Floramar Terrace, New Port Richey FL" &&
    fragment.listingUrl === "" &&
    urlLead.listingUrl === "https://www.zillow.com/homedetails/x/1_zpid/");

  // Wiring: fail-closed verification, worker-only secret, retry taxonomy.
  // v62.96 widened auth from worker-only to worker + signed-in users
  // (the dump area's typed-address path) — the fail-closed verification
  // contract is unchanged.
  check("v62.95/96: resolver verifies the page address fail-closed, worker secret or signed-in user",
    res95.includes("samePropertyAddress({ line: query }, pageAddress)") &&
    res95.includes("Fail closed") &&
    res95.includes("internalSecret === process.env.CRON_SECRET"));
  check("v62.95: worker resolves scheme-less listing_url before import — transient retries, not_found terminal",
    lead95.includes('!/^https?:\\/\\//i.test(listingUrl)') &&
    lead95.includes("/api/resolve-listing") &&
    lead95.includes('"resolve(fetch_failed)", { retryable: true }') &&
    lead95.includes("retryable: false") &&
    lead95.includes("url: listingUrl, projectId"));
}

/* ── v62.96: the dump area — typed addresses, EXIF rescue, voice context ── */
{
  const lli96 = fs.readFileSync(path.join(ROOT, "webapp/src/components/ListingLinkImport.tsx"), "utf8");
  const ps96 = fs.readFileSync(path.join(ROOT, "webapp/src/screens/ProjectScreen.tsx"), "utf8");
  const api96 = fs.readFileSync(path.join(ROOT, "webapp/src/lib/api.ts"), "utf8");
  const ty96 = fs.readFileSync(path.join(ROOT, "webapp/src/lib/types.ts"), "utf8");
  const st96 = fs.readFileSync(path.join(ROOT, "webapp/src/lib/store.ts"), "utf8");
  const ex96 = fs.readFileSync(path.join(ROOT, "webapp/src/lib/exif-gps.ts"), "utf8");
  const res96 = fs.readFileSync(path.join(ROOT, "api/resolve-listing.js"), "utf8");

  check("v62.96: the import band accepts free text — resolver wired ahead of the importer",
    lli96.includes("const isUrlish = (v: string)") &&
    lli96.includes("await resolveListing(trimmed)") &&
    lli96.includes("importListing(importInput, projectId)") &&
    lli96.indexOf("await resolveListing(trimmed)") < lli96.indexOf("importListing(importInput, projectId)"));
  check("v62.96: address typeahead is key-gated and degrades to a plain field",
    // v62.111: Radar → Geoapify (Radar gated signup behind a sales call).
    // Same contract survives the swap: configured() gate, 4-char floor, fail-open [].
    lli96.includes("addressLookupConfigured()") &&
    lli96.includes("addressAutocomplete(q)") &&
    api96.includes("VITE_GEOAPIFY_API_KEY") &&
    api96.includes("if (!GEO_KEY || query.trim().length < 4) return [];"));
  check("v62.96: imported agent remarks fill the listing without clobbering typed notes",
    // v62.101 refactor: same fill-if-empty contract, now via the hoisted
    // importedRemarks const (identity fields moved to import-wins alongside).
    lli96.includes("remarks: listingNow.remarks || importedRemarks") &&
    lli96.includes("remarks: facts.remarks ? String(facts.remarks) : \"\"") &&
    api96.includes("remarks?: string | null;"));
  check("v62.96: ListingDetails carries remarks end to end (type + empty default)",
    ty96.includes("remarks: string;") &&
    st96.includes('hook: "",\n  remarks: ""'));
  check("v62.96: voiceover notes textarea writes listing.remarks",
    ps96.includes("Voiceover notes (optional)") &&
    ps96.includes("setListing({ remarks: e.target.value })"));
  check("v62.96: EXIF rescue is suggest-only — reverse geocode, confirm chip, never auto-applied",
    ps96.includes("firstGpsInFiles(accepted)") &&
    ps96.includes("addressReverseGeocode(fix.lat, fix.lng)") &&
    ps96.includes("Use this address") &&
    ps96.includes('!useStore.getState().listing.address.trim()'));
  check("v62.96: the GPS parser walks APP1→GPS IFD, caps its read, and rejects the (0,0) garbage fix",
    ex96.includes("0x8825") &&
    ex96.includes("256 * 1024") &&
    ex96.includes("lat === 0 && lng === 0"));
  check("v62.96: narration hint appears exactly when voice has no context to work with",
    ps96.includes("hasVoiceContext") &&
    ps96.includes("narrationEnabled && !hasVoiceContext") &&
    ps96.includes("can only describe what it sees"));
  check("v62.96: the resolver accepts signed-in users (rate-limited) alongside the worker secret",
    res96.includes("requireUser(request, response)") &&
    res96.includes('bucket: "resolve-listing"'));
}

/* ── v62.97: founder-portal baby CRM — the lead dossier ── */
{
  const fl97 = fs.readFileSync(path.join(ROOT, "api/founder-lead.js"), "utf8");
  const fh97 = fs.readFileSync(path.join(ROOT, "founder.html"), "utf8");
  const mig97 = fs.readFileSync(path.join(ROOT, "supabase/migrations/39_meta_leads_crm.sql"), "utf8");

  check("v62.97: founder-lead sits behind the same METRICS_TOKEN bearer gate as metrics",
    fl97.includes("process.env.METRICS_TOKEN") &&
    fl97.includes("Bearer ${token}") &&
    fl97.includes('response.status(401)'));
  check("v62.97: dossier reads the lead with select=* so pre-migration schemas still answer",
    fl97.includes("meta_leads?select=*&email=eq.") &&
    fl97.includes("order=created_time.desc.nullslast&limit=1"));
  check("v62.97: crm.ready is detected off the row, and provenance + answers come from raw",
    fl97.includes('"contacted_at" in lead') &&
    fl97.includes("raw.field_data") &&
    fl97.includes("raw.adgroup_id || raw.adset_id"));
  check("v62.97: account resolves by lead user_id first, roster scan as the fallback",
    fl97.includes("auth/v1/admin/users/") &&
    fl97.includes("per_page=200"));
  check("v62.97: renders come from the audit log and early deaths from render_jobs, deduped",
    fl97.includes("render_audit_log?select=") &&
    fl97.includes("status=neq.completed") &&
    fl97.includes("!auditIds.has(f.job_id)"));
  check("v62.97: POST marks contact and names migration 39 when the columns are missing",
    fl97.includes('request.body?.contacted === true') &&
    /contacted_at\|contact_note/.test(fl97) &&
    fl97.includes('migration: "39_meta_leads_crm.sql"') &&
    fl97.includes('"no_lead_row"'));
  check("v62.97: migration 39 is additive-only meta_leads columns",
    mig97.includes("add column if not exists contacted_at timestamptz") &&
    mig97.includes("add column if not exists contact_note text") &&
    !/drop\s|delete\s/i.test(mig97));
  check("v62.97: roster rows are clickable and open the dossier by email",
    fh97.includes('class="row clickable" data-i=') &&
    fh97.includes("openLead(u.email)"));
  check("v62.97: the portal can look up any lead by email, roster or not",
    fh97.includes('id="lfind-in"') &&
    fh97.includes("openLead(v)"));
  check("v62.97: the dossier fetches founder-lead with the stored bearer token",
    fh97.includes("'/api/founder-lead?email='+encodeURIComponent(email)") &&
    fh97.includes("Authorization:'Bearer '+token()"));
  check("v62.97: contact tracking saves via POST and surfaces the migration hint",
    fh97.includes("JSON.stringify({email:j.email,contacted:") &&
    fh97.includes("migration_needed") &&
    fh97.includes("39_meta_leads_crm.sql"));
  check("v62.97: the dossier plays renders through the existing player and offers mailto",
    fh97.includes("openPlayer(r.mp4_url, r.title, r.city||j.email)") &&
    fh97.includes('href="mailto:'));

  // v62.97.2 — every lead showed "Direct": PostgREST scalar filters treat
  // double quotes as LITERAL characters (eq."x@y.com" matches nothing;
  // eq."uuid" 400s), so the quoted lookups returned empty for everyone.
  // Verified against a live PostgREST 13. Quoting is only for in.(...)
  // lists. Pin the unquoted style + null-safe ordering.
  const backtickQuote = String.fromCharCode(96) + '"';
  check("v62.97.2: founder-lead uses plain-encoded scalar filters — no quoted eq values anywhere",
    fl97.includes("const emailFilter = encodeURIComponent(email)") &&
    fl97.includes("const idFilter = encodeURIComponent(userId)") &&
    fl97.includes("user_id=eq.${encodeURIComponent(userId)}") &&
    !fl97.includes(backtickQuote));
  check("v62.97.2: lead ordering is nullslast so a null created_time row can't shadow the latest",
    fl97.includes("created_time.desc.nullslast"));
}

/* ── v62.98: pre-scale security hardening (audit fixes) ── */
{
  const mig40 = fs.readFileSync(path.join(ROOT, "supabase/migrations/40_security_hardening.sql"), "utf8");
  const authSrc = fs.readFileSync(path.join(ROOT, "api/_lib/auth.js"), "utf8");
  const guardSrc = fs.readFileSync(path.join(ROOT, "api/_lib/url-guard.js"), "utf8");
  const impSrc = fs.readFileSync(path.join(ROOT, "api/import-listing.js"), "utf8");
  const regSrc = fs.readFileSync(path.join(ROOT, "api/regenerate-scene.js"), "utf8");

  check("v62.98: migration 40 revokes the three anon-callable SECURITY DEFINER RPCs 36 missed",
    /revoke all on function public\.clear_trial_state\(uuid\)\s+from public, anon, authenticated/.test(mig40) &&
    /revoke all on function public\.increment_trial_render\(uuid\)\s+from public, anon, authenticated/.test(mig40) &&
    /revoke all on function public\.get_user_organization\(uuid\)\s+from public, anon, authenticated/.test(mig40));
  check("v62.98: migration 40 leaves is_org_admin alone (it runs inside the org RLS policies)",
    !/revoke[^\n]*is_org_admin/i.test(mig40));
  check("v62.98: migration 40 enables RLS + self-policies on brand_kits (the un-hardened PII table)",
    mig40.includes("alter table public.brand_kits enable row level security") &&
    mig40.includes('create policy "brand_kits_self_select" on public.brand_kits') &&
    mig40.includes("using (auth.uid() = user_id)"));
  check("v62.98: migration 40 makes the audit views security_invoker and revokes anon",
    mig40.includes("security_invoker = on") &&
    mig40.includes("render_scene_breakdown") &&
    mig40.includes("render_engine_summary") &&
    /revoke select on public\.render_scene_breakdown from anon/.test(mig40));
  check("v62.98: migration 40 pins the entitlement columns on profiles self-update",
    mig40.includes('drop policy if exists "profiles_self_update" on public.profiles') &&
    mig40.includes("render_credits         is not distinct from") &&
    mig40.includes("subscription_status    is not distinct from") &&
    mig40.includes("videos_used_this_month is not distinct from"));
  check("v62.98: migration 40 pins credit_balance + subscription_status on users self-update",
    mig40.includes('drop policy if exists "Users can update own profile" on public.users') &&
    mig40.includes("credit_balance      is not distinct from") &&
    mig40.includes("subscription_status is not distinct from"));

  check("v62.98: requireUser fails CLOSED when Supabase is unconfigured unless ALLOW_ANON_FALLBACK",
    authSrc.includes('process.env.ALLOW_ANON_FALLBACK === "true"') &&
    authSrc.includes("response.status(503)") &&
    // the unconditional open-wallet return is gone
    !/if \(!supabaseUrl \|\| !anonKey\) \{\s*return \{ ok: true, userId: null, softPass: true \};/.test(authSrc));

  check("v62.98: the SSRF guard blocks private/link-local/non-web targets, allows named public hosts",
    guardSrc.includes("export function isBlockedFetchTarget") &&
    guardSrc.includes('parsed.protocol !== "https:" && parsed.protocol !== "http:"') &&
    // a bare-IPv4 range check (not a single hardcoded IP) catches loopback/link-local/private in one
    /\{1,3\}\(\?:\\\.\\d\{1,3\}\)\{3\}/.test(guardSrc) &&
    guardSrc.includes('host === "localhost"') &&
    guardSrc.includes('.endsWith(".internal")'));
  check("v62.98: import-listing screens every direct fetch through the SSRF guard",
    impSrc.includes('import { isBlockedFetchTarget } from "./_lib/url-guard.js"') &&
    impSrc.includes("if (isBlockedFetchTarget(photoUrl)) throw new Error") &&
    impSrc.includes("!proxyKey && !isBlockedFetchTarget(url)"));

  check("v62.98: regenerate-scene binds jobId to the caller, blocking only a proven cross-tenant match",
    regSrc.includes("verifyJobOwnership(jobId, tierGuard.userId)") &&
    regSrc.includes("if (!ownership.allow)") &&
    regSrc.includes("render_audit_log?select=agent_user_id&job_id=eq.") &&
    regSrc.includes("if (owner && owner !== userId) return { allow: false }"));
  check("v62.98: job-ownership check fails OPEN on ambiguity so no legit redo is refused",
    regSrc.includes("if (!supabaseUrl || !serviceKey || !userId || !jobId) return { allow: true }") &&
    regSrc.includes("if (!res.ok) return { allow: true }"));
}

/* ── v62.99: voice-demo lockdown — Turnstile + global spend ceiling ── */
{
  const vd = fs.readFileSync(path.join(ROOT, "api/voice-demo.js"), "utf8");
  const ts = fs.readFileSync(path.join(ROOT, "api/_lib/turnstile.js"), "utf8");
  const dc = fs.readFileSync(path.join(ROOT, "api/_lib/daily-counter.js"), "utf8");
  const idx = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  check("v62.99: Turnstile verify fails open ONLY when unconfigured, closed on missing/bad token",
    ts.includes("if (!secret)") &&
    ts.includes("return { ok: true, skipped: true }") &&
    ts.includes('reason: "missing-token"') &&
    ts.includes("challenges.cloudflare.com/turnstile/v0/siteverify") &&
    ts.includes('reason: "verify-unreachable"')); // fail closed on CF outage
  check("v62.99: the daily ceiling uses Upstash when configured, else in-memory, and resets per UTC day",
    dc.includes("UPSTASH_REDIS_REST_URL") &&
    dc.includes('["incr", key]') &&
    dc.includes("getUTCFullYear()") &&
    dc.includes("export async function reserveDaily") &&
    dc.includes("export async function releaseDaily"));
  check("v62.99: the ceiling fails OPEN on a backend blip (backstop, not primary control)",
    dc.includes('return { count: 0, exceeded: false, backend: "upstash-error" }'));

  check("v62.99: voice-demo runs the human check BEFORE any ElevenLabs spend",
    vd.includes('import { verifyTurnstile, clientIp } from "./_lib/turnstile.js"') &&
    // the verify call precedes the first ElevenLabs /voices/add call in source order
    vd.indexOf("verifyTurnstile(body.turnstileToken") < vd.indexOf("/voices/add") &&
    vd.includes("if (!turnstile.ok)") &&
    vd.includes("response.status(403)"));
  check("v62.99: voice-demo reserves the global ceiling before spend and refunds it on our-side failure",
    vd.includes("reserveDaily(DEMO_GLOBAL_KEY, DEMO_GLOBAL_MAX)") &&
    vd.indexOf("reserveDaily(DEMO_GLOBAL_KEY") < vd.indexOf("/voices/add") &&
    vd.includes("if (ceiling.exceeded)") &&
    // every refundRateLimit on a failure path is paired with a releaseDaily
    (vd.match(/releaseDaily\(DEMO_GLOBAL_KEY\)/g) || []).length >= 4);
  check("v62.99: the global ceiling default is finite and env-tunable",
    vd.includes("Number(process.env.VOICE_DEMO_GLOBAL_MAX) || 300"));

  check("v62.99: the landing page loads Turnstile, renders the widget, sends the token, resets after each try",
    idx.includes("challenges.cloudflare.com/turnstile/v0/api.js") &&
    idx.includes('id="vd-turnstile"') &&
    idx.includes("window.turnstile.render('#vd-turnstile'") &&
    idx.includes("turnstileToken: tsToken") &&
    idx.includes("tsReset()"));
}

/* ── v62.100: founder re-render helper + brand-kit on/off switch ── */
{
  const fl = fs.readFileSync(path.join(ROOT, "api/founder-lead.js"), "utf8");
  const fh = fs.readFileSync(path.join(ROOT, "founder.html"), "utf8");
  const st = fs.readFileSync(path.join(ROOT, "webapp/src/lib/store.ts"), "utf8");
  const ps = fs.readFileSync(path.join(ROOT, "webapp/src/screens/ProjectScreen.tsx"), "utf8");

  check("v62.100: founder-lead returns deduped source photos + context for a render",
    fl.includes('request.query?.render_photos') &&
    fl.includes("render_audit_log?select=job_id,listing_address,listing_city,listing_price,project_title,render_config,scenes") &&
    fl.includes("s.photoUrl || s.photo_url") &&
    fl.includes("seen.has(url)"));
  check("v62.100: the photos endpoint needs no email and stays behind METRICS_TOKEN",
    // the render_photos branch sits BEFORE the email-required 400
    fl.indexOf("request.query?.render_photos") < fl.indexOf("A valid email is required") &&
    fl.indexOf("Bearer ${token}") < fl.indexOf("request.query?.render_photos"));
  check("v62.100: the portal exposes a Photos affordance on dossier rows and library cards",
    fh.includes('class="lr-photos"') &&
    fh.includes('class="rc-photos"') &&
    fh.includes("openRenderPhotos("));
  check("v62.100: openRenderPhotos fetches the render's photos with the stored bearer token",
    fh.includes("'/api/founder-lead?render_photos='+encodeURIComponent(jobId)") &&
    fh.includes("Authorization:'Bearer '+token()"));
  check("v62.100: download-all zips client-side via JSZip and the Photos chip stops row playback",
    fh.includes("jszip") &&
    fh.includes("zip.generateAsync") &&
    fh.includes("e.stopPropagation(); openRenderPhotos"));

  check("v62.100: the store carries an explicit includeBranding switch, default on, persisted",
    st.includes("includeBranding: boolean;") &&
    st.includes("includeBranding: true,") &&
    st.includes("persistPrefs({ includeBranding: enabled })") &&
    st.includes('typeof p.includeBranding !== "boolean"'));
  check("v62.100: setIncludeBranding never mutates the saved branding (kit survives toggling off)",
    st.includes("setIncludeBranding: (enabled) => (set({ includeBranding: enabled, editPlan: null })") &&
    // the setter touches includeBranding + editPlan only — no branding write
    !/setIncludeBranding[^\n]*branding:/.test(st));
  check("v62.100: the render portal shows the brand-kit toggle wired to setIncludeBranding",
    ps.includes("setIncludeBranding(!includeBranding)") &&
    ps.includes("Apply my brand kit to this video"));
  check("v62.100: both render call sites honor the switch — off sends an empty kit, not the saved one",
    (ps.match(/brandKit: includeBranding \? branding : \{ fullName: "", brokerage: "", phone: "", email: "" \}/g) || []).length === 2 &&
    !ps.includes("brandKit: branding,"));
}

/* ── v62.101: import corrects the address + announces captured context ── */
{
  const ll = fs.readFileSync(path.join(ROOT, "webapp/src/components/ListingLinkImport.tsx"), "utf8");
  const ps = fs.readFileSync(path.join(ROOT, "webapp/src/screens/ProjectScreen.tsx"), "utf8");

  check("v62.101: import prefers the resolved canonical address/city over the typed search text",
    ll.includes("address: importedAddr || listingNow.address") &&
    ll.includes("city: importedCity || listingNow.city") &&
    // the old keep-typed-address bug is gone
    !ll.includes("address: listingNow.address || addr?.line"));
  check("v62.101: soft facts still fill-if-empty and typed remarks are never clobbered",
    ll.includes("price: listingNow.price || (facts.price") &&
    ll.includes("remarks: listingNow.remarks || importedRemarks"));
  check("v62.101: 'address corrected' ignores punctuation/case but catches real word changes",
    ll.includes("const normAddr = (v: string) =>") &&
    ll.includes("normAddr(importedAddr) !== normAddr(listingNow.address)") &&
    !/\bter\b.*terrace/i.test(ll.split("normAddr = (v: string)")[1].split("\n").slice(0, 3).join(" ")));
  check("v62.101: the completion toast reports the address set and whether remarks landed",
    ll.includes("Address set to") &&
    ll.includes("Listing selling points added to Voiceover notes") &&
    ll.includes("No agent remarks found — add any selling points"));
  check("v62.101: the remarks-added note only fires when the field was empty (no false 'added')",
    ll.includes("const remarksAdded = Boolean(importedRemarks) && !listingNow.remarks.trim()"));
  check("v62.101: the Voiceover-notes placeholder reads as an example, and the hint promises a heads-up",
    ps.includes('placeholder="e.g. New roof 2024') &&
    ps.includes("tells you when it did"));
}

/* ── v62.102: expand the abbreviated street suffix from portal slugs ── */
{
  const imp = fs.readFileSync(path.join(ROOT, "api/import-listing.js"), "utf8");
  check("v62.102: the parser carries a street-suffix expansion map incl. ter→terrace",
    imp.includes("const SUFFIX_EXPAND = {") &&
    imp.includes('ter: "terrace"') &&
    imp.includes('st: "street"') &&
    imp.includes("function expandSuffixToken(tok)"));
  check("v62.102: splitSlugAddress expands the known suffix token before the unit logic",
    imp.includes("if (suffixIdx >= 0) tokens[suffixIdx] = expandSuffixToken(tokens[suffixIdx]);"));
  check("v62.102: redfin + realtor slug branches expand their final suffix word",
    (imp.match(/expandLineSuffix\(/g) || []).length >= 2 &&
    imp.includes("titleCase(expandLineSuffix("));
  check("v62.102: only the known suffix token is expanded — leading 'St' (Saint) is left alone",
    // the expander keys off SUFFIX_EXPAND, never a blanket replace of 'st'
    !imp.includes('.replace(/\\bst\\b/') &&
    imp.includes("SUFFIX_EXPAND[key] || tok"));
}

/* ── v62.103: the SPOKEN address + noun-less room tails ──────────────────
   Two renders on Aug 12 shipped mangled speech: "Welcome to 4320 Flora
   Marteur" (the abbreviated "Ter" fed to ElevenLabs on Troy's Floramar
   make-right) and "N43 45th Road" (Pryor OK — the bare directional jammed
   into the ordinal). Plus Pretoria's noun-less tail "the spacious
   living." on the shipped audio. These fixtures are permanent. */
{
  const reLine = planSrc.slice(planSrc.indexOf("const SPOKEN_FULL_SUFFIX_RE"));
  eval(`globalThis.SPOKEN_FULL_SUFFIX_RE = ${reLine.slice(reLine.indexOf("=") + 1, reLine.indexOf(";")).trim()}`);
  eval(`globalThis.spokenAddressMaps = ${grab(planSrc, "spokenAddressMaps").replace(/^function \w+/, "function")}`);
  eval(`globalThis.speakableAddressLine = ${grab(planSrc, "speakableAddressLine").replace(/^function \w+/, "function")}`);
  eval(`globalThis.repairSpokenAddressText = ${grab(planSrc, "repairSpokenAddressText").replace(/^function \w+/, "function")}`);
  eval(`globalThis.repairNounlessRoomTails = ${grab(planSrc, "repairNounlessRoomTails").replace(/^function \w+/, "function")}`);
  eval(`globalThis.applySpokenTextRepairs = ${grab(planSrc, "applySpokenTextRepairs").replace(/^function \w+/, "function")}`);

  // The two shipped defects, verbatim.
  check("spoken addr: Floramar Ter → Terrace (the make-right blocker)",
    speakableAddressLine("4320 Floramar Ter") === "4320 Floramar Terrace",
    `got "${speakableAddressLine("4320 Floramar Ter")}"`);
  check("spoken addr: N 4345th Rd → North 4345th Road (Pryor jam)",
    speakableAddressLine("1021 N 4345th Rd") === "1021 North 4345th Road",
    `got "${speakableAddressLine("1021 N 4345th Rd")}"`);
  // Ordinals stay digits — captions mirror narration through forced
  // alignment; a spelled ordinal would be 3 caption words for 1 token.
  check("spoken addr: ordinal digits preserved",
    speakableAddressLine("33578 E 160th Ave").includes("160th"));
  check("spoken addr: directional expands with a real street name present",
    speakableAddressLine("2812 N Havenwood Way") === "2812 North Havenwood Way",
    `got "${speakableAddressLine("2812 N Havenwood Way")}"`);
  // Sacramento's "E St": the directional IS the street name — "E" must not
  // become "East" (the suffix still expands; "E Street" is the spoken form).
  check("spoken addr: bare 'E St' keeps its E, expands Street",
    speakableAddressLine("1021 E St") === "1021 E Street",
    `got "${speakableAddressLine("1021 E St")}"`);
  // v62.102's Saint guard, same rule here: only the LAST suffix token.
  check("spoken addr: St James Ct keeps Saint, expands Court",
    speakableAddressLine("12 St James Ct") === "12 St James Court",
    `got "${speakableAddressLine("12 St James Ct")}"`);
  check("spoken addr: unit designator expands (Darlington Apt 101)",
    speakableAddressLine("11907 Darlington Ave Apt 101") === "11907 Darlington Avenue Apartment 101",
    `got "${speakableAddressLine("11907 Darlington Ave Apt 101")}"`);
  check("spoken addr: already-expanded line is untouched",
    speakableAddressLine("4320 Floramar Terrace") === "4320 Floramar Terrace");
  check("spoken addr: city tail after comma passes through",
    speakableAddressLine("4320 Floramar Ter, New Port Richey, FL") === "4320 Floramar Terrace, New Port Richey, FL",
    `got "${speakableAddressLine("4320 Floramar Ter, New Port Richey, FL")}"`);

  check("addr repair: hook sentence normalized",
    repairSpokenAddressText("Welcome to 4320 Floramar Ter.", "4320 Floramar Ter") === "Welcome to 4320 Floramar Terrace.",
    `got "${repairSpokenAddressText("Welcome to 4320 Floramar Ter.", "4320 Floramar Ter")}"`);
  check("addr repair: tag-tolerant inside the monologue span",
    repairSpokenAddressText("Welcome to 4320 [warm] Floramar Ter.", "4320 Floramar Ter") === "Welcome to 4320 Floramar Terrace.");
  check("addr repair: already-expanded text rewrites to itself",
    repairSpokenAddressText("Welcome to 4320 Floramar Terrace.", "4320 Floramar Ter") === "Welcome to 4320 Floramar Terrace.");
  check("addr repair: no-op when the stored line needs nothing",
    repairSpokenAddressText("Welcome to 9803 North 65th Place.", "9803 North 65th Place") === "Welcome to 9803 North 65th Place.");
  check("addr repair: unrelated text untouched",
    repairSpokenAddressText("The kitchen features white cabinetry.", "4320 Floramar Ter") === "The kitchen features white cabinetry.");

  // Pretoria's shipped audio, verbatim.
  check("tail repair: 'the spacious living.' gains its noun",
    repairNounlessRoomTails("Natural light fills the spacious living.") === "Natural light fills the spacious living area.",
    `got "${repairNounlessRoomTails("Natural light fills the spacious living.")}"`);
  check("tail repair: bare 'the dining.' gains its noun",
    repairNounlessRoomTails("Enjoy meals in the dining.") === "Enjoy meals in the dining area.");
  // Lifestyle idioms are complete noun phrases and must survive.
  check("tail repair: 'easy Florida living.' survives (the Floramar close)",
    repairNounlessRoomTails("Peaceful waterfront days and easy Florida living.") === "Peaceful waterfront days and easy Florida living.");
  check("tail repair: 'the easy Florida living.' survives (capitalized guard)",
    repairNounlessRoomTails("Enjoy the easy Florida living.") === "Enjoy the easy Florida living.");
  check("tail repair: no article, no repair ('Enjoy outdoor living.')",
    repairNounlessRoomTails("Enjoy outdoor living.") === "Enjoy outdoor living.");
  check("tail repair: living room named normally is untouched",
    repairNounlessRoomTails("The living room glows at dusk.") === "The living room glows at dusk.");

  // Whole-narration repair keeps sentences ↔ monologue reconstructable.
  const nar = {
    monologue: "Welcome to 4320 [warm] Floramar Ter. Natural light fills the spacious living. Schedule your tour today.",
    direction: "warm",
    source: "director",
    sentences: [
      { text: "Welcome to 4320 Floramar Ter.", photos: ["p1"] },
      { text: "Natural light fills the spacious living.", photos: ["p2"] },
      { text: "Schedule your tour today.", photos: ["p3"] }
    ]
  };
  const res = applySpokenTextRepairs(nar, "4320 Floramar Ter");
  check("narration repair: address + tail both applied",
    res.addressRepaired === 1 && res.tailRepaired === 1,
    `got ${JSON.stringify(res)}`);
  check("narration repair: sentence text normalized",
    nar.sentences[0].text === "Welcome to 4320 Floramar Terrace." &&
    nar.sentences[1].text === "Natural light fills the spacious living area.");
  check("narration repair: monologue matches (alignment-safe)",
    nar.monologue.includes("Floramar Terrace.") && nar.monologue.includes("living area."),
    `got "${nar.monologue}"`);
  const detagNorm = (t) => String(t).replace(/\[[^\][\n]{1,40}\]/g, " ").toLowerCase().replace(/[^a-z0-9']+/gi, " ").replace(/\s+/g, " ").trim();
  check("narration repair: sentences still reconstruct the monologue",
    detagNorm(nar.sentences.map((s) => s.text).join(" ")) === detagNorm(nar.monologue));
  // Pre-diverged narration must be left alone (validate-and-revert).
  const broken = {
    monologue: "A completely different monologue about the home.",
    sentences: [{ text: "Welcome to 4320 Floramar Ter.", photos: ["p1"] }]
  };
  const res2 = applySpokenTextRepairs(broken, "4320 Floramar Ter");
  check("narration repair: reverts when sentences can't reconstruct the monologue",
    res2.addressRepaired === 0 && broken.sentences[0].text === "Welcome to 4320 Floramar Ter.");

  check("prompt lint: the Director is handed the speech-ready address",
    planSrc.includes("THE SPOKEN ADDRESS"));
  check("wiring: attach-time repair reads the intro card headline",
    planSrc.includes("applySpokenTextRepairs(narration, plan?.introCard?.headline"));
  check("wiring: post-rewrite repair runs after smoothing/expansion/trim",
    planSrc.includes("applySpokenTextRepairs(normalizedPlan.narration, addrForSpeech)"));
}

/* ── v62.104: voiceless scene-adjacency clamp (Amy Schrader) ─────────────
   First voiceless lead render: ~six kitchen scenes back-to-back, no
   narration to mask it. The clamp reorders middle scenes on VOICELESS
   plans only — voiced scene order is narration-bound and untouchable. */
{
  eval(`globalThis.interleaveSameRoomScenes = ${grab(planSrc, "interleaveSameRoomScenes").replace(/^function \w+/, "function")}`);
  const mk = (rooms) => rooms.map((r, i) => ({ photoId: `p${i}`, roomType: r, order: i + 1 }));
  const rooms = (arr) => arr.map((s) => s.roomType).join(",");

  // The Amy shape: exterior, 6× kitchen, living, exterior.
  const amy = mk(["exterior", "kitchen", "kitchen", "kitchen", "kitchen", "kitchen", "kitchen", "living", "exterior"]);
  const out = interleaveSameRoomScenes(amy);
  check("interleave: fires on the Amy shape", out.changed === true);
  check("interleave: run shrinks", out.after < out.before, `before ${out.before} after ${out.after}`);
  check("interleave: hero fixed", out.scenes[0].photoId === "p0");
  check("interleave: closer fixed", out.scenes[out.scenes.length - 1].photoId === "p8");
  check("interleave: same multiset of scenes",
    [...out.scenes].map((s) => s.photoId).sort().join(",") === amy.map((s) => s.photoId).sort().join(","));
  // Stability: kitchens keep their relative order.
  const kitchenIds = out.scenes.filter((s) => s.roomType === "kitchen").map((s) => s.photoId).join(",");
  check("interleave: stable within a room class", kitchenIds === "p1,p2,p3,p4,p5,p6", kitchenIds);

  // A healthy alternating tour is untouched.
  const healthy = mk(["exterior", "kitchen", "living", "bedroom", "bathroom", "outdoor"]);
  check("interleave: healthy tour unchanged", interleaveSameRoomScenes(healthy).changed === false);
  // A deliberate wide+detail pair (run of 2) is film grammar — untouched.
  const pair = mk(["exterior", "kitchen", "kitchen", "living", "outdoor"]);
  check("interleave: run of 2 untouched", interleaveSameRoomScenes(pair).changed === false);
  // Degenerate all-same-room gallery: nothing to interleave with.
  const mono = mk(["kitchen", "kitchen", "kitchen", "kitchen"]);
  check("interleave: all-one-room returns unchanged", interleaveSameRoomScenes(mono).changed === false);

  check("wiring: clamp gated to voiceless plans",
    planSrc.includes("context.includeNarration === false && baseScenes.length >= 4"));
}

/* ── v62.105: close-up photos stop becoming scenes (Troy, Aug 12) ────────
   The Catherine render pushed into a stove-wall partial ("nothing to see
   in frame"); vvasu gave a scene to a feature-wall shot. Two layers:
   detail-classified photos are pool-filtered before the Director sees
   them (deterministic, fail-open on scarce galleries), and the SCENE
   DIVERSITY rules gain a NO CLOSE-UPS rule for the tight partials the
   classifier labels as rooms. */
{
  eval(`globalThis.filterDetailPhotoPool = ${grab(planSrc, "filterDetailPhotoPool").replace(/^function \w+/, "function")}`);
  const mk = (n, cat) => ({ id: `p${n}`, category: cat, fileName: `${n}.jpg` });

  // Surplus gallery: details held back, vision list filtered consistently.
  const all = [mk(1, "exterior"), mk(2, "kitchen"), mk(3, "detail"), mk(4, "living"), mk(5, "bedroom"), mk(6, "detail shot"), mk(7, "bathroom"), mk(8, "outdoor"), mk(9, "exterior"), mk(10, "kitchen")];
  const vis = all.slice(0, 6);
  const out = filterDetailPhotoPool(all, vis, 6);
  check("pool filter: detail photos held back on a surplus gallery", out.dropped === 2 && out.allPhotos.length === 8);
  check("pool filter: vision list filtered to the same pool",
    out.visionPhotos.every((p) => !String(p.category).includes("detail")) && out.visionPhotos.length === 4);

  // Scarce gallery: fail-open, details kept (7 non-detail < desired 8 + 1).
  const scarce = filterDetailPhotoPool(all, vis, 8);
  check("pool filter: scarce gallery keeps its detail shots", scarce.dropped === 0 && scarce.allPhotos.length === 10);

  // No categories at all (older projects / some leads): untouched.
  const uncat = filterDetailPhotoPool([mk(1, ""), mk(2, undefined), mk(3, "")], [], 4);
  check("pool filter: uncategorized photos never treated as detail", uncat.dropped === 0 && uncat.allPhotos.length === 3);

  check("prompt lint: NO CLOSE-UPS rule present in scene diversity",
    planSrc.includes("NO CLOSE-UPS OR TIGHT PARTIALS"));
  check("prompt lint: detail scenes no longer legitimized in narration guidance",
    !planSrc.includes("For detail or repeat-room shots") &&
    planSrc.includes("For repeat-room shots, narrate the small thing"));
  check("wiring: pool filter runs before targetSceneCount",
    planSrc.indexOf("filterDetailPhotoPool(allPhotos, visionPhotos, desiredScenes)") !== -1 &&
    planSrc.indexOf("filterDetailPhotoPool(allPhotos, visionPhotos, desiredScenes)") <
    planSrc.indexOf("const targetSceneCount = Math.min(allPhotos.length"));
}

/* ── v62.106: a SINGLE room contradiction rides the repair lane ──────────
   Floramar redo #3 shipped "The primary bedroom is cozy and inviting"
   over the BATHROOM: one contradiction was tolerated by design ("a
   coin-flip on a classifier edge case") and shipped with a warning. The
   deterministic mismatch data had already flagged it — the handler now
   routes count==1 through repairNarrationRooms (with eyes) instead of
   shipping the claim. */
{
  // The Floramar fixture: the mismatch detector MUST flag the shipped
  // sentence over a bathroom-labeled photo. (roomMismatches was extracted
  // by the v62.35 section above.)
  const sents = [
    { text: "Welcome to 4320 Floramar Terrace, a charming two-bedroom, one-bath home.", photos: ["p1"] },
    { text: "The primary bedroom is cozy and inviting, with ample natural light.", photos: ["p2"] },
    { text: "Schedule your private tour today.", photos: ["p5"] }
  ];
  const rooms = new Map([["p1", "exterior"], ["p2", "bathroom"], ["p5", "exterior"]]);
  const hits = roomMismatches(sents, rooms);
  check("v62.106 fixture: bedroom-over-bathroom is a detectable mismatch",
    hits.length === 1 && hits[0].index === 1, JSON.stringify(hits));

  check("wiring: single mismatches enter the repair lane",
    planSrc.includes("const singleRepair = !roomDemoted && nar0") &&
    planSrc.includes("repairNarrationRooms(repairSource, offenders"));
  check("wiring: demoted-path fallback stays demoted-only",
    planSrc.includes("if (!adopted && roomDemoted) {"));
  check("wiring: single-repair failure ships the adopted narration with a warning",
    planSrc.includes("single room contradiction ships as written"));
  check("attach warning no longer claims shipping-as-written for singles",
    !planSrc.includes("may not show — shipping as written") &&
    planSrc.includes("flagged for the single-mismatch repair lane"));
}

/* ── v62.107: QC verdict/notes contradiction guard (1212 Windrose) ───────
   Scene 8 PASSED with every flag false while the notes read "The house
   number on the wall changes from 1312 to 1212". When the notes describe
   a textual element changing, the booleans lose the benefit of the
   doubt. */
{
  const qcSrc = fs.readFileSync(path.join(ROOT, "render-worker/src/veo-qc.mjs"), "utf8");
  eval(`globalThis.qcNotesContradiction = ${grab(qcSrc, "qcNotesContradiction").replace(/^function \w+/, "function")}`);

  check("qc guard: the shipped Windrose note trips it",
    qcNotesContradiction("The house number on the wall changes from 1312 to 1212.") !== null);
  check("qc guard: text-added phrasing trips it",
    qcNotesContradiction("Text appears on the AC unit in frames 3 and 4.") !== null);
  check("qc guard: clean consistency note is safe",
    qcNotesContradiction("The video is consistent with the original photo.") === null);
  check("qc guard: negated note is safe",
    qcNotesContradiction("No text artifacts detected; the house number remains unchanged.") === null);
  check("qc guard: 'appears clearly' is safe",
    qcNotesContradiction("The house number appears clearly throughout the sequence.") === null);
  check("qc guard: mixed note still trips on its bad sentence",
    qcNotesContradiction("The scene is consistent overall. The address digits morph between frames.") !== null);
  check("qc guard: non-textual change is not this guard's business",
    qcNotesContradiction("The tree canopy changes shape slightly between frames.") === null);
  check("qc wiring: guard runs only when every flag was false, reason carries 'text' for the title-card override",
    qcSrc.includes("if (reasons.length === 0) {") &&
    qcSrc.includes("qcNotesContradiction(verdict.notes)") &&
    qcSrc.includes('reasons.push("text artifacts (notes contradict the verdict)")'));
}

/* ── v62.110: founder re-render to the customer's account ────────────────
   The make-right button. The money-path invariants this section pins:
   the comp flag is internal-only, the spend gate bypass exists ONLY under
   comp, the usage bump skips comp renders, and — above all — the v46
   watermark stamp is UNTOUCHED, so a trial customer's re-render ships
   watermarked with the clean master retained and the unlock purchase
   exactly as sellable. */
{
  const fldSrc = fs.readFileSync(path.join(ROOT, "api/founder-lead.js"), "utf8");
  const rndSrc = fs.readFileSync(path.join(ROOT, "api/render.js"), "utf8");

  eval(`globalThis.auditPhotosForPlan = ${grab(fldSrc, "auditPhotosForPlan").replace(/^function \w+/, "function")}`);
  eval(`globalThis.buildReRenderManifest = ${grab(fldSrc, "buildReRenderManifest").replace(/^function \w+/, "function")}`);

  // Audit scenes → plan photos: dedupe by URL, order preserved, roomType
  // rides as category (feeds reconciliation AND the v62.105 pool filter).
  const scenes = [
    { photoUrl: "https://x/storage/a%20b.jpg", roomType: "kitchen" },
    { photoUrl: "https://x/storage/c.jpg", roomType: "exterior" },
    { photoUrl: "https://x/storage/a%20b.jpg", roomType: "kitchen" }, // dwell repeat
    { photo_url: "https://x/storage/d.jpg", room_type: "detail" },
    { photoUrl: "https://x/storage/e.jpg" }
  ];
  const ph = auditPhotosForPlan(scenes);
  check("re-render photos: deduped with order preserved", ph.length === 4 && ph[0].url.endsWith("a%20b.jpg") && ph[3].id === "p4");
  check("re-render photos: roomType becomes category (snake_case too)", ph[0].category === "kitchen" && ph[2].category === "detail");
  check("re-render photos: fileName decoded from the URL", ph[0].fileName === "a b.jpg");
  check("re-render photos: durable/public urls filled for the manifest", ph.every((p) => p.durableUrl === p.url && p.publicUrl === p.url));

  const plan = {
    scenes: [{ photoId: "p1", duration: 4, roomType: "kitchen", overlay: {}, narrationLine: "x" }],
    narration: { monologue: "Welcome.", sentences: [] },
    narrationScript: "Welcome.",
    musicMood: "luxury",
    introCard: { headline: "1 Test St" },
    outroCard: {},
    runwayConfig: {}
  };
  const voiced = buildReRenderManifest({ userId: "u1", jobSeed: "job-abc123", title: "T", listingDetails: { address: "1 Test St", city: "X" }, photos: ph, editPlan: plan, wantNarration: true, selectedStyle: "Cinematic Luxury", targetDurationSec: 30 });
  check("re-render manifest: founderComp rides the manifest", voiced.founderComp === true && voiced.founderReRender === true);
  check("re-render manifest: renders as the CUSTOMER", voiced.project.userId === "u1");
  check("re-render manifest: voiced original stays voiced", voiced.skipNarration === false && voiced.captionsEnabled === true && voiced.narrationScript === "Welcome.");
  const silent = buildReRenderManifest({ userId: "u1", jobSeed: "j", title: "T", listingDetails: {}, photos: ph, editPlan: plan, wantNarration: false, selectedStyle: "Cinematic Luxury", targetDurationSec: 30 });
  check("re-render manifest: music-only original stays music-only", silent.skipNarration === true && silent.narration === null && silent.captionsEnabled === false);
  check("re-render manifest: make-rights ship clean (no brand kit)", voiced.brandKit === null);
  check("re-render manifest: scene photo urls resolve from the photo list", voiced.scenes[0].durableUrl === ph[0].url);
  // v62.18: shape is a customer choice — a square original re-renders square.
  const sq = buildReRenderManifest({ userId: "u1", jobSeed: "j", title: "T", listingDetails: {}, photos: ph, editPlan: plan, wantNarration: true, selectedStyle: "Cinematic Luxury", targetDurationSec: 30, exportFormat: "square" });
  check("re-render manifest: square original stays square", sq.exportFormat === "square" && voiced.exportFormat === "vertical");
  check("re-render: narration probe reads the REAL audit column (narration_applied)",
    fldSrc.includes("row.narration_applied === true"));
  check("re-render: shape follows the audit row's exportFormat",
    fldSrc.includes('rc.exportFormat || "").toLowerCase() === "square"'));

  // render.js money-path invariants.
  check("comp: flag is internal-only (403 without the secret)",
    rndSrc.includes("const founderComp = manifest?.founderComp === true;") &&
    rndSrc.includes('"founderComp requires an internal submission."'));
  check("comp: spend gate bypass exists ONLY under founderComp",
    /if \(!state\.can_render\) \{\s*\n[^]{0,400}if \(founderComp\)/.test(rndSrc));
  check("comp: usage bump skipped for comp renders",
    rndSrc.includes("workerResponse.ok && tierGuard.userId && !tierGuard.comp") &&
    rndSrc.includes("usage bump skipped"));
  check("comp: the v46 watermark stamp is UNTOUCHED by comp",
    rndSrc.includes('String(tierGuard.state?.tier || "") === "trial" &&') &&
    rndSrc.includes("Number(tierGuard.state?.render_credits || 0) < 1") &&
    rndSrc.includes("manifest.freeRenderWatermark = true;") &&
    !/freeRenderWatermark[^\n]*comp|comp[^\n]*freeRenderWatermark/.test(rndSrc));
  check("comp: the 30s free cap is untouched",
    rndSrc.includes("manifest.freeRenderWatermark && Number(manifest.targetDurationSec || 0) > 30"));
  check("comp: guard returns the comp flag to the handler",
    rndSrc.includes("return { ok: true, userId, state, comp: founderComp };"));

  // founder-lead.js lane invariants.
  check("re-render: action wired with on-behalf plan headers",
    fldSrc.includes('String(request.body?.action || "") === "re_render"') &&
    fldSrc.includes('"x-canary-secret": cronSecret') &&
    fldSrc.includes('"x-on-behalf-user": ownerId'));
  check("re-render: template fallback plans are refused (make-right rule)",
    fldSrc.includes('plan.json?.status === "fallback"'));
  check("re-render: submit goes through the front door with the internal secret",
    fldSrc.includes('"x-internal-secret": cronSecret'));
  check("re-render: function window covers the plan build", fldSrc.includes("maxDuration: 300"));

  // founder.html: chips + no blocking dialogs.
  const fhSrc = fs.readFileSync(path.join(ROOT, "founder.html"), "utf8");
  check("re-render UI: chips on dossier rows and library cards",
    fhSrc.includes('class="lr-rerender"') && fhSrc.includes('class="rc-rerender"') &&
    fhSrc.includes("function founderReRender(chip)"));
  check("re-render UI: two-click arm, no blocking confirm()",
    fhSrc.includes("rr-armed") && !/\bwindow\.confirm\(|[^.\w]confirm\(/.test(fhSrc));
}

/* ── v62.112: natural listing-video scene order (Teri Kelly, Aug 13) ─────
   Her cut led the interiors with a bathroom and buried the canal at the
   close ("I would never want to start a video tour with a bathroom shot
   as the first feature"). Voiceless plans re-sort deterministically —
   opener + closer pinned, middle re-ranked outdoor→living→kitchen→bed→
   bath — while voiced plans (narration-bound order) get a hard NATURAL
   TOUR ORDER prompt rule plus loud telemetry on the reconciled labels. */
{
  const rankConst = planSrc.match(/const TOUR_ORDER_RANK = \{[^}]*\};/);
  check("order: rank table present", !!rankConst);
  eval(`globalThis.TOUR_ORDER_RANK = ${rankConst[0].replace("const TOUR_ORDER_RANK = ", "").replace(/;$/, "")}`);
  eval(`globalThis.naturalTourOrder = ${grab(planSrc, "naturalTourOrder").replace(/^function \w+/, "function")}`);
  const mk = (rooms) => rooms.map((r, i) => ({ photoId: `p${i}`, roomType: r, order: i + 1 }));
  const seq = (o) => o.scenes.map((s) => s.roomType).join(",");

  // The Teri shape: exterior, BATHROOM, bedroom, bedroom, outdoor, exterior.
  const teri = mk(["exterior", "bathroom", "bedroom", "bedroom", "outdoor", "exterior"]);
  const out = naturalTourOrder(teri);
  check("order: fires on the Teri shape", out.changed === true);
  check("order: outdoor promoted ahead of the interiors, bathroom demoted last",
    seq(out) === "exterior,outdoor,bedroom,bedroom,bathroom,exterior", seq(out));
  check("order: opener pinned", out.scenes[0].photoId === "p0");
  check("order: closer pinned", out.scenes[out.scenes.length - 1].photoId === "p5");
  check("order: same multiset of scenes",
    [...out.scenes].map((s) => s.photoId).sort().join(",") === teri.map((s) => s.photoId).sort().join(","));

  // Already-natural tour: untouched.
  const natural = mk(["exterior", "outdoor", "living", "kitchen", "bedroom", "bathroom"]);
  check("order: natural tour unchanged", naturalTourOrder(natural).changed === false);
  // Stability within a rank class.
  const twins = mk(["exterior", "bedroom", "bathroom", "bedroom", "exterior"]);
  const tw = naturalTourOrder(twins);
  check("order: stable within a rank (bedrooms keep order)",
    tw.scenes.filter((s) => s.roomType === "bedroom").map((s) => s.photoId).join(",") === "p1,p3");
  // Unknown labels travel mid-tour like bedrooms.
  const unk = mk(["exterior", "bathroom", "mystery", "outdoor"]);
  check("order: unknown room rides mid-tour, bath still demoted",
    seq(naturalTourOrder(unk)) === "exterior,mystery,bathroom,outdoor");
  // Tiny plans untouched (fail-open).
  check("order: three-scene plan untouched", naturalTourOrder(mk(["exterior", "bathroom", "outdoor"])).changed === false);

  // Wiring: voiceless-only, sort BEFORE the v62.104 interleave.
  const gi = planSrc.indexOf("context.includeNarration === false && baseScenes.length >= 4");
  const ni = planSrc.indexOf("naturalTourOrder(baseScenes)");
  const ii = planSrc.indexOf("interleaveSameRoomScenes(baseScenes)");
  check("wiring: sort inside the voiceless guard, ahead of the interleave", gi !== -1 && ni > gi && ii > ni);

  // Prompt: the hard rule for the voiced lane.
  check("prompt: NATURAL TOUR ORDER hard rule present",
    planSrc.includes("(7) NATURAL TOUR ORDER") &&
    planSrc.includes("NEVER the first or second scene") &&
    planSrc.includes("plays within the first three scenes"));
  // Telemetry: measured on the voiced lane.
  check("telemetry: tour-order violations logged loud",
    planSrc.includes("TOUR ORDER violated despite the v62.112 rule") &&
    planSrc.includes("a bathroom leads the interiors") &&
    planSrc.includes("the only outdoor-family scene is the close"));
}

/* ── v62.113: the unlock moment lives with the video (Victor Vasu) ───────
   $1,380/30d bought 279 leads and zero sales. Victor logged in, watched
   two solid renders, downloaded the watermarked master, and left — the
   $39 unlock existed only behind "render another" and Settings→pricing,
   never in the render view. The library detail modal now carries the
   unlock band on the NEWEST still-watermarked render (matching the payg
   webhook's latest-completed unlock semantics); /api/library computes
   the watermarkActive signal server-side; downloads stay free. */
{
  const lds = fs.readFileSync(path.join(ROOT, "api/library.js"), "utf8");
  const lm = fs.readFileSync(path.join(ROOT, "webapp/src/screens/LibraryDetailModal.tsx"), "utf8");
  const ds113 = fs.readFileSync(path.join(ROOT, "webapp/src/screens/DashboardScreen.tsx"), "utf8");
  const ty113 = fs.readFileSync(path.join(ROOT, "webapp/src/lib/types.ts"), "utf8");

  check("unlock: server computes watermarkActive from clean-master + unlocked_at",
    lds.includes("watermarkActive: Boolean(row.master_clean_url && !row.unlocked_at)"));
  check("unlock: served clean master still wins after the unlock (v55 untouched)",
    lds.includes("mp4Url: (row.unlocked_at && row.master_clean_url) ? row.master_clean_url : (row.master_mp4_url || \"\")"));
  check("unlock: type carries both watermark states",
    ty113.includes("watermarkActive?: boolean;") && ty113.includes("watermarkUnlocked?: boolean;"));
  check("unlock: band renders only when eligible and opens the paywall",
    lm.includes("{unlockEligible && (") &&
    lm.includes("Remove watermark — $39") &&
    lm.includes("setUnlockOpen(true)"));
  check("unlock: paywall wired with the instant-unlock reason",
    lm.includes('import PaywallModal from "../components/PaywallModal"') &&
    lm.includes("open={unlockOpen}") &&
    lm.includes("already rendered and unlocks the moment"));
  check("unlock: dashboard gates the band to the newest watermarked render",
    ds113.includes("selectedEntry.jobId === library?.[0]?.jobId") &&
    ds113.includes("selectedEntry.watermarkActive === true"));
  check("unlock: downloads stay ungated (the watermarked file is the ad)",
    lm.includes("the watermarked file is the ad"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
