// Vistalia — /api/send-desktop-link
//
// The mobile → desktop handoff. Instant Form leads arrive on their phones,
// but listing photos live on their computers — so the empty-state card in
// the app offers "email me a link for my computer." This endpoint sends the
// signed-in caller a fresh magic link at their own address.
//
// Why server-side instead of client signInWithOtp: Turnstile captcha is
// enforced on client auth calls, and mounting a captcha inside a one-tap
// card kills the one-tap. The admin generate_link path (same plumbing as
// the lead welcome/nudge emails) needs no captcha and lets us send the
// branded desktopLinkEmail instead of the bare Supabase template.
//
// Abuse posture:
//   - Requires the caller's own fresh Supabase JWT (no anonymous sends).
//   - Mails ONLY the authenticated user's own verified address — the
//     recipient is never caller-controlled.
//   - Rate limited: 3 sends per 30 min per user/IP.

import { sendTransactionalEmail } from "./_lib/email.js";
import { desktopLinkEmail } from "./_lib/email-templates.js";
import { rateLimit } from "./_lib/rate-limit.js";

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Use POST /api/send-desktop-link." });
  }

  const limited = await rateLimit(request, response, {
    bucket: "desktop-link",
    max: 3,
    windowMs: 30 * 60 * 1000
  });
  if (limited) return;

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return response.status(200).json({ status: "skipped", reason: "auth not configured" });
  }

  // Identify the caller from their own bearer token.
  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    return response.status(401).json({ error: "Sign in required." });
  }
  const meRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: auth }
  });
  if (!meRes.ok) {
    return response.status(401).json({ error: "Authentication expired." });
  }
  const me = await meRes.json().catch(() => ({}));
  const email = String(me?.email || "");
  if (!me?.id || !email) {
    return response.status(401).json({ error: "Authentication invalid." });
  }

  // Fresh magic link for the caller's own address. Same admin path the
  // lead welcome email uses; honors the project-level OTP expiry (24h).
  let magicLink = "";
  const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: "magiclink",
      email,
      // Top-level redirect_to — the REST admin API ignores options.redirect_to.
      redirect_to: `${process.env.APP_URL || "https://vistalia.ai"}/app/`
    })
  });
  if (linkRes.ok) {
    const link = await linkRes.json().catch(() => ({}));
    magicLink = link?.action_link || link?.properties?.action_link || "";
  } else {
    const detail = await linkRes.text().catch(() => "");
    console.error("[send-desktop-link] generate_link failed:", linkRes.status, detail.slice(0, 160));
  }
  if (!magicLink) {
    // Fail loudly — a link-less handoff email is worse than an error the
    // card can surface ("try again").
    return response.status(502).json({ status: "failed", error: "Couldn't create a sign-in link. Try again." });
  }

  const { subject, html } = desktopLinkEmail({ email, magicLink });
  const sent = await sendTransactionalEmail({
    to: email,
    subject,
    html,
    tags: ["desktop-link"]
  });

  if (!sent.ok && !sent.skipped) {
    console.error("[send-desktop-link] send failed:", sent.error || "unknown");
    return response.status(502).json({ status: "failed", error: "Couldn't send the email. Try again." });
  }
  return response.status(200).json({ status: sent.skipped ? "skipped" : "sent", email });
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
