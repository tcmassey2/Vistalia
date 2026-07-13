// Shared rate limiter for /api/* endpoints.
//
// In-memory token bucket. Works on a single Vercel function instance and
// resets when the instance recycles (typically every ~15 min on cold paths).
// That's "good enough" protection against burst abuse — a real attacker
// hammering us at scale would need an upgrade to Upstash/Redis-backed
// limits, but for launch this closes the obvious holes.
//
// Strategy:
//   - Identify the caller. Prefer the Supabase user ID (parsed from the
//     bearer token if present), otherwise fall back to the request IP.
//   - Each (caller, bucketName) pair gets its own bucket with a max-tokens
//     refilled linearly over the windowMs duration.
//   - On each call we add tokens since lastRefill, then try to subtract
//     one. If the bucket is empty, return 429 with Retry-After.
//
// Usage from an endpoint:
//
//   import { rateLimit } from "./_lib/rate-limit.js";
//   ...
//   const limited = await rateLimit(request, response, {
//     bucket: "render",
//     max: 10,
//     windowMs: 60 * 60 * 1000  // 10 / hour
//   });
//   if (limited) return; // response already sent

const buckets = new Map();

const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
let lastPruneAt = Date.now();

export async function rateLimit(request, response, options) {
  const { bucket, max, windowMs } = options;
  if (!bucket || !Number.isFinite(max) || max <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    // Misconfigured limit — log and let the request through rather than
    // accidentally blocking real users.
    console.warn("[rate-limit] bad options:", options);
    return false;
  }

  const callerId = await identifyCaller(request);
  const key = `${bucket}:${callerId}`;
  const now = Date.now();
  const refillRate = max / windowMs; // tokens per ms

  let entry = buckets.get(key);
  if (!entry) {
    entry = { tokens: max, lastRefill: now };
    buckets.set(key, entry);
  } else {
    const elapsed = now - entry.lastRefill;
    entry.tokens = Math.min(max, entry.tokens + elapsed * refillRate);
    entry.lastRefill = now;
  }

  if (entry.tokens < 1) {
    // How long until they can try again? Time to accumulate 1 token.
    const waitMs = Math.ceil((1 - entry.tokens) / refillRate);
    const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));
    response.setHeader("Retry-After", String(retryAfterSec));
    response.setHeader("X-RateLimit-Limit", String(max));
    response.setHeader("X-RateLimit-Remaining", "0");
    response.setHeader("X-RateLimit-Reset", String(Math.ceil((now + waitMs) / 1000)));
    response.status(429).json({
      status: "failed",
      error: friendlyMessage(bucket, retryAfterSec),
      retryAfterSec
    });
    return true;
  }

  entry.tokens -= 1;
  response.setHeader("X-RateLimit-Limit", String(max));
  response.setHeader("X-RateLimit-Remaining", String(Math.floor(entry.tokens)));

  // Periodic prune so the Map doesn't grow unboundedly. Buckets that
  // haven't been touched in 2× the window are gone.
  if (now - lastPruneAt > PRUNE_INTERVAL_MS) {
    pruneStaleBuckets(now, windowMs);
    lastPruneAt = now;
  }

  return false;
}

function pruneStaleBuckets(now, windowMs) {
  const cutoff = now - windowMs * 2;
  for (const [key, entry] of buckets) {
    if (entry.lastRefill < cutoff) buckets.delete(key);
  }
}

// Refund one token — for endpoints where a counted attempt failed on OUR
// side (upstream 5xx), not the caller's. Without this, three provider
// hiccups lock a well-behaved visitor out for a day (voice-demo, launch
// eve). No-op if the bucket doesn't exist.
export async function refundRateLimit(request, options) {
  const { bucket, max } = options;
  try {
    const callerId = await identifyCaller(request);
    const entry = buckets.get(`${bucket}:${callerId}`);
    if (entry) entry.tokens = Math.min(Number(max) || 1, entry.tokens + 1);
  } catch {
    /* refunds are best-effort */
  }
}

// Caller identity. Prefer the authed user id (more accurate than IP, since
// many corporate networks share a NAT IP). Fall back to IP for unauth calls.
async function identifyCaller(request) {
  const auth = String(request.headers.authorization || "");
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const userId = await resolveUserId(token);
    if (userId) return `u:${userId}`;
  }
  // Vercel sets x-forwarded-for to the public client IP. Take the first.
  const xff = String(request.headers["x-forwarded-for"] || "");
  const ip = xff.split(",")[0].trim() || request.socket?.remoteAddress || "unknown";
  return `ip:${ip}`;
}

// Fast user-id resolver — cached for 60s so we don't hit Supabase on
// every rate-limit check.
const userCache = new Map();
const USER_CACHE_TTL_MS = 60_000;
async function resolveUserId(token) {
  const cached = userCache.get(token);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.userId;
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !anonKey) return "";
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    const userId = data?.id || "";
    userCache.set(token, { userId, expires: now + USER_CACHE_TTL_MS });
    return userId;
  } catch {
    return "";
  }
}

function friendlyMessage(bucket, retryAfterSec) {
  const minutes = Math.ceil(retryAfterSec / 60);
  const wait = minutes <= 1 ? `${retryAfterSec}s` : `${minutes} min`;
  switch (bucket) {
    case "render":
      return `You're submitting renders too quickly. Try again in ${wait}.`;
    case "checkout":
      return `Too many checkout attempts. Try again in ${wait}.`;
    case "curate":
      return `AI photo curation is rate-limited. Try again in ${wait}.`;
    case "regen":
      return `Per-scene regenerate is rate-limited. Try again in ${wait}.`;
    case "auth":
      return `Too many auth attempts. Try again in ${wait}.`;
    case "voice-demo":
      // Raw "try again in 478 min" read as broken (Troy). Long waits on a
      // daily demo cap just mean "tomorrow".
      return retryAfterSec > 3600
        ? "You've used today's voice demos — come back tomorrow, or sign up and clone your voice for real."
        : `One more demo unlocks in ${wait}.`;
    default:
      return `Too many requests. Try again in ${wait}.`;
  }
}
