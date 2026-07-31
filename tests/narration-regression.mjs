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
  check("v62.41: gentle maps to the steady Kling suffix (constrained without strict)",
    /strictConstrained \? "strict" : constrained \? "steady" : "bold"/.test(rjSrc));

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
    /await repairNarrationRooms\(parsed\.narration, offenders/.test(planSrc));
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

  /* ── v62.79: the watermark swings back. v62.54 built a wall (breathing
     centre FREE PREVIEW + two crop-defeating echoes + upgrade banner);
     Troy killed it — "that is too much" — because the wall buried the
     footage that sells the upgrade. One quiet serif mark now, in the
     title card's voice. These tests are inverted on purpose: they guard
     the ABSENCE of the wall, which is the thing a future "make the trial
     convert harder" instinct would silently reintroduce. */
  check("v62.79: the free-render wall is gone (no centre mark, echoes, banner)",
    !/FREE PREVIEW/.test(rjSrc2.replace(/\/\/[^\n]*/g, "")) &&
    !/text='VISTALIA'/.test(rjSrc2) &&
    !/upgrade at vistalia\.ai to remove/.test(rjSrc2));
  check("v62.79: exactly one drawtext survives in the free-render mark",
    (() => {
      const fn = rjSrc2.match(/export function buildFreeRenderWatermark[\s\S]*?\n}/);
      return !!fn && (fn[0].match(/drawtext=/g) || []).length === 1;
    })());
  check("v62.79: the mark is the title card's serif, shadowed, unboxed",
    /VistaliaSerif-SemiBold\.ttf/.test(rjSrc2) &&
    (() => {
      const fn = rjSrc2.match(/export function buildFreeRenderWatermark[\s\S]*?\n}/)[0];
      return /shadowcolor=black@0\.55/.test(fn) && !/box=1/.test(fn);
    })());
  check("v62.79: the vistalia.ai mark keeps its launch position",
    /text='vistalia\.ai'/.test(rjSrc2) && /x=36:y=40/.test(rjSrc2));
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
  check("v62.80: lead manifest carries plan narration (voice-first spine)",
    /narration: editPlan\.narration \|\| null/.test(leadSrc));
  check("v62.80: the legacy narration fields ride alongside, not instead",
    /narrationScript: editPlan\.narrationScript \|\| ""/.test(leadSrc) &&
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

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
