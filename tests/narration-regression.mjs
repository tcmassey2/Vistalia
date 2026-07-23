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

/* ── Amy-class lint: lead emails must never claim fake deadlines ── */
const tplSrc = fs.readFileSync(path.join(ROOT, "api/_lib/email-templates.js"), "utf8");
const freeVideoBlock = tplSrc.slice(tplSrc.indexOf("freeVideoWaiting"), tplSrc.indexOf("paymentFailed"));
check("ladder emails: no trial language", !/free trial|trial (ends|wraps|expired)/i.test(freeVideoBlock));
check("ladder emails: no fake lockout", !/stops responding|locked|expire/i.test(freeVideoBlock));
check("ladder emails: opt-out link present", freeVideoBlock.includes("optOutUrl"));

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
