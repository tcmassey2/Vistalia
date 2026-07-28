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
const { extractPagePhotos, expectedPhotoCount, maximizePhotoUrl, factsFromHtml, samePropertyAddress, extractAddressFromHtml } = mod;

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

console.log("\n== v62.23 THE 5-PHOTO BUG: Zillow ships four variant families");
// Reproduces the live page's exact shape. Each gallery photo appears at a
// FIXED thumbnail (p_d/p_c) BEFORE it appears at a resizable gallery tier —
// and dedupe is first-seen-wins, so the thumbnail URL used to win.
const galleryPhoto = (n) => {
  const h = hash(n);
  return `<img src="https://photos.zillowstatic.com/fp/${h}-p_d.jpg"/>` +      // thumb first
         `{"url":"https://photos.zillowstatic.com/fp/${h}-cc_ft_1536.jpg"}` +   // gallery tier
         `{"url":"https://photos.zillowstatic.com/fp/${h}-uncropped_scaled_within_1536_1152.webp"}`;
};
// Related-home carousel + chrome: fixed thumbs only, never a gallery tier.
const carouselOnly = (n) => `<img src="https://photos.zillowstatic.com/fp/${hash(900 + n)}-p_c.jpg"/>`;
const zPage = Array.from({ length: 12 }, (_, i) => galleryPhoto(i)).join("") +
              Array.from({ length: 6 }, (_, i) => carouselOnly(i)).join("") +
              `<img src="https://photos.zillowstatic.com/fp/${hash(777)}-zillow_web_95_35.jpg"/>`;
const zOut = extractPagePhotos(zPage);
ok(zOut.length === 12, "all 12 gallery photos survive (thumb-first ordering no longer wins)", `got ${zOut.length}`);
ok(zOut.every((p) => /-cc_ft_1536\.(jpe?g|webp)$/.test(p.url)),
   "every one is rewritten to the full-size tier", JSON.stringify(zOut.slice(0, 2)));
ok(!zOut.some((p) => /-p_[cd]\./.test(p.url)), "no fixed thumbnail URL survives");
ok(zOut.length === 12, "the 6 related-home carousel thumbs are excluded (no gallery tier)");

// The regression itself: the OLD rewrite only touched cc_ft/scaled_within, so
// a p_d-first photo kept a 316x234 URL and the low-res gate dropped it.
const oldRewrite = (u) => u.replace(/-cc_ft_\d+/g, "-cc_ft_1536").replace(/scaled_within_\d+_\d+/g, "scaled_within_1536_1152");
ok(oldRewrite(`https://photos.zillowstatic.com/fp/${hash(1)}-p_d.jpg`).includes("-p_d.jpg"),
   "old rewrite provably left p_d thumbnails untouched — the shipped defect");
ok(maximizePhotoUrl(`https://photos.zillowstatic.com/fp/${hash(1)}-p_d.jpg`).best.includes("-cc_ft_1536.jpg"),
   "new rewrite upgrades p_d to the full-size tier");
// Identity must still collapse every variant of one photo to a single entry.
const variants = ["p_c", "p_d", "d_d", "o_a", "cc_ft_384", "uncropped_scaled_within_1536_1152"]
  .map((v) => maximizePhotoUrl(`https://photos.zillowstatic.com/fp/${hash(5)}-${v}.jpg`).key);
ok(new Set(variants).size === 1, "all six variant families share one identity key", JSON.stringify(variants.slice(0,2)));

/* v62.37 (audit): the fail-open was REVERSED. Keeping every /fp/ URL on a
   page with no verifiable gallery meant the related-homes carousel — whose
   photos only ever appear as p_c/p_d fixed thumbs — rode in, and the
   unconditional cc_ft_1536 rewrite upgraded them past the low-res gate:
   other people's houses in the customer's tour, at full resolution, the
   day Zillow renames one markup token. New contract: when gallery
   membership can't be verified, keep only URLs the page itself embedded
   at a resizable GALLERY tier. */
const reducedThumbsOnly = Array.from({ length: 4 }, (_, i) => `<img src="https://photos.zillowstatic.com/fp/${hash(i)}-p_d.jpg"/>`).join("");
ok(extractPagePhotos(reducedThumbsOnly).length === 0,
   "no gallery tiers anywhere → fixed thumbs (the carousel signature) do NOT ride the fail-open");
const reducedMixed = [
  ...Array.from({ length: 3 }, (_, i) => `<img src="https://photos.zillowstatic.com/fp/${hash(i)}-cc_ft_384.jpg"/>`),
  ...Array.from({ length: 5 }, (_, i) => `<img src="https://photos.zillowstatic.com/fp/${hash(40 + i)}-p_c.jpg"/>`)
].join("");
const reducedOut = extractPagePhotos(reducedMixed);
ok(reducedOut.length === 3,
   "fail-open keeps gallery-tier URLs (thin import beats empty), drops thumb-only ones", `got ${reducedOut.length}`);
ok(reducedOut.every((p) => /-cc_ft_1536\./.test(p.url)),
   "the survivors are still upgraded to full size");

console.log("\n== v62.21 listing facts come off the page, so RentCast is optional");
// Verbatim meta description from the live Scottsdale page.
const realMeta = `<meta name="description" content="Zillow has 73 photos of this $1,130,000 3 beds, 3 baths, 2,097 sqft townhouse home located at 8725 E VIA DE DORADO --, Scottsdale, AZ 85258 "/>`;
const f = factsFromHtml(realMeta) || {};
ok(f.price === 1130000, "price parsed from the real page", JSON.stringify(f));
ok(f.beds === 3, "beds parsed", JSON.stringify(f));
ok(f.baths === 3, "baths parsed", JSON.stringify(f));
ok(f.sqft === 2097, "sqft parsed", JSON.stringify(f));
// These four are exactly what DashboardScreen maps into the listing.
ok(["price", "beds", "baths", "sqft"].every((k) => f[k] != null),
   "all four fields the webapp consumes are present without RentCast");

// Redfin/Realtor phrasing ("3 beds, 2.5 baths, 1,890 Sq. Ft.")
const alt = factsFromHtml(`<meta name="description" content="4 beds, 2.5 baths, 1,890 Sq. Ft. house for sale at $649,900."/>`) || {};
ok(alt.beds === 4 && alt.baths === 2.5 && alt.sqft === 1890 && alt.price === 649900,
   "alternate portal phrasing parses too", JSON.stringify(alt));

// Rails: a garbage parse must never overwrite good records data.
ok(factsFromHtml('<meta name="description" content="99 beds, 200 baths, 12 sqft for $5"/>') === null,
   "absurd values are rejected wholesale rather than shipped");
ok(factsFromHtml("<p>a page with no facts at all</p>") === null, "returns null when the page says nothing");

console.log("\n== v62.58 cross-portal rescue identity guard — the wrong house must be impossible");
const addr = (line) => ({ line, city: "Scottsdale", state: "AZ" });
ok(samePropertyAddress(addr("8501 E Malcomb Dr"), addr("8501 E Malcomb Drive")),
   "same number + name token across suffix spellings matches");
ok(samePropertyAddress(addr("8725 E Via Del Arbor --"), addr("8725 E Vía Del Arbor")) === false ||
   samePropertyAddress(addr("8725 E Via Del Arbor --"), addr("8725 E Via Del Arbor")),
   "accented variants either match on a shared token or fail closed — never crash");
ok(!samePropertyAddress(addr("8501 E Malcomb Dr"), addr("8502 E Malcomb Dr")),
   "street number mismatch fails");
ok(!samePropertyAddress(addr("8501 E Malcomb Dr"), addr("8501 E Sweetwater Ave")),
   "same number, different street fails");
ok(!samePropertyAddress(addr("8501 E Malcomb Dr"), null),
   "null page address (search-results page) fails closed");
ok(!samePropertyAddress(addr("101 1st St"), addr("101 1st St")),
   "short-name streets fail CLOSED — skipping a rescue beats risking the wrong house");
// The search-page detector: no leading street number in og:title → null.
ok(extractAddressFromHtml('<meta property="og:title" content="Scottsdale AZ Real Estate - 1224 Homes For Sale | Zillow"/>') === null,
   "a search-results page parses to null, so the rescue can never harvest it");

fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? "ALL PASS" : `FAILURES (${failures.length}):\n  - ${failures.join("\n  - ")}`}  [${pass} passed]`);
process.exit(failures.length === 0 ? 0 : 1);
