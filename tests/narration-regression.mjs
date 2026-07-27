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
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
