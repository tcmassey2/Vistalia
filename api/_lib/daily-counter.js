// Durable per-day counter — the global spend ceiling behind /api/voice-demo.
//
// v62.99 (security audit): Turnstile stops the bots; this caps the absolute
// daily bill regardless. Even if a captcha farm solved challenges at scale,
// the endpoint can never fire more than N ElevenLabs clone+TTS pairs per UTC
// day. Env-tunable, defaults generous for real traffic at current scale.
//
// Backend: Upstash Redis REST when UPSTASH_REDIS_REST_URL + _TOKEN are set
// (a true global cap across all Vercel instances — the free tier is plenty).
// Without them it degrades to a per-instance in-memory counter: weaker under
// horizontal scale, but paired with Turnstile it's a real backstop, and it
// upgrades to the hard cap the moment the two env vars appear.

const mem = new Map(); // key -> { count, expires }

// UTC day stamp so the ceiling resets at midnight UTC. dayFn is injectable
// for tests; production passes nothing and uses the real clock.
export function dayKey(name, now) {
  const d = new Date(now == null ? Date.now() : now);
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${name}:${stamp}`;
}

function upstashConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function upstashCmd(pathParts) {
  const base = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const url = `${base}/${pathParts.map(encodeURIComponent).join("/")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && typeof data.result !== "undefined" ? data.result : null;
  } finally {
    clearTimeout(timer);
  }
}

// Reserve one slot for `name` today. Returns { count, exceeded, backend }.
// `count` is the running total AFTER this reservation. `exceeded` is true when
// this call pushed past `limit` (i.e. it should be rejected). On any backend
// error we FAIL OPEN (exceeded:false) — the ceiling is a backstop, not the
// primary control (Turnstile is), and we won't turn away real visitors over a
// Redis blip. TTL is one day so keys self-expire.
export async function reserveDaily(name, limit, now) {
  const key = dayKey(name, now);
  if (upstashConfigured()) {
    try {
      const count = await upstashCmd(["incr", key]);
      if (count === 1) await upstashCmd(["expire", key, "90000"]); // ~25h, covers the UTC day
      if (typeof count !== "number") return { count: 0, exceeded: false, backend: "upstash-error" };
      return { count, exceeded: count > limit, backend: "upstash" };
    } catch {
      return { count: 0, exceeded: false, backend: "upstash-error" };
    }
  }
  // In-memory fallback.
  const t = now == null ? Date.now() : now;
  const entry = mem.get(key);
  if (!entry || entry.expires <= t) {
    // New day / fresh key. Prune anything stale while we're here.
    for (const [k, v] of mem) if (v.expires <= t) mem.delete(k);
    mem.set(key, { count: 1, expires: t + 25 * 60 * 60 * 1000 });
    return { count: 1, exceeded: 1 > limit, backend: "memory" };
  }
  entry.count += 1;
  return { count: entry.count, exceeded: entry.count > limit, backend: "memory" };
}

// Give a reserved slot back when the spend failed on OUR side (provider 5xx),
// so a run of upstream hiccups doesn't burn the day's ceiling. Best-effort.
export async function releaseDaily(name, now) {
  const key = dayKey(name, now);
  if (upstashConfigured()) {
    try { await upstashCmd(["decr", key]); } catch { /* best-effort */ }
    return;
  }
  const entry = mem.get(key);
  if (entry && entry.count > 0) entry.count -= 1;
}

// Test seam only.
export function __resetMemory() { mem.clear(); }
