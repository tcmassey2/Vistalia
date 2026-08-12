// Vistalia — free-text listing resolver (v62.95).
//
// THE GAP (v57's own comment named it): "A typed street address is kept in
// `raw` but doesn't trigger auto-render." The night of Aug 11 measured the
// cost — nine of thirteen no-render leads never gave a parseable URL, five
// of them signed in and waited. Agents type what they know: an address or
// an MLS number. This endpoint turns that text into the listing URL the
// import pipeline already speaks.
//
// HOW: Zillow's search URL (zillow.com/homes/<query>_rb/) resolves an
// exact-enough query straight to the /homedetails/ page. We fetch it
// through the same ScraperAPI proxy the importer uses, pull the canonical
// homedetails URL out of the page, and then VERIFY: the page's address
// must pass samePropertyAddress against the query (street number exact +
// a substantive street-name token). Import-the-wrong-house is the one
// unforgivable failure, so everything here fails CLOSED — an ambiguous or
// unverifiable match returns not_found and the lead stays in the manual
// email lane, exactly as today.
//
// Worker-only surface: requires the CRON_SECRET internal header, same
// contract as the on-behalf import. No secret configured → no access.

import { samePropertyAddress, extractAddressFromHtml } from "./import-listing.js";
import { requireUser } from "./_lib/auth.js";
import { rateLimit } from "./_lib/rate-limit.js";

const FETCH_TIMEOUT_MS = 45000;

// A query worth attempting: starts with a street number, carries at least
// three tokens total ("110 Hunter" stays manual — no city, no state, no
// way to verify), fits address length, and isn't an email or URL. MLS
// numbers (6-10 digits, optional prefix) also qualify — Zillow's search
// resolves many of them directly.
export function looksLikeListingQuery(value) {
  const v = String(value || "").trim();
  if (v.length < 8 || v.length > 120) return false;
  if (/^https?:\/\//i.test(v) || /\S+@\S+\.\S+/.test(v)) return false;
  if (/^(mls\s*#?\s*)?[a-z]{0,3}[-\s]?\d{6,10}$/i.test(v)) return true; // MLS number
  if (!/^\d{1,6}\s+\S/.test(v)) return false;                            // street number first
  const tokens = v.split(/[\s,]+/).filter(Boolean);
  if (tokens.length < 3) return false;                                   // number + street + city/state minimum
  if (!/[a-z]{3,}/i.test(v)) return false;                               // real words, not digit soup
  return true;
}

async function fetchViaProxy(url) {
  const proxyKey = process.env.SCRAPER_API_KEY || "";
  const target = proxyKey
    ? `https://api.scraperapi.com/?api_key=${encodeURIComponent(proxyKey)}&url=${encodeURIComponent(url)}&country_code=us`
    : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      headers: proxyKey ? {} : { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The search page (or direct-resolved details page) carries the canonical
// homedetails URL in several shapes — canonical link, hdpUrl, og:url.
export function homedetailsUrlFromHtml(html) {
  const text = String(html || "");
  const pats = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["'](https:\/\/www\.zillow\.com\/homedetails\/[^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["'](https:\/\/www\.zillow\.com\/homedetails\/[^"']+)["']/i,
    /"hdpUrl"\s*:\s*"(\/homedetails\/[^"]+)"/i,
    /https:\/\/www\.zillow\.com\/homedetails\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+_zpid\/?/i
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (m) {
      const raw = m[1] || m[0];
      const url = raw.startsWith("/") ? `https://www.zillow.com${raw}` : raw;
      // Normalize: strip query/fragment; a homedetails URL is self-sufficient.
      try {
        const u = new URL(url);
        if (!/\/homedetails\//.test(u.pathname)) continue;
        return `${u.origin}${u.pathname}`;
      } catch { /* try the next pattern */ }
    }
  }
  return "";
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ status: "failed", error: "Use POST." });
  }
  // v62.96: two callers — the worker (shared-secret, lead auto-render) and
  // signed-in webapp users (the dump area's typed-address path). Same
  // contract as import-listing's dual auth.
  const internalSecret = String(request.headers["x-internal-secret"] || "");
  const isWorker = !!process.env.CRON_SECRET && internalSecret === process.env.CRON_SECRET;
  if (!isWorker) {
    const auth = await requireUser(request, response);
    if (!auth.ok) return;
    const limited = await rateLimit(request, response, {
      bucket: "resolve-listing",
      max: 12,
      windowMs: 60 * 60 * 1000
    });
    if (limited) return;
  }

  const query = String(request.body?.query || "").trim().replace(/\s+/g, " ");
  if (!looksLikeListingQuery(query)) {
    return response.status(200).json({ status: "not_a_query" });
  }

  try {
    const searchUrl = `https://www.zillow.com/homes/${encodeURIComponent(query)}_rb/`;
    const html = await fetchViaProxy(searchUrl);
    if (!html) {
      return response.status(200).json({ status: "fetch_failed" }); // transient — worker retries
    }
    const listingUrl = homedetailsUrlFromHtml(html);
    if (!listingUrl) {
      console.info(`[resolve] no homedetails match for "${query.slice(0, 60)}" — search page stayed a search page.`);
      return response.status(200).json({ status: "not_found" });
    }
    // VERIFY before we hand this to the importer. For an address query the
    // page's own address must match street number + name. MLS-number
    // queries carry no address to compare — verify shape only (the exact
    // search either hit its listing or nothing).
    const isMlsQuery = /^(mls\s*#?\s*)?[a-z]{0,3}[-\s]?\d{6,10}$/i.test(query);
    if (!isMlsQuery) {
      const pageAddress = extractAddressFromHtml(html);
      if (!pageAddress?.line || !samePropertyAddress({ line: query }, pageAddress)) {
        console.warn(`[resolve] REJECTED "${query.slice(0, 60)}" — resolved page address "${pageAddress?.line || "none"}" failed verification. Fail closed.`);
        return response.status(200).json({ status: "not_found" });
      }
    }
    console.info(`[resolve] "${query.slice(0, 60)}" → ${listingUrl}`);
    return response.status(200).json({ status: "ok", url: listingUrl });
  } catch (err) {
    console.warn(`[resolve] error for "${query.slice(0, 40)}": ${err?.message || err}`);
    return response.status(200).json({ status: "fetch_failed" });
  }
}
