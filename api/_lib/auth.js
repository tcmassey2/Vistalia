// Shared auth guard for /api/* endpoints.
//
// requireUser(request, response) — validates the Supabase JWT from the
// Authorization header. Returns { ok: true, userId } on success, or sends
// a 401 and returns { ok: false } so the caller can simply `return`.
//
// Soft-pass behavior: when Supabase env vars are absent (local dev / mock
// mode / demo deploys), we allow the request through with userId: null.
// This mirrors the tier-guard behavior in render.js — auth enforcement
// activates the moment Supabase is configured, and never blocks a deploy
// that doesn't have it.
//
// Usage:
//   import { requireUser } from "./_lib/auth.js";
//   ...
//   const auth = await requireUser(request, response);
//   if (!auth.ok) return; // 401 already sent
//   // auth.userId is the Supabase user id (or null in soft-pass mode)

const userCache = new Map();
const USER_CACHE_TTL_MS = 60_000;
const USER_CACHE_MAX = 5000;

export async function requireUser(request, response) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";

  // Soft-pass: Supabase not configured → dev/mock mode, allow.
  if (!supabaseUrl || !anonKey) {
    return { ok: true, userId: null, softPass: true };
  }

  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    response.status(401).json({
      status: "failed",
      error: "Sign in to use this feature.",
      authRequired: true
    });
    return { ok: false };
  }

  const token = auth.slice(7);
  const userId = await resolveUserId(token, supabaseUrl, anonKey);
  if (!userId) {
    response.status(401).json({
      status: "failed",
      error: "Authentication expired. Sign in again.",
      authRequired: true
    });
    return { ok: false };
  }

  return { ok: true, userId };
}

async function resolveUserId(token, supabaseUrl, anonKey) {
  const now = Date.now();
  const cached = userCache.get(token);
  if (cached && cached.expires > now) return cached.userId;

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    const userId = data?.id || "";
    if (userId) {
      if (userCache.size >= USER_CACHE_MAX) userCache.clear();
      userCache.set(token, { userId, expires: now + USER_CACHE_TTL_MS });
    }
    return userId;
  } catch {
    // Supabase auth endpoint unreachable. Fail CLOSED here — unlike the
    // tier guard (where a false reject costs a paying customer a render),
    // these endpoints burn third-party credits, so we'd rather 401 a real
    // user during a Supabase blip than leave the wallet open.
    return "";
  }
}
