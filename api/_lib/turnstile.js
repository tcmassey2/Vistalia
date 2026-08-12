// Cloudflare Turnstile server-side verification.
//
// v62.99 (security audit): /api/voice-demo wraps an unauthenticated,
// money-spending ElevenLabs clone+TTS on the public landing page. A CAPTCHA
// token is what actually stops a bot/proxy-pool from running up the bill —
// per-IP counters don't, because the pool rotates IPs and the in-memory
// bucket resets on every Vercel instance. Turnstile's site key already ships
// in /api/env; this verifies the token the widget produces against Cloudflare.
//
// Fail-open ONLY when unconfigured: if TURNSTILE_SECRET_KEY is unset (e.g. the
// window between deploying this code and adding the secret in Vercel), we skip
// verification so the live demo isn't bricked — the global spend ceiling still
// applies. Once the secret is set, a missing/invalid token fails CLOSED.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (!secret) {
    // Not configured yet — don't block. Caller still has the spend ceiling.
    return { ok: true, skipped: true };
  }
  if (!token || typeof token !== "string" || token.length > 4096) {
    return { ok: false, skipped: false, reason: "missing-token" };
  }
  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp) form.set("remoteip", remoteIp);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let data;
    try {
      const res = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: controller.signal
      });
      data = await res.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
    // Cloudflare returns { success: bool, "error-codes": [...] }.
    if (data && data.success === true) return { ok: true, skipped: false };
    return { ok: false, skipped: false, reason: (data && data["error-codes"] && data["error-codes"][0]) || "failed" };
  } catch {
    // Cloudflare unreachable. This endpoint spends third-party money, so we'd
    // rather turn a legitimate visitor away during a Turnstile outage than
    // leave the wallet open — fail CLOSED. (The verify has an 8s timeout.)
    return { ok: false, skipped: false, reason: "verify-unreachable" };
  }
}

// Pull the client IP the same way the rate limiter does, for remoteip.
export function clientIp(request) {
  const xff = String(request.headers["x-forwarded-for"] || "");
  return xff.split(",")[0].trim() || request.socket?.remoteAddress || "";
}
