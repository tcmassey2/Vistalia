// Vistalia — /api/welcome-email
//
// v46: email confirmation no longer gates signin (launch decision), which
// means Supabase sends NOTHING at signup — the confirm email was the only
// signup email it had. This endpoint restores the first inbox touch: the
// webapp fires it (fire-and-forget) right after a signup that returns a
// live session, and we send the branded welcome via Resend.
//
// Abuse posture:
//   - Requires the caller's own fresh Supabase JWT (no anonymous sends).
//   - One-shot per account: app_metadata.welcome_sent set via the admin
//     API after a successful send; repeat calls no-op.
//   - Fresh-account guard: accounts older than 1 hour never trigger a
//     send (an old session poking the endpoint gets a no-op, not email).
//   - Rate limited per IP as a backstop.
//   - Silently no-ops without RESEND_API_KEY (dev/staging).

import { sendTransactionalEmail } from "./_lib/email.js";
import { welcomeEmail } from "./_lib/email-templates.js";
import { rateLimit } from "./_lib/rate-limit.js";

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Use POST /api/welcome-email." });
  }

  const limited = await rateLimit(request, response, {
    bucket: "welcome-email",
    max: 10,
    windowMs: 60 * 60 * 1000
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
  const userId = me?.id;
  const email = String(me?.email || "");
  if (!userId || !email) {
    return response.status(401).json({ error: "Authentication invalid." });
  }

  // One-shot: already welcomed → no-op.
  if (me?.app_metadata?.welcome_sent) {
    return response.status(200).json({ status: "skipped", reason: "already sent" });
  }

  // Fresh-account guard: only accounts created in the last hour qualify.
  const createdAt = Date.parse(me?.created_at || "") || 0;
  if (!createdAt || Date.now() - createdAt > 60 * 60 * 1000) {
    return response.status(200).json({ status: "skipped", reason: "account not fresh" });
  }

  // Mark BEFORE sending — if two tabs race, the second send is the only
  // duplicate risk, and a flag-first order caps it at one extra email in
  // the worst case while guaranteeing the flag always lands.
  const markRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ app_metadata: { ...(me.app_metadata || {}), welcome_sent: true } })
  });
  if (!markRes.ok) {
    const detail = await markRes.text().catch(() => "");
    console.warn("[welcome-email] flag write failed:", markRes.status, detail.slice(0, 160));
    // Still attempt the send — a missing flag means a possible duplicate
    // later, which beats a silent no-email signup.
  }

  const { subject, html } = welcomeEmail({ email });
  const sent = await sendTransactionalEmail({
    to: email,
    subject,
    html,
    tags: ["welcome"]
  });

  if (!sent.ok && !sent.skipped) {
    console.warn("[welcome-email] send failed:", sent.error || "unknown");
    return response.status(200).json({ status: "failed", error: sent.error || "send failed" });
  }
  return response.status(200).json({ status: sent.skipped ? "skipped" : "sent" });
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
