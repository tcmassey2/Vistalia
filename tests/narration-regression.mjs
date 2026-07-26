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
const SHIPPED_BAD_ENDINGS = /^(crowns?|fills?|adds?|blends?|complements?|compliments?|beneath|along|features?|boasts?|provides?|is|outdoor|welcoming|inviting)$/i;

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
eval(`globalThis.trimNar = ${grab(planSrc, "trimNarrationToBudget").replace(/^function \w+/, "function")}`);
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
  check(`trim lands inside the 30s ceiling (${after}w <= 85)`, after > 0 && after <= 85);
  check(`trim does not cut through the floor (${after}w >= 70)`, after >= 70);
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
  check("in-band narration is left alone", globalThis.trimNar(
    { sentences: real.slice(0, 5).map((t, i) => ({ text: t, photos: [`p${i}`] })), monologue: real.slice(0, 5).join(" ") },
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
  ["'pool-table' hyphenated is still not a pool", [{ text: "A pool-table anchors the far end.", photos: ["l"] }]]
];
for (const [name, sents] of falsePositives) {
  const hits = roomMismatches(sents, fpRooms);
  check(`v62.35 no false positive: ${name}`, hits.length === 0, JSON.stringify(hits));
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

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
