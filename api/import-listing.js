// Vistalia — Listing URL import (v52).
//
// POST /api/import-listing   { url, projectId }
//
// Paste a Zillow / Redfin / Realtor.com listing link → Vistalia prefills the
// project: address parsed FROM THE URL SLUG (no scraping needed for facts),
// property facts via RentCast (licensed API, already integrated), and —
// best-effort — the listing photos, downloaded server-side into the user's
// own listing-photos storage so the project starts photo-ready.
//
// WHY THIS SHAPE (v52 design notes):
//   - The activation killer is phones: leads arrive from Instagram on a
//     phone, listing photos live on desktops. A pasted link is the one
//     asset every agent has on their phone.
//   - The address lives in the URL slug on every major portal. Parsing it
//     is deterministic, instant, and involves no page fetch at all.
//   - Photos are GRAVY, not the contract: portals aggressively block
//     datacenter fetches. Every failure path still returns the address +
//     facts so the project lands prefilled and the user just adds photos.
//   - Downloads happen server-side (browser CORS would block them) into
//     the same {userId}/projects/{projectId}/ path the normal uploader
//     uses, so downstream (render, regen, QC) sees no difference.

import { createHash } from "node:crypto";
import { requireUser } from "./_lib/auth.js";
import { rateLimit } from "./_lib/rate-limit.js";

const RENTCAST_BASE = "https://api.rentcast.io/v1";
const MAX_PHOTOS = 24;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 9000;
// v58: ScraperAPI with render=true routinely takes 15-40s on bot-walled
// portals — give it room. The Vercel function budget absorbs it; the
// worker's auto-render pass calls this endpoint with a 60s client timeout.
// v62.59 (three "timed out" toasts in one evening, both portals): 45s was
// US hanging up early. ScraperAPI holds the connection and keeps rotating
// IPs/retrying upstream for the life of the request — their own docs
// recommend ~70s client timeouts. A 45s cap abandons requests their side
// may still be solving; the per-tier caps in the ladder decide how much of
// this any single attempt may actually spend.
const PROXY_PAGE_TIMEOUT_MS = 70000;
const PHOTO_TIMEOUT_MS = 10000;
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

// Vercel Pro: allow time for photo downloads. Everything is parallel and
// byte-capped; typical imports finish well under 30s.
// v62.58: 60 → 120 (the plan endpoint already runs at 120 on this account).
// Realtor.com's Kasada wall outlasted a 40s page phase even on
// ultra_premium — the first two v62.56-era toasts proved it live. The
// bigger ceiling buys a real page phase (75s) AND the cross-portal rescue,
// with ~40s left for photo downloads + storage.
export const config = { maxDuration: 120 };

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/* ============================================================
   1. Address from the URL slug — no fetch required
   ============================================================ */

const STREET_SUFFIXES =
  /^(rd|road|st|street|dr|drive|ln|lane|ct|court|ave|avenue|way|blvd|boulevard|cir|circle|pl|place|ter|terrace|trl|trail|loop|pkwy|parkway|hwy|highway|sq|square|cv|cove|pt|point|bnd|bend|xing|crossing|run|walk|path|pass|row|aly|alley)$/i;
const STATE_RE = /^[A-Za-z]{2}$/;
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Split a dash-separated slug like
//   "28412-N-Summit-Springs-Rd-Rio-Verde-AZ-85263"
// into { line, city, state, zip, display }. City boundary is found by
// scanning for the LAST street-suffix token before the state token —
// fail-open to the whole line when the split is ambiguous.
function splitSlugAddress(slug) {
  const tokens = String(slug || "")
    .split(/[-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length < 3) return null;
  // Portals append numeric property IDs (trulia: "…-az-85266--2148632310").
  // Strip trailing pure-digit tokens too long to be a zip before splitting.
  while (tokens.length && /^\d{6,}$/.test(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length < 3) return null;
  let zip = "";
  if (ZIP_RE.test(tokens[tokens.length - 1])) zip = tokens.pop();
  let state = "";
  if (tokens.length && STATE_RE.test(tokens[tokens.length - 1])) state = tokens.pop().toUpperCase();
  if (!tokens.length) return null;
  // Find last street-suffix token — street is [0..i], city is (i..end).
  let suffixIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (STREET_SUFFIXES.test(tokens[i])) suffixIdx = i;
  }
  // Unit designators after the suffix belong to the street line, not the
  // city: "…-Rd-UNIT-34-Scottsdale-…" → line "… Rd Unit 34", city "Scottsdale".
  if (suffixIdx >= 0 && suffixIdx < tokens.length - 1) {
    const UNIT_RE = /^(unit|apt|apartment|ste|suite|lot|no|num)$/i;
    if (UNIT_RE.test(tokens[suffixIdx + 1])) {
      suffixIdx += 1;
      while (suffixIdx < tokens.length - 1 && /^[A-Za-z]?\d+[A-Za-z]?$/.test(tokens[suffixIdx + 1])) {
        suffixIdx += 1;
      }
    }
  }
  let line, city;
  if (suffixIdx >= 0 && suffixIdx < tokens.length - 1) {
    line = titleCase(tokens.slice(0, suffixIdx + 1).join(" "));
    city = titleCase(tokens.slice(suffixIdx + 1).join(" "));
  } else {
    line = titleCase(tokens.join(" "));
    city = "";
  }
  const display = [line, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const query = [line, city, state, zip].filter(Boolean).join(" ");
  return { line, city, state, zip, display, query };
}

export function parseAddressFromUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname;

  // realtor.com/realestateandhomes-detail/Street_City_ST_Zip_M12345-67890
  if (host.endsWith("realtor.com")) {
    const m = path.match(/realestateandhomes-detail\/([^/]+)/);
    if (m) {
      const parts = m[1].split("_");
      if (parts.length >= 4) {
        const line = titleCase(parts[0].replace(/-/g, " "));
        const city = titleCase(parts[1].replace(/-/g, " "));
        const state = parts[2].toUpperCase();
        const zip = (parts[3].match(/\d{5}/) || [""])[0];
        return {
          line, city, state, zip,
          display: [line, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
          query: [line, city, state, zip].filter(Boolean).join(" ")
        };
      }
    }
  }

  // redfin.com/ST/City/Street-Zip/home/12345
  if (host.endsWith("redfin.com")) {
    const m = path.match(/^\/([A-Za-z]{2})\/([^/]+)\/([^/]+)\/home\//);
    if (m) {
      const state = m[1].toUpperCase();
      const city = titleCase(m[2].replace(/-/g, " "));
      const streetSlug = m[3];
      const zip = (streetSlug.match(/(\d{5})$/) || [])[1] || "";
      const line = titleCase(streetSlug.replace(/-?\d{5}$/, "").replace(/-/g, " "));
      return {
        line, city, state, zip,
        display: [line, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
        query: [line, city, state, zip].filter(Boolean).join(" ")
      };
    }
  }

  // zillow.com/homedetails/Street-City-ST-Zip/123_zpid/  (also homes.com,
  // trulia.com and most other portals use one dash-slug segment)
  const segs = path.split("/").filter(Boolean);
  for (const seg of segs) {
    if (/\d{5}/.test(seg) && /[A-Za-z]/.test(seg) && seg.includes("-")) {
      const parsed = splitSlugAddress(seg);
      if (parsed && /\d/.test(parsed.line)) return parsed;
    }
  }
  return null;
}

/* ============================================================
   2. RentCast — facts (and, when the plan returns them, photos)
   ============================================================ */

async function rentcastFacts(query) {
  if (!process.env.RENTCAST_API_KEY) return { facts: null, photos: [] };
  const headers = { "X-Api-Key": process.env.RENTCAST_API_KEY, Accept: "application/json" };
  const out = { facts: null, photos: [] };
  try {
    const r = await fetchWithTimeout(
      `${RENTCAST_BASE}/properties?${new URLSearchParams({ address: query })}`,
      { headers },
      12000
    );
    if (r.ok) {
      const payload = await r.json().catch(() => null);
      const rec = Array.isArray(payload) ? payload[0] : payload;
      if (rec && typeof rec === "object") {
        out.facts = {
          beds: rec.bedrooms ?? null,
          baths: rec.bathrooms ?? null,
          sqft: rec.squareFootage ?? null,
          yearBuilt: rec.yearBuilt ?? null,
          lotSize: rec.lotSize ?? null,
          propertyType: rec.propertyType ?? null
        };
      }
    }
  } catch { /* facts are optional */ }
  try {
    // Active sale listing — price, and on some plans a photos array
    // (licensed media, the cleanest possible photo source when present).
    const r = await fetchWithTimeout(
      `${RENTCAST_BASE}/listings/sale?${new URLSearchParams({ address: query })}`,
      { headers },
      12000
    );
    if (r.ok) {
      const payload = await r.json().catch(() => null);
      const rec = Array.isArray(payload) ? payload[0] : payload;
      if (rec && typeof rec === "object") {
        if (rec.price && out.facts) out.facts.price = rec.price;
        else if (rec.price) out.facts = { price: rec.price };
        if (Array.isArray(rec.photos)) {
          out.photos = rec.photos.filter((p) => typeof p === "string" && /^https?:\/\//.test(p));
        }
      }
    }
  } catch { /* listing lookup optional */ }
  return out;
}

/* ============================================================
   3. Page photos — best-effort, expected to fail on some portals
   ============================================================ */

/* v62.19: subdomain-agnostic for the three CDNs that use more than one photo
   host. Realtor.com is the live case — it serves a single gallery across
   ap./ar./ai./p.rdcpix.com, and pinning `ap.` silently dropped whichever
   share of the set landed on a sibling host. maximizePhotoUrl() already
   matched /rdcpix\.com/i for ALL subdomains, so discovery and rewriting
   disagreed about what counted as a photo. The path guards below
   (zillowstatic needs /fp/, cdn-redfin needs /photo/) are what keep site
   chrome out, not the subdomain — so widening costs no safety. homes.com
   and trulia stay pinned to their known image hosts: those domains serve
   the marketing site from the same registrable domain. */
const PHOTO_CDN_RE =
  /https:\/\/(?:(?:[a-z0-9-]+\.)*(?:zillowstatic\.com|cdn-redfin\.com|rdcpix\.com)|images\.homes\.com|photos\.trulia\.com)\/[^\s"'\\)]+?\.(?:jpe?g|webp|png)/gi;

// A gallery this size is treated as complete when the page doesn't state a
// count. Below it, the tier ladder keeps escalating: a real listing with
// only 7 photos costs one extra proxy call, while a 73-photo listing that
// exposed 5 gets another chance instead of shipping a 5-photo tour.
const GALLERY_LOOKS_COMPLETE = 12;

/* v62.19: what the page CLAIMS to hold. Zillow states it in the meta
   description ("Zillow has 73 photos of this $1,130,000 3 beds..."), which
   survives even on a thin above-the-fold render — so it is a reliable
   expectation to measure our extraction against, and the honest number to
   show the customer when we come up short. */
/* v62.23: which Zillow photo hashes belong to THIS listing's gallery.
   Upgrading every variant to full size (see maximizePhotoUrl) removes the
   accidental protection the old code had: related-home carousels and site
   chrome also live on /fp/, and they used to arrive as unusable thumbnails
   that the low-res gate quietly discarded. Now they would arrive full-size
   and indistinguishable — other people's houses in the customer's tour, the
   angry-customer class.
   The discriminator is exact, not heuristic: a photo of THIS listing is
   served at a resizable gallery tier (cc_ft_* or uncropped_scaled_within_*)
   somewhere in the document; carousel thumbs and chrome only ever appear at
   fixed sizes. Measured on the live page: 85 hashes total, 73 with a gallery
   tier — and the page advertises exactly 73 photos. */
export function zillowGalleryHashes(html) {
  const set = new Set();
  const re = /\/fp\/([a-f0-9]{12,})-(?:cc_ft_\d+|uncropped_scaled_within_\d+_\d+)\.(?:jpe?g|webp|png)/gi;
  for (const m of String(html).matchAll(re)) set.add(m[1].toLowerCase());
  return set;
}

export function expectedPhotoCount(html) {
  const text = String(html);
  const sane = (n) => (Number.isFinite(n) && n >= 2 && n <= 300 ? n : 0);
  const meta = text.match(/\bhas\s+(\d{1,3})\s+photos?\b/i);
  if (meta && sane(Number(meta[1]))) return Number(meta[1]);
  const json = text.match(/"photo(?:Count|s_?count)"\s*:\s*(\d{1,3})\b/i);
  if (json && sane(Number(json[1]))) return Number(json[1]);
  const label = text.match(/>\s*(\d{1,3})\s+photos?\b/i);
  if (label && sane(Number(label[1]))) return Number(label[1]);
  return 0;
}

/* v62.3 MAX-RES PHOTO UPGRADE — the render is only as sharp as its inputs,
   and on the Kling v3 pro (1080p-class) tier the imported photo is the
   quality ceiling of the whole master. Portal pages embed MID-TIER gallery
   URLs (Zillow cc_ft_576-1152, Redfin genMid ≈733px, rdcpix ?w=480-1024);
   the full-size variant is one deterministic URL rewrite away on every
   major CDN. Each rewrite returns:
     best — the max-res URL to fetch first
     key  — a size-agnostic identity, so the SAME photo embedded at several
            tiers (Zillow gallery JSON does this) dedupes to ONE photo
            instead of flooding the 24-photo cap with duplicates.
   The download step tries `best` and falls back to the original URL, so a
   CDN that rejects the rewrite costs nothing but one extra fetch. */
export function maximizePhotoUrl(url) {
  // v62.4 KEY HARDENING (Troy's 40th St smoke test: "It imports the same
  // photo several times"): the v62.3 key kept the file EXTENSION and full
  // path, so Zillow's habit of embedding every shot as BOTH .jpg and .webp
  // (and under multiple size/crop names) sailed straight through dedupe —
  // the gallery filled with identical pairs. Identity is now the CDN's own
  // PHOTO ID wherever one exists in the URL, and extension-blind everywhere.
  const noExt = (s) => s.replace(/\.(?:jpe?g|webp|png)$/i, "");
  try {
    // Zillow + Trulia (same CDN family): /fp/<hash>-<variant>.<ext> — the
    // hash IS the photo. -cc_ft_<w> crops and *_scaled_within_<w>_<h>
    // variants all resolve to it; 1536 is the top public tier.
    /* v62.23 — THE ACTUAL 5-PHOTO BUG, measured on the live page.
       Zillow addresses one photo as /fp/<hash>-<variant>.<ext>, and it ships
       FOUR families of variant: cc_ft_<w> and uncropped_scaled_within_<w>_<h>
       (the resizable gallery tiers) plus p_c / p_d / d_d / o_a / p_f (FIXED
       thumbnails — p_c is 316x234). This rewrite only ever matched cc_ft and
       scaled_within. Dedupe is by photo hash and first-seen wins, so a photo
       whose first appearance in the document was a p_d thumbnail kept that
       thumbnail URL forever.
       Counted on 8725 E Via De Dorado: of 85 photo hashes, exactly FIVE first
       appear as cc_ft. The other 78 first appear as p_d or p_c. Those five
       are the five photos Troy got, every single import — the number never
       moved because it was never the scraper. We fetched 24 URLs, 19 came
       back at 400x300, and the v62.15 low-res gate correctly dropped them.
       Rewriting the whole variant token turns 316x234 into 1536x1152. */
    if (/zillowstatic\.com|trulia\.com/i.test(url)) {
      const hash = url.match(/\/fp\/([a-f0-9]{12,})/i);
      const best = hash
        ? url.replace(/(\/fp\/[a-f0-9]{12,})-[a-z0-9_]+(\.(?:jpe?g|webp|png))/i, "$1-cc_ft_1536$2")
        : url.replace(/-cc_ft_\d+/g, "-cc_ft_1536").replace(/scaled_within_\d+_\d+/g, "scaled_within_1536_1152");
      const key = hash
        ? `zw:${hash[1]}`
        : noExt(url.replace(/-cc_ft_\d+/g, "").replace(/scaled_within_\d+_\d+/g, "").split("?")[0]);
      return { best, key };
    }
    // Redfin: gallery embeds /mbphoto/…/genMid.<MLS>_<n>.jpg (~733px);
    // the full-size original lives at /bigphoto/…/<MLS>_<n>.jpg. Identity
    // is the MLS_<n> core, tier- and extension-blind.
    if (/cdn-redfin\.com/i.test(url)) {
      const best = url.replace(/\/mbphoto\//i, "/bigphoto/").replace(/genMid\./i, "");
      const key = "rf:" + noExt(
        url.replace(/\/(?:mb|big)photo\//i, "/photo-tier/").replace(/genMid\./i, "").split("?")[0]
      );
      return { best, key };
    }
    // Realtor.com (rdcpix is a resizer): <hash><letter>-m<id><sizeLetter>
    // — hash + m-id is the photo; the trailing letter and ?w= are tiers.
    if (/rdcpix\.com/i.test(url)) {
      const [path, query = ""] = url.split("?");
      const params = query.split("&").filter((p) => p && !/^(w|width|h|height)=/i.test(p));
      params.unshift("w=2048");
      const id = path.match(/rdcpix\.com\/([a-z0-9]+?)[a-z]?-m(\d+)/i);
      const key = id ? `rdc:${id[1]}-m${id[2]}` : noExt(path);
      return { best: `${path}?${params.join("&")}`, key };
    }
    // homes.com and anything else: strip width/height query limiters;
    // identity = path without extension.
    const [path, query = ""] = url.split("?");
    const params = query.split("&").filter((p) => p && !/^(w|width|h|height)=/i.test(p));
    return { best: params.length ? `${path}?${params.join("&")}` : path, key: noExt(path) };
  } catch {
    return { best: url, key: url };
  }
}

function extractPagePhotos(html) {
  // key → { url: maxResUrl, fallbackUrl: originalUrl } in first-seen order
  // (gallery order matters — it becomes the upload/scene order).
  const found = new Map();
  // Portals embed the full gallery in JSON script blobs with escaped
  // slashes ("https:\/\/photos...") — the visible <img> tags are only the
  // first few. Unescape before matching so we see the whole gallery.
  // v62.19: unescape to a FIXED POINT, not once. Zillow's preloaded Apollo
  // cache is JSON embedded inside a JSON *string*, so its photo URLs arrive
  // double-escaped ("https:\\/\\/photos..."); one pass leaves a stray
  // backslash, and the URL character class deliberately excludes
  // backslashes, so every one of those matches was silently lost. Bounded
  // at 3 passes — this only ever rewrites \/ and /.
  let text = String(html);
  for (let pass = 0; pass < 3; pass++) {
    const next = text.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/");
    if (next === text) break;
    text = next;
  }
  // v62.20: count what each guard throws away. Measured against the live
  // Scottsdale page, the shipped extractor pulls the full 24 out of a REAL
  // browser's HTML — so when production yields 5, the proxy is handing us a
  // different document, and the only way to see its shape from a serverless
  // log is to count the rejections. `cc_ft<576` is the tell: if the reduced
  // page carries the gallery only as thumbnails, that counter will be large
  // while `kept` stays tiny, and the fix is to upgrade those rather than
  // drop them. Costs nothing; ends the guessing.
  const rejected = { thumb: 0, chrome: 0, nonPhoto: 0, offPath: 0, notInGallery: 0, notGalleryTier: 0 };
  // v62.23: this listing's own photo hashes (see zillowGalleryHashes).
  const zGallery = zillowGalleryHashes(text);
  // Portal CDNs first — these are the full-size listing photos.
  for (const m of text.matchAll(PHOTO_CDN_RE)) {
    let url = m[0];
    const isZillow = /zillowstatic\.com/i.test(url);
    // v62.23: a small size hint is only disqualifying when we CAN'T fix it.
    // Every Zillow variant now rewrites to the full-size tier, so rejecting
    // a photo for the tier it happened to be embedded at would throw away
    // the exact photos this release exists to recover.
    if (!isZillow) {
      if (/cc_ft_(\d+)/.test(url) && Number(url.match(/cc_ft_(\d+)/)[1]) < 576) { rejected.thumb++; continue; }
      if (/[-_](\d{2,3})x(\d{2,3})\./.test(url)) { rejected.thumb++; continue; }
    }
    // v58.3: portal CDNs serve SITE ASSETS from the same hosts as listing
    // photos — m74 shipped a scene animating the REDFIN LOGO (captioned
    // "Living area"; QC passed it because the video faithfully matched its
    // source "photo"). Listing photos live under known path prefixes; site
    // chrome does not.
    if (isZillow) {
      if (!/\/fp\//.test(url)) { rejected.offPath++; continue; }
      const h = (url.match(/\/fp\/([a-f0-9]{12,})/i) || [])[1];
      if (!h) { rejected.offPath++; continue; }
      // Fail-open when the document carries no gallery tiers at all (a
      // reduced or blocked page): better a thin import than an empty one.
      if (zGallery.size > 0 && !zGallery.has(h.toLowerCase())) { rejected.notInGallery++; continue; }
      // v62.37 (audit): the fail-open must not resurrect the related-homes
      // carousel. Pre-v62.23, carousel photos arrived as 316x234 fixed
      // thumbs (p_c/p_d/...) and the low-res gate discarded them; the
      // unconditional variant rewrite now upgrades EVERYTHING to
      // cc_ft_1536, so failing open on the whole /fp/ namespace would ship
      // other people's houses at full resolution the day Zillow renames a
      // markup token. When we can't verify gallery membership, keep only
      // URLs the page itself embedded at a resizable GALLERY tier — the
      // carousel never is.
      if (zGallery.size === 0 && !/-(?:cc_ft_\d+|uncropped_scaled_within_\d+_\d+)\.(?:jpe?g|webp|png)/i.test(url)) {
        rejected.notGalleryTier++;
        continue;
      }
    }
    if (/cdn-redfin\.com/i.test(url) && !/\/photo\//i.test(url)) { rejected.offPath++; continue; }
    if (/logo|icon|sprite|badge|avatar|headshot|favicon|app-?store|play-?store|banner/i.test(url)) { rejected.chrome++; continue; }
    // v62.5: non-photo listing media — floor plans, site plans, surveys,
    // plats, brochures, elevation sheets — must never become video scenes
    // (the angry-customer class). URL keywords are the free first net; the
    // curation Vision pass (contentType gate) catches unlabeled ones.
    if (/floor-?plan|site-?plan|survey|plat[-_.]|blueprint|brochure|flyer|elevation|schematic|diagram/i.test(url)) { rejected.nonPhoto++; continue; }
    const { best, key } = maximizePhotoUrl(url);
    if (!found.has(key)) {
      found.set(key, { url: best, fallbackUrl: best === url ? "" : url });
    }
    if (found.size >= MAX_PHOTOS * 2) break;
  }
  // og:image as a floor — at least the hero photo on almost every portal.
  const og = text.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || text.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (og && /^https?:\/\//.test(og[1]) && !/logo|icon|sprite|badge|favicon/i.test(og[1])) {
    const { best, key } = maximizePhotoUrl(og[1]);
    if (!found.has(key)) found.set(key, { url: best, fallbackUrl: best === og[1] ? "" : og[1] });
  }
  const photos = [...found.values()].slice(0, MAX_PHOTOS);
  const upgraded = photos.filter((p) => p.fallbackUrl).length;
  if (upgraded > 0) console.log(`[import] photo max-res upgrade: ${upgraded}/${photos.length} URLs rewritten to full-size tiers.`);
  // v62.20: a thin result is only diagnosable next to what was discarded.
  if (photos.length < GALLERY_LOOKS_COMPLETE) {
    console.log(`[import] THIN GALLERY: kept ${photos.length}, page bytes ${Math.round(String(html).length / 1024)}KB, rejected ${JSON.stringify(rejected)}`);
  }
  photos.rejected = rejected;
  return photos;
}

/* v62.21: the listing facts, straight off the page we already fetched.
   Measured on the live Scottsdale page — Zillow's meta description is:
     "Zillow has 73 photos of this $1,130,000 3 beds, 3 baths, 2,097 sqft
      townhouse home located at 8725 E VIA DE DORADO --, Scottsdale, AZ"
   which is EXACTLY the four fields the webapp consumes (price / beds /
   baths / sqft). RentCast's other three — yearBuilt, lotSize, propertyType
   — are fetched today and read by nothing. So for a URL import the page is
   a complete substitute, and the property-records call becomes a fallback
   rather than a dependency. JSON-LD is tried first (Redfin and Realtor.com
   both ship schema.org RealEstateListing); the meta line is the portable
   floor that works even on a reduced page. */
export function factsFromHtml(html) {
  const text = String(html);
  const out = {};
  const num = (v) => {
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const jsonLd = text.match(/"price"\s*:\s*"?\$?([\d,]+(?:\.\d+)?)"?/i);
  if (jsonLd) out.price = num(jsonLd[1]);
  const desc = (text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) || [])[1] || "";
  const hay = `${desc} ${text.slice(0, 4000)}`;
  const price = hay.match(/\$\s?([\d][\d,]{4,})/);
  if (price && !out.price) out.price = num(price[1]);
  const beds = hay.match(/([\d.]+)\s*(?:bd\b|beds?\b|bedrooms?\b)/i);
  if (beds) out.beds = num(beds[1]);
  const baths = hay.match(/([\d.]+)\s*(?:ba\b|baths?\b|bathrooms?\b)/i);
  if (baths) out.baths = num(baths[1]);
  const sqft = hay.match(/([\d,]{3,})\s*(?:sqft\b|sq\.?\s?ft\b|square\s+feet)/i);
  if (sqft) out.sqft = num(sqft[1]);
  // Sanity rails — a bad parse must never overwrite a good RentCast value.
  if (out.beds != null && (out.beds > 30 || out.beds < 1)) delete out.beds;
  if (out.baths != null && (out.baths > 30 || out.baths < 1)) delete out.baths;
  if (out.sqft != null && (out.sqft < 150 || out.sqft > 60000)) delete out.sqft;
  if (out.price != null && (out.price < 10000 || out.price > 500000000)) delete out.price;
  return Object.keys(out).length ? out : null;
}

// v58.2: canonical Realtor.com links are ID-only
// (/realestateandhomes-detail/M2202013685 — no address in the slug), so when
// the URL parser comes up empty the page itself is the address source.
// Portals ship schema.org JSON-LD (streetAddress/addressLocality/…) and an
// og:title of the form "61 W Wilshire Dr, Phoenix, AZ 85003 …" — try both.
/* v62.58: identity check for the cross-portal rescue — street NUMBER must
   match exactly and at least one substantive street-name token (>=4 chars,
   not a suffix/directional, not pure digits) must appear in both. "8501 E
   Malcomb Dr" ~ "8501 E Malcomb Drive" passes; "8501 E Other St" fails on
   the token; a Zillow SEARCH page fails upstream because
   extractAddressFromHtml returns null there (no single-property JSON-LD,
   og:title has no leading street number). Streets whose only name token is
   short ("1st St") fail CLOSED — importing the wrong house's photos is a
   customer-facing disaster; skipping a rescue is a warning. */
export function samePropertyAddress(a, b) {
  if (!a?.line || !b?.line) return false;
  const numA = (String(a.line).match(/^\d+/) || [""])[0];
  const numB = (String(b.line).match(/^\d+/) || [""])[0];
  if (!numA || numA !== numB) return false;
  const SUFFIX = new Set(["east", "west", "north", "south", "drive", "street", "road", "court", "lane", "place", "avenue", "circle", "trail", "boulevard", "parkway", "terrace", "highway"]);
  const toks = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/gi, " ").split(/\s+/)
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !SUFFIX.has(t));
  const A = new Set(toks(a.line));
  return toks(b.line).some((t) => A.has(t));
}

export function extractAddressFromHtml(html) {
  const text = String(html);
  const grab = (key) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{2,80})"`));
    return m ? m[1].trim() : "";
  };
  let line = grab("streetAddress");
  let city = grab("addressLocality");
  // Exactly two letters or nothing — "Arizona" must NOT become "AR"(kansas);
  // long-form regions fall through to the og:title parse instead.
  let state = (grab("addressRegion").match(/^[A-Za-z]{2}$/) || [""])[0].toUpperCase();
  let zip = (grab("postalCode").match(/\d{5}/) || [""])[0];
  if (!line || !city || !state) {
    const t = text.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      || text.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i)
      || text.match(/<title>([^<]+)<\/title>/i);
    const m = t && t[1].match(/^\s*([0-9][^,<>]{2,60}?),\s*([A-Za-z .'-]{2,40}?),?\s+([A-Z]{2})[ ,]*(\d{5})/);
    if (m) { line = m[1].trim(); city = m[2].trim(); state = m[3]; zip = m[4]; }
  }
  if (!line || !city || !state || !/\d/.test(line)) return null;
  const display = [line, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return { line, city, state, zip, display, query: [line, city, state, zip].filter(Boolean).join(" ") };
}

/* ============================================================
   4. Download → user's listing-photos storage
   ============================================================ */

// Fetch one image URL (direct, then one proxy retry) → validated Buffer.
// v58: some portal CDNs referer-check direct image GETs — one proxy retry
// (no rendering, cheap credit) before giving up on the photo.
async function fetchImageBuffer(photoUrl) {
  let r = await fetchWithTimeout(photoUrl, { headers: BROWSER_HEADERS }, PHOTO_TIMEOUT_MS).catch(() => null);
  if ((!r || !r.ok) && process.env.SCRAPER_API_KEY) {
    r = await fetchWithTimeout(
      `https://api.scraperapi.com/?api_key=${encodeURIComponent(process.env.SCRAPER_API_KEY)}&url=${encodeURIComponent(photoUrl)}`,
      {},
      PHOTO_TIMEOUT_MS + 5000
    );
  }
  if (!r || !r.ok) throw new Error(`fetch ${r ? r.status : "failed"}`);
  const type = String(r.headers.get("content-type") || "");
  if (!type.startsWith("image/")) throw new Error(`not an image (${type.slice(0, 40)})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 8 * 1024) throw new Error("too small");
  if (buf.length > MAX_PHOTO_BYTES) throw new Error("too large");
  return { buf, type };
}

// photo: { url, fallbackUrl } (v62.3) or a plain string URL (RentCast path).
// seenHashes (v62.4): shared per-import Set of content SHA-256s — the last
// net under the URL-key dedupe. Two URLs the key logic can't relate that
// serve byte-identical files still resolve to ONE stored photo.
async function storePhoto(photo, userId, projectId, index, seenHashes) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) throw new Error("storage not configured");
  const candidates = typeof photo === "string"
    ? [photo]
    : [photo.url, photo.fallbackUrl].filter(Boolean);
  let buf = null;
  let type = "";
  let lastErr = null;
  for (let c = 0; c < candidates.length; c++) {
    try {
      ({ buf, type } = await fetchImageBuffer(candidates[c]));
      if (c > 0) console.log(`[import] photo ${index + 1}: max-res URL failed (${lastErr?.message}) — original tier used.`);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!buf) throw lastErr || new Error("no candidates");
  if (seenHashes) {
    const sha = createHash("sha256").update(buf).digest("hex");
    if (seenHashes.has(sha)) {
      console.log(`[import] photo ${index + 1}: byte-identical to an earlier photo — skipped.`);
      throw new Error("duplicate-bytes");
    }
    seenHashes.add(sha);
  }
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const fileName = `imported-${String(index + 1).padStart(2, "0")}.${ext}`;
  const bucket = process.env.LISTING_PHOTOS_BUCKET || "listing-photos";
  const storagePath = `${userId}/projects/${projectId}/${Date.now()}-${index}-${fileName}`;
  /* v62.22: retry the upload. Storage is the one step in this loop that
     depends on OUR backend being healthy, and a photo lost here is a photo
     the customer never sees — with no error, because the caller swallows
     per-photo failures to keep the import alive. Troy's 04:32 import ran
     straight through a ~1-minute window where Supabase was returning
     Cloudflare 520/525 (the same window that filled the render worker's log
     with `claim_render_job 520`), and a single-shot upload during that
     window drops the photo permanently. Three attempts over ~3.5s covers a
     blip of that shape; 4xx is not retried because it will never succeed. */
  let up = null;
  let upErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 700 * attempt * attempt));
    up = await fetchWithTimeout(
      `${supabaseUrl}/storage/v1/object/${bucket}/${storagePath}`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": type,
          "x-upsert": "true",
          "Cache-Control": "3600"
        },
        body: buf
      },
      20000
    ).catch((e) => { upErr = e?.message || "network"; return null; });
    if (up && up.ok) break;
    if (up && up.status >= 400 && up.status < 500) break; // permanent — don't burn retries
    upErr = up ? `upload ${up.status}` : upErr || "upload failed";
    if (attempt < 2) console.warn(`[import] photo ${index + 1}: ${upErr} — retrying (${attempt + 1}/2).`);
  }
  if (!up || !up.ok) throw new Error(upErr || `upload ${up ? up.status : "failed"}`);
  return {
    storagePath,
    bucket,
    fileName,
    size: buf.length,
    publicUrl: `${supabaseUrl}/storage/v1/object/public/${bucket}/${storagePath}`
  };
}

/* ============================================================
   Handler
   ============================================================ */

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ status: "failed", error: "Use POST." });
  }
  // v57: on-behalf import for the listing-link auto-render — the worker
  // imports a lead's listing with the shared internal secret so photos
  // land in the LEAD's storage under their projectId, exactly as if they
  // had pasted the link themselves. No secret configured → no bypass.
  const internalSecret = String(request.headers["x-internal-secret"] || "");
  const onBehalfUserId =
    !!process.env.CRON_SECRET && internalSecret === process.env.CRON_SECRET
      ? String(request.body?.onBehalfOfUserId || "").trim()
      : "";
  const auth = onBehalfUserId
    ? { ok: true, userId: onBehalfUserId }
    : await requireUser(request, response);
  if (!auth.ok) return;
  const limited = await rateLimit(request, response, {
    bucket: "import-listing",
    max: 6,
    windowMs: 60 * 60 * 1000
  });
  if (limited) return;

  const { url, projectId } = request.body || {};
  if (!url || typeof url !== "string" || url.length > 2048) {
    return response.status(400).json({ status: "failed", error: "A listing link is required." });
  }
  if (!projectId || !/^project-[A-Za-z0-9-]{6,64}$/.test(String(projectId))) {
    return response.status(400).json({ status: "failed", error: "projectId is required." });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("bad protocol");
  } catch {
    return response.status(400).json({ status: "failed", error: "That doesn't look like a listing link." });
  }

  const warnings = [];
  const t0 = Date.now();
  const host = parsedUrl.hostname.replace(/^www\./, "").toLowerCase();
  let address = parseAddressFromUrl(url);

  // Facts + (possibly) licensed photos from RentCast.
  let rc = address ? await rentcastFacts(address.query) : { facts: null, photos: [] };

  // Page photos — best-effort; portals often block datacenter fetches.
  let pagePhotoUrls = [];
  let photoSource = "none";
  // v62.19: how many photos the listing page SAYS it has. This is the only
  // way to tell "this listing has 5 photos" from "we only reached 5 of 73" —
  // and those two need completely different responses from us.
  let expectedPhotos = 0;
  // v62.21: facts parsed from the listing page itself (see factsFromHtml).
  let pageFacts = null;
  /* v62.21 — RENTCAST NO LONGER PREEMPTS THE PAGE.
     This used to read `if (rc.photos.length > 0) { use them } else { scrape }`,
     so ANY licensed media — one photo or five — meant the listing page was
     never fetched at all. Two things wrong with that. It silently caps a
     73-photo listing at whatever the records API happens to carry, and it
     makes the photo source unknowable from the outside: a thin import looks
     identical whether the scraper failed or RentCast simply returned five.
     The page is now always attempted and licensed media is a FALLBACK,
     used only when it beats what the page yielded. */
  {
    // v58 (live 3-portal test, Jul 23): direct fetches are dead on every
    // major portal — Zillow bot-walls (fast 403/challenge, 0 photos),
    // Redfin and Realtor.com hang past any serverless budget. RentCast has
    // no photos tier, so the page IS the photo source and it needs a
    // rendering proxy. With SCRAPER_API_KEY set, the page fetch routes
    // through ScraperAPI (residential IPs + JS rendering, generous
    // timeout); without it, the old direct fetch stays as the dev/local
    // path. Fail order: proxy → direct → warn (never throws).
    const proxyKey = process.env.SCRAPER_API_KEY || "";
    let html = "";
    if (proxyKey) {
      // v58.2: realtor.com never yields to the standard pool (Kasada), but
      // its pages are SSR'd — so skip JS rendering there and escalate the
      // proxy tier instead (premium 10cr → ultra_premium 30cr, mutually
      // exclusive params per ScraperAPI docs). Zillow/Redfin stay on the
      // proven render=true path (10cr).
      //
      // v62.19 (Troy, 8725 E Via De Dorado: "the URL scraper only grabbed 5
      // photos" — the page advertises 73). TWO bugs met here:
      //   1. This loop broke on `if (html) break` — on HAVING HTML, not on
      //      having a GALLERY. A tier that returns 200 with a bot-wall or a
      //      thin above-the-fold page ended the ladder, so realtor.com's
      //      ultra_premium escalation has been dead code since v58.2 and
      //      Zillow had no second tier at all.
      //   2. render=true returns the HYDRATED DOM. Zillow mounts only the
      //      hero grid (1 + 4 tiles = the 5 Troy got) and loads the rest of
      //      the gallery on interaction — while the un-rendered SSR HTML
      //      carries the whole set in its JSON blob. Rendering the page can
      //      therefore see FEWER photos than not rendering it.
      // Now every tier is scored by how many photos it actually yields, the
      // best result wins, and the ladder stops early only once the gallery
      // looks complete against the count the page itself advertises.
      // v62.20 — MEASURED, not guessed. Loaded the Scottsdale page in a real
      // browser and counted: the full gallery (85 distinct photo hashes) is
      // already in the SSR HTML, inside __NEXT_DATA__; only 16 appear in
      // <img> tags. Running the SHIPPED extractor against that document
      // returns the full 24. So parsing was never the problem, and JS
      // rendering buys nothing — the gallery is server-rendered. What
      // render=true DOES buy is a headless-browser fingerprint, which is
      // among the easiest things for Zillow to challenge, and 10 credits.
      // Every portal now gets the residential ladder realtor.com already
      // used: a trusted IP first, a more expensive one if the page comes
      // back thin.
      /* v62.57 (realtor.com, first toast of the v62.56 era: "Photo proxy
         (premium) timed out" with zero photos). TWO structural bugs met:
         1. THE BUDGET TRAP. The page phase deadline is 40s but tier 1's
            timeout was min(45s, remaining) — the WHOLE budget. A tier that
            times out (rather than failing fast with a non-200) therefore
            starved every tier after it below the 12s floor: the ladder's
            second rung could only ever run after a FAST failure, never
            after a slow one. Now a tier with successors is capped at 22s,
            so the next rung always inherits a viable (>=18s) window.
         2. THE WRONG FIRST RUNG. v58.2 already measured that realtor.com
            never yields to the standard pool (Kasada) — premium-first
            there spends 10 credits to burn the budget the working tier
            needed. realtor.com now goes straight to ultra_premium. */
      const tiers = /(^|\.)realtor\.com$/.test(host)
        ? ["ultra_premium=true"]
        : ["premium=true", "ultra_premium=true"];
      // maxDuration is 120s and photo downloads still have to run, so the
      // page phase gets a hard deadline rather than a per-attempt budget
      // that can overrun it. 75s covers a full ultra_premium attempt (45s)
      // AND the Zillow address rescue below, with ~40s left for transfers.
      const pagePhaseDeadline = t0 + 75000;
      for (let ti = 0; ti < tiers.length; ti++) {
        const tier = tiers[ti];
        const remainingMs = pagePhaseDeadline - Date.now();
        if (remainingMs < 12000) {
          console.log(`[import] page phase out of budget — skipping ${tier.split("=")[0]} tier.`);
          // v62.57: say it in the response too — "we never got to try the
          // strong tier" and "the strong tier failed" need different toasts.
          warnings.push(`Photo proxy ran out of time before the ${tier.split("=")[0]} tier could run.`);
          break;
        }
        const isLastTier = ti === tiers.length - 1;
        // v62.59: the last tier's window depends on what comes after it.
        // A rescue-eligible import (non-Zillow host with a parsed address)
        // reserves ~30s for the Zillow address rescue; a Zillow import has
        // no rescue, so its final tier gets ScraperAPI's full recommended
        // window. A tier with successors stays tightly capped.
        const rescueEligible = !!address && !/(^|\.)zillow\.com$/.test(host);
        // 38s keeps rescue room even on a two-tier rescue-eligible ladder
        // (22 + 38 = 60s spent, ~15s+ of the 75s phase left for the rescue).
        const tierCapMs = isLastTier ? (rescueEligible ? 38000 : 70000) : 22000;
        try {
          const prox = await fetchWithTimeout(
            `https://api.scraperapi.com/?api_key=${encodeURIComponent(proxyKey)}&url=${encodeURIComponent(url)}&${tier}&country_code=us`,
            { redirect: "follow" },
            Math.min(PROXY_PAGE_TIMEOUT_MS, remainingMs, tierCapMs)
          );
          if (prox.ok) {
            const body = await prox.text();
            if (body) {
              const found = extractPagePhotos(body);
              expectedPhotos = Math.max(expectedPhotos, expectedPhotoCount(body));
              console.log(`[import] tier ${tier.split("=")[0]}: ${found.length} photo URL(s); page advertises ${expectedPhotos || "?"}.`);
              // Keep the richest gallery, and the html that produced it.
              if (found.length > pagePhotoUrls.length || !html) {
                if (found.length >= pagePhotoUrls.length) pagePhotoUrls = found;
                html = body;
              }
              // Enough = the advertised count (capped at what we can store),
              // or a plausibly-complete gallery when the page never says.
              const enough = Math.min(MAX_PHOTOS, expectedPhotos || GALLERY_LOOKS_COMPLETE);
              if (pagePhotoUrls.length >= enough) break;
            }
          } else {
            warnings.push(`Photo proxy (${tier.split("=")[0]}) returned ${prox.status}.`);
          }
        } catch {
          warnings.push(`Photo proxy (${tier.split("=")[0]}) timed out.`);
        }
      }
    }
    // Direct fetch is the no-key dev path ONLY now (v62.58) — v58 measured
    // direct fetches dead on every major portal, so running one after the
    // proxy ladder failed just spent 9s of the budget the Zillow rescue
    // below needs, on a fetch we already knew would bot-wall.
    if (pagePhotoUrls.length === 0 && !proxyKey) {
      try {
        const page = await fetchWithTimeout(url, { headers: BROWSER_HEADERS, redirect: "follow" }, PAGE_TIMEOUT_MS);
        if (page.ok) {
          const body = await page.text();
          if (body) {
            const found = extractPagePhotos(body);
            expectedPhotos = Math.max(expectedPhotos, expectedPhotoCount(body));
            if (found.length > 0 || !html) html = body;
            if (found.length > pagePhotoUrls.length) pagePhotoUrls = found;
          }
        } else {
          warnings.push(`The listing page couldn't be read (${page.status}) — add photos manually.`);
        }
      } catch {
        warnings.push("The listing page couldn't be read — add photos manually.");
      }
    }
    if (pagePhotoUrls.length > 0) photoSource = proxyKey ? "listing_page_proxy" : "listing_page";
    // v62.21: the page we already paid to fetch carries the listing facts.
    if (html) pageFacts = factsFromHtml(html);
    /* ── v62.58 CROSS-PORTAL RESCUE ─────────────────────────────────────
       Realtor.com's Kasada wall outlasted the full ultra_premium window
       twice in one evening — but the same property is almost always ON
       Zillow, where the premium tier demonstrably works, and we already
       hold the parsed address. So: when a non-Zillow page yields nothing
       and we know the address, fetch the Zillow address page (the _rb slug
       302s to homedetails) and take the gallery from there. Guarded by
       samePropertyAddress — street number + name-token identity against
       the page's OWN parsed address — so a search-results page (parses to
       null) or a near-miss address can never ship the wrong house. */
    if (pagePhotoUrls.length === 0 && address && proxyKey && !/(^|\.)zillow\.com$/.test(host)) {
      const rescueRemaining = t0 + 75000 - Date.now();
      if (rescueRemaining >= 12000) {
        const slug = `${address.line} ${address.city} ${address.state}`
          .replace(/[^A-Za-z0-9 ]/g, " ").trim().replace(/\s+/g, "-");
        const zUrl = `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`;
        try {
          const prox = await fetchWithTimeout(
            `https://api.scraperapi.com/?api_key=${encodeURIComponent(proxyKey)}&url=${encodeURIComponent(zUrl)}&premium=true&country_code=us`,
            { redirect: "follow" },
            Math.min(30000, rescueRemaining)
          );
          if (prox.ok) {
            const body = await prox.text();
            const zAddr = extractAddressFromHtml(body);
            if (samePropertyAddress(address, zAddr)) {
              const found = extractPagePhotos(body);
              if (found.length > 0) {
                pagePhotoUrls = found;
                expectedPhotos = Math.max(expectedPhotos, expectedPhotoCount(body));
                if (!pageFacts) pageFacts = factsFromHtml(body);
                photoSource = "zillow_address_rescue";
                warnings.push(`${host} wouldn't let us read the page — photos pulled from the Zillow listing at this address instead.`);
                console.log(`[import] zillow address rescue: ${found.length} photo URL(s) for "${slug}" (page advertises ${expectedPhotos || "?"}).`);
              }
            } else {
              console.log(`[import] zillow address rescue: identity check failed ("${zAddr?.line || "no address parsed"}" vs "${address.line}") — skipped rather than risk the wrong house.`);
            }
          } else {
            console.log(`[import] zillow address rescue: proxy returned ${prox.status}.`);
          }
        } catch {
          console.log("[import] zillow address rescue timed out.");
        }
      }
    }
    if (html && !address) {
      // v58.2: ID-only links (realtor.com M-ids) carry no address — pull it
      // from the page markup, then backfill facts from RentCast.
      address = extractAddressFromHtml(html);
      if (address) {
        const late = await rentcastFacts(address.query);
        rc = { facts: late.facts, photos: rc.photos };
      }
    }
  }

  // v62.21: licensed media is a FALLBACK now, not a preemption — it only
  // wins when it actually beats the page. On the free records tier this is
  // almost always an empty array, which is exactly why it must not have
  // been gating the scrape.
  if (rc.photos.length > pagePhotoUrls.length) {
    console.log(`[import] licensed media (${rc.photos.length}) beat the page (${pagePhotoUrls.length}) — using it.`);
    pagePhotoUrls = rc.photos.slice(0, MAX_PHOTOS).map((u) => ({ url: u, fallbackUrl: "" }));
    photoSource = "licensed_listing_data";
  }

  // Download + store, parallel with a small concurrency cap.
  const stored = [];
  if (pagePhotoUrls.length > 0 && auth.userId) {
    const queue = [...pagePhotoUrls.entries()];
    const seenHashes = new Set(); // v62.4 byte-identity net across this import
    // v62.22: per-photo failures were swallowed completely — `catch {}` with
    // no counter, no reason, no log line. So "we found 24 URLs and shipped
    // 7" was indistinguishable from "the page only had 7", which is exactly
    // the ambiguity that made this bug take three rounds to corner. Reasons
    // are grouped (24 identical lines help nobody) and the deliberate ones
    // (duplicate-bytes) are separated from the failures.
    const failures = [];
    const workers = Array.from({ length: 6 }, async () => {
      while (queue.length > 0) {
        const [i, photoUrl] = queue.shift();
        try {
          stored.push({ order: i, ...(await storePhoto(photoUrl, auth.userId, projectId, i, seenHashes)) });
        } catch (err) {
          failures.push(String(err?.message || "unknown").slice(0, 60));
        }
      }
    });
    await Promise.all(workers);
    stored.sort((a, b) => a.order - b.order);
    const dupes = failures.filter((f) => f === "duplicate-bytes").length;
    const realFailures = failures.filter((f) => f !== "duplicate-bytes");
    if (failures.length > 0) {
      const grouped = realFailures.reduce((acc, f) => (acc[f] = (acc[f] || 0) + 1, acc), {});
      console.log(`[import] photo transfer: ${stored.length} stored, ${dupes} byte-duplicates, ${realFailures.length} failed ${JSON.stringify(grouped)}`);
    }
    // A transfer failure is OUR side, not the portal's, and it needs a
    // different message than "the listing only exposed N photos".
    if (realFailures.length >= 3 && stored.length > 0) {
      warnings.push(
        `We found ${pagePhotoUrls.length} photos but only ${stored.length} transferred — ` +
        `that's usually a brief storage hiccup on our end. Re-importing normally picks up the rest.`
      );
    }
    if (stored.length === 0 && pagePhotoUrls.length > 0) {
      warnings.push("Photos were found but couldn't be transferred — add them manually.");
      photoSource = "none";
    }
  }

  // v62.19: say it out loud when the portal held photos back. Five photos
  // off a 73-photo listing looks identical, in the UI, to a listing that
  // only has five — and the agent reasonably assumes the second. Comparing
  // against the page's own advertised count is the difference between a
  // silent bad import and one the customer can act on.
  const shortfall = expectedPhotos - stored.length;
  if (expectedPhotos > 0 && stored.length > 0 && shortfall >= 3 && stored.length < MAX_PHOTOS) {
    warnings.push(
      `This listing has ${expectedPhotos} photos but the page only exposed ${stored.length} to us — ` +
      `drag the rest in to build a fuller tour.`
    );
  }

  // v58.2: one structured line per import — Vercel logs are otherwise blind
  // to WHY a portal produced zero photos (warnings only ship in the response
  // body, which the UI drops). This is the black box recorder.
  const logImport = (status) => console.log(JSON.stringify({
    importListing: {
      host,
      status,
      photoSource,
      photos: stored.length,
      // v62.19: the three numbers that make a thin import diagnosable from
      // the log alone — what the page claims, what we extracted, what
      // survived download+dedupe. Without `expected` there is no way to
      // tell a 5-photo listing from a 5-of-73 extraction failure.
      expected: expectedPhotos || null,
      urlsFound: pagePhotoUrls.length,
      address: address ? address.display : null,
      warnings,
      ms: Date.now() - t0
    }
  }));

  if (!address && stored.length === 0) {
    logImport("not_found");
    return response.status(200).json({
      status: "not_found",
      message:
        "We couldn't read an address or photos from that link. Paste a Zillow, Redfin, or Realtor.com listing page — or start the project and add photos manually."
    });
  }

  logImport("ok");
  return response.status(200).json({
    status: "ok",
    address: address
      ? { line: address.line, city: address.city, state: address.state, zip: address.zip, display: address.display }
      : null,
    // v62.21: page facts win where present, records fill the gaps. The page
    // is the listing as published (a price cut shows up there first); the
    // records API is a monthly-refreshed database. Either alone is enough
    // for the four fields the app reads, so an import no longer depends on
    // the RentCast subscription being active.
    facts: (pageFacts || rc.facts) ? { ...(rc.facts || {}), ...(pageFacts || {}) } : null,
    factsSource: pageFacts && rc.facts ? "page+records" : pageFacts ? "page" : rc.facts ? "records" : "none",
    photoSource,
    photos: stored.map(({ order, ...p }) => p),
    warnings
  });
}
