// Vistalia — listing-import extraction suite (v62.19).
//
// Born from Troy's Scottsdale smoke test: he pasted a Zillow listing that
// advertises 73 photos and the importer produced FIVE. Nothing errored —
// the UI simply showed a five-photo project, which is indistinguishable
// from a listing that really has five photos. That is the failure mode this
// suite exists to prevent: photo extraction degrades silently, and the only
// way to catch a degradation is to assert on counts against a page whose
// true photo count we know.
//
//   node tests/import-extraction.mjs      (exit 1 on any failure)
//
// No API keys, no network. api/import-listing.js pulls in ./_lib helpers
// that assume a Vercel request context, so the module is loaded with those
// imports stubbed — every function under test here is pure.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "api/import-listing.js");

// Load the real module with only its _lib imports removed, so these tests
// exercise shipped code rather than a copy that can drift away from it.
const raw = fs.readFileSync(SRC, "utf8");
const stubbed = raw
  .replace(/^import\s+\{[^}]*\}\s+from\s+"\.\/_lib\/[^"]+";\s*$/gm, "// _lib import stubbed for tests")
  .replace(/^function extractPagePhotos\(/m, "export function extractPagePhotos(");
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vistalia-import-")), "import-listing.mjs");
fs.writeFileSync(tmp, stubbed);
const mod = await import(`file://${tmp}`);
const { extractPagePhotos, expectedPhotoCount, maximizePhotoUrl } = mod;

let pass = 0;
const failures = [];
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  ok: ${label}`); }
  else { failures.push(label); console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`); }
};

const hash = (n) => n.toString(16).padStart(32, "c");
const MAX_PHOTOS = 24; // mirrors the importer's cap

console.log("\n== v62.19 Zillow: the gallery lives behind the hero grid");
// What render=true actually returned for 8725 E Via De Dorado: the hydrated
// DOM carries the five above-the-fold tiles and nothing else. The rest of
// the gallery is loaded on interaction.
const thinRender =
  `<meta name="description" content="Zillow has 73 photos of this $1,130,000 3 beds, 3 baths, 2,097 sqft townhouse home."/>` +
  Array.from({ length: 5 }, (_, i) => `<img src="https://photos.zillowstatic.com/fp/${hash(i)}-cc_ft_768.jpg"/>`).join("");
ok(extractPagePhotos(thinRender).length === 5, "thin hydrated DOM yields 5 photos (the reported symptom)");
ok(expectedPhotoCount(thinRender) === 73,
   "…but the page still advertises 73, so the tier ladder can escalate and the customer can be told");

console.log("\n== v62.19 double-escaped gallery (Zillow's Apollo cache)");
// The preloaded cache is JSON embedded inside a JSON *string*, so its URLs
// arrive double-escaped. One unescape pass left a stray backslash, and the
// URL character class excludes backslashes — so every photo in the richest
// blob on the page was silently unmatched.
const doubleEscaped = Array.from({ length: 30 }, (_, i) =>
  `{\\"url\\":\\"https:\\\\/\\\\/photos.zillowstatic.com\\\\/fp\\\\/${hash(i)}-cc_ft_1152.jpg\\"}`).join(",");
const fromBlob = extractPagePhotos(doubleEscaped);
ok(fromBlob.length === MAX_PHOTOS, "double-escaped gallery yields a full set", `got ${fromBlob.length}`);
ok(fromBlob.every((p) => /^https:\/\/photos\.zillowstatic\.com\/fp\/[a-f0-9]+-cc_ft_1536\.jpg$/.test(p.url)),
   "double-escaped URLs come out clean and upgraded to the 1536 tier");
const singleEscaped = Array.from({ length: 30 }, (_, i) =>
  `{"url":"https:\\/\\/photos.zillowstatic.com\\/fp\\/${hash(i)}-cc_ft_1152.jpg"}`).join(",");
ok(extractPagePhotos(singleEscaped).length === MAX_PHOTOS, "single-escaped gallery still works (no regression)");

console.log("\n== v62.19 realtor.com spreads one gallery over several rdcpix hosts");
// Pinning the discovery regex to ap.rdcpix.com dropped whatever share of
// the set landed on a sibling host — while maximizePhotoUrl() already
// matched every subdomain, so discovery and rewriting disagreed.
const acrossSubdomains = ["ap", "ar", "ai", "p"].flatMap((sub, s) =>
  Array.from({ length: 5 }, (_, i) =>
    `<img src="https://${sub}.rdcpix.com/${hash(s * 5 + i)}l-m${1000 + s * 5 + i}xd-w1024_h768.webp"/>`)).join("");
const rdc = extractPagePhotos(acrossSubdomains);
ok(rdc.length === 20, "all 20 realtor.com photos found across ap/ar/ai/p", `got ${rdc.length}`);
ok(rdc.every((p) => /w=2048/.test(p.url)), "every rdcpix URL upgraded to w=2048");

console.log("\n== dedupe still holds (v62.4 — \"it imports the same photo several times\")");
// Zillow embeds each photo at eight widths in both jpeg and webp.
const widths = [576, 768, 960, 1152, 1344, 1536];
const manyVariants = Array.from({ length: 10 }, (_, i) =>
  widths.flatMap((w) => [
    `<img src="https://photos.zillowstatic.com/fp/${hash(i)}-cc_ft_${w}.jpg"/>`,
    `<img src="https://photos.zillowstatic.com/fp/${hash(i)}-cc_ft_${w}.webp"/>`
  ]).join("")).join("");
ok(extractPagePhotos(manyVariants).length === 10,
   "10 photos x 12 variants dedupe to 10", `got ${extractPagePhotos(manyVariants).length}`);

console.log("\n== non-photos stay out (v58.3 logo scene, v62.5 floor plans)");
const junk =
  `<img src="https://photos.zillowstatic.com/static/logo-header.png"/>` +
  `<img src="https://maps.zillowstatic.com/tile/1/2/3.png"/>` +
  `<img src="https://ssl.cdn-redfin.com/vLATEST/images/redfin-logo.png"/>` +
  `<img src="https://photos.zillowstatic.com/fp/${hash(77)}-floor-plan-cc_ft_1536.jpg"/>` +
  `<img src="https://photos.zillowstatic.com/fp/${hash(78)}-cc_ft_1536.jpg"/>`;
const cleaned = extractPagePhotos(junk);
ok(cleaned.length === 1, "only the real photo survives", `got ${cleaned.length}: ${cleaned.map((p) => p.url).join(", ")}`);
ok(/fp\/[a-f0-9]+-cc_ft_1536\.jpg$/.test(cleaned[0]?.url || ""), "and it is the listing photo, not chrome");

console.log("\n== expectedPhotoCount is the honesty signal — it must not guess");
ok(expectedPhotoCount('{"photoCount":41}') === 41, "reads photoCount JSON");
ok(expectedPhotoCount("<span>24 Photos</span>") === 24, "reads a visible photo-count label");
ok(expectedPhotoCount("<p>has 1 photo</p>") === 0, "ignores a 1-photo claim (below the sane floor)");
ok(expectedPhotoCount('{"photoCount":9999}') === 0, "rejects an absurd count");
ok(expectedPhotoCount("<p>a page that never says</p>") === 0, "returns 0 rather than inventing an expectation");

console.log("\n== max-res rewrite identity (v62.3/v62.4)");
const z = maximizePhotoUrl(`https://photos.zillowstatic.com/fp/${hash(1)}-cc_ft_384.jpg`);
const zWebp = maximizePhotoUrl(`https://photos.zillowstatic.com/fp/${hash(1)}-cc_ft_1152.webp`);
ok(z.key === zWebp.key, "same Zillow photo at different tiers/formats shares one identity key");
ok(/cc_ft_1536/.test(z.best), "Zillow rewrite targets the 1536 tier");
const rf = maximizePhotoUrl("https://ssl.cdn-redfin.com/photo/1/mbphoto/123/genMid.ABC_1.jpg");
ok(/\/bigphoto\//.test(rf.best) && !/genMid/.test(rf.best), "Redfin rewrite targets the full-size original");

fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? "ALL PASS" : `FAILURES (${failures.length}):\n  - ${failures.join("\n  - ")}`}  [${pass} passed]`);
process.exit(failures.length === 0 ? 0 : 1);
