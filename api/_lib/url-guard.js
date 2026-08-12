// Shared SSRF guard for server-side fetches of user-influenced URLs.
//
// v62.98 (security audit): /api/import-listing fetches scraped photo URLs —
// including a page's og:image, which is otherwise host-unrestricted — directly
// from the serverless function. An attacker who submits a page they control
// can point og:image at http://169.254.169.254/… (cloud metadata),
// http://localhost:PORT/…, or a private-range host and turn the importer into
// a blind SSRF request primitive. This mirrors the rule render.js already
// applies to scene URLs (isPrivateOrPlainHttpUrl): a listing photo never lives
// on a private/link-local host or a bare IP — real portal CDNs have names.
//
// Returns true when the URL should be BLOCKED. http is allowed to NAMED public
// hosts (some portals still serve images over http) — the danger is the host,
// not the scheme — but non-web schemes (file:, gopher:, ftp:, dict:, …) are
// always blocked.
export function isBlockedFetchTarget(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return true; // unparseable → block
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  if (host.startsWith("[")) return true; // IPv6 literal — CDNs use names
  // Any bare IPv4: covers loopback (127/8), link-local metadata (169.254/16),
  // and the private ranges (10/8, 172.16/12, 192.168/16) in one stroke. A
  // legitimate listing photo is never served from a raw IPv4 address.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}
