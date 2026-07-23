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

import { requireUser } from "./_lib/auth.js";
import { rateLimit } from "./_lib/rate-limit.js";

const RENTCAST_BASE = "https://api.rentcast.io/v1";
const MAX_PHOTOS = 24;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 9000;
// v58: ScraperAPI with render=true routinely takes 15-40s on bot-walled
// portals — give it room. The Vercel function budget absorbs it; the
// worker's auto-render pass calls this endpoint with a 60s client timeout.
const PROXY_PAGE_TIMEOUT_MS = 45000;
const PHOTO_TIMEOUT_MS = 10000;
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

// Vercel Pro: allow time for photo downloads. Everything is parallel and
// byte-capped; typical imports finish well under 30s.
export const config = { maxDuration: 60 };

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

const PHOTO_CDN_RE =
  /https:\/\/(?:photos\.zillowstatic\.com|ssl\.cdn-redfin\.com|ap\.rdcpix\.com|images\.homes\.com|photos\.trulia\.com)[^\s"'\\)]+?\.(?:jpe?g|webp|png)/gi;

function extractPagePhotos(html) {
  const found = new Set();
  // Portals embed the full gallery in JSON script blobs with escaped
  // slashes ("https:\/\/photos...") — the visible <img> tags are only the
  // first few. Unescape before matching so we see the whole gallery.
  const text = String(html).replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/");
  // Portal CDNs first — these are the full-size listing photos.
  for (const m of text.matchAll(PHOTO_CDN_RE)) {
    let url = m[0];
    // Skip obvious thumbnails when a size hint is embedded in the URL.
    if (/cc_ft_(\d+)/.test(url) && Number(url.match(/cc_ft_(\d+)/)[1]) < 576) continue;
    if (/[-_](\d{2,3})x(\d{2,3})\./.test(url)) continue;
    found.add(url);
    if (found.size >= MAX_PHOTOS * 2) break;
  }
  // og:image as a floor — at least the hero photo on almost every portal.
  const og = text.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || text.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (og && /^https?:\/\//.test(og[1])) found.add(og[1]);
  return [...found].slice(0, MAX_PHOTOS);
}

// v58.2: canonical Realtor.com links are ID-only
// (/realestateandhomes-detail/M2202013685 — no address in the slug), so when
// the URL parser comes up empty the page itself is the address source.
// Portals ship schema.org JSON-LD (streetAddress/addressLocality/…) and an
// og:title of the form "61 W Wilshire Dr, Phoenix, AZ 85003 …" — try both.
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

async function storePhoto(photoUrl, userId, projectId, index) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) throw new Error("storage not configured");
  let r = await fetchWithTimeout(photoUrl, { headers: BROWSER_HEADERS }, PHOTO_TIMEOUT_MS).catch(() => null);
  // v58: some portal CDNs referer-check direct image GETs — one proxy retry
  // (no rendering, cheap credit) before giving up on the photo.
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
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const fileName = `imported-${String(index + 1).padStart(2, "0")}.${ext}`;
  const bucket = process.env.LISTING_PHOTOS_BUCKET || "listing-photos";
  const storagePath = `${userId}/projects/${projectId}/${Date.now()}-${index}-${fileName}`;
  const up = await fetchWithTimeout(
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
  );
  if (!up.ok) throw new Error(`upload ${up.status}`);
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
  if (rc.photos.length > 0) {
    pagePhotoUrls = rc.photos.slice(0, MAX_PHOTOS);
    photoSource = "licensed_listing_data";
  } else {
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
      // proven render=true path (10cr). Each attempt gets a shorter budget
      // so two tiers still fit the 120s function ceiling.
      const tiers = /(^|\.)realtor\.com$/.test(host)
        ? ["premium=true", "ultra_premium=true"]
        : ["render=true"];
      const perAttemptMs = tiers.length > 1 ? 35000 : PROXY_PAGE_TIMEOUT_MS;
      for (const tier of tiers) {
        try {
          const prox = await fetchWithTimeout(
            `https://api.scraperapi.com/?api_key=${encodeURIComponent(proxyKey)}&url=${encodeURIComponent(url)}&${tier}&country_code=us`,
            { redirect: "follow" },
            perAttemptMs
          );
          if (prox.ok) {
            html = await prox.text();
            if (html) break;
          } else {
            warnings.push(`Photo proxy (${tier.split("=")[0]}) returned ${prox.status}.`);
          }
        } catch {
          warnings.push(`Photo proxy (${tier.split("=")[0]}) timed out.`);
        }
      }
    }
    if (!html) {
      try {
        const page = await fetchWithTimeout(url, { headers: BROWSER_HEADERS, redirect: "follow" }, PAGE_TIMEOUT_MS);
        if (page.ok) html = await page.text();
        else warnings.push(`The listing page couldn't be read (${page.status}) — add photos manually.`);
      } catch {
        warnings.push("The listing page couldn't be read — add photos manually.");
      }
    }
    if (html) {
      pagePhotoUrls = extractPagePhotos(html);
      if (pagePhotoUrls.length > 0) photoSource = proxyKey ? "listing_page_proxy" : "listing_page";
      // v58.2: ID-only links (realtor.com M-ids) carry no address — pull it
      // from the page markup, then backfill facts from RentCast.
      if (!address) {
        address = extractAddressFromHtml(html);
        if (address) {
          const late = await rentcastFacts(address.query);
          rc = { facts: late.facts, photos: rc.photos };
        }
      }
    }
  }

  // Download + store, parallel with a small concurrency cap.
  const stored = [];
  if (pagePhotoUrls.length > 0 && auth.userId) {
    const queue = [...pagePhotoUrls.entries()];
    const workers = Array.from({ length: 6 }, async () => {
      while (queue.length > 0) {
        const [i, photoUrl] = queue.shift();
        try {
          stored.push({ order: i, ...(await storePhoto(photoUrl, auth.userId, projectId, i)) });
        } catch { /* skip failed photo */ }
      }
    });
    await Promise.all(workers);
    stored.sort((a, b) => a.order - b.order);
    if (stored.length === 0 && pagePhotoUrls.length > 0) {
      warnings.push("Photos were found but couldn't be transferred — add them manually.");
      photoSource = "none";
    }
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
    facts: rc.facts,
    photoSource,
    photos: stored.map(({ order, ...p }) => p),
    warnings
  });
}
