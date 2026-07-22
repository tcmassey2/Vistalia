// Shared Resend email sender for transactional notifications.
//
// Required env vars:
//   RESEND_API_KEY        — re_… secret from resend.com/api-keys
//   EMAIL_FROM            — verified sender, e.g. "Vistalia <noreply@vistalia.ai>"
//   EMAIL_REPLY_TO        — optional, e.g. "support@vistalia.ai"
//
// Why Resend over Postmark/Sendgrid: simplest API, free tier covers our
// expected volume (3,000/mo), and the React Email ecosystem they push
// gives us a path to richer templates later if we want.
//
// All functions silently no-op when RESEND_API_KEY is unset, so dev/test
// environments don't fail. They DO log a warning so missing config is
// caught in production.

const RESEND_API_URL = "https://api.resend.com/emails";

// v54.1 — signed one-click opt-out. The token is an HMAC of the user id
// keyed on the service-role secret: unguessable without the key, stateless
// to verify, and it never exposes the key itself. api/email-opt-out.js
// verifies it and flips profiles.email_opt_out; every lead-flow email
// checks that flag before sending.
import crypto from "crypto";
export function optOutToken(userId) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.CRON_SECRET || "vistalia-dev";
  return crypto.createHmac("sha256", key).update(`optout:${String(userId)}`).digest("hex").slice(0, 32);
}
export function optOutUrl(userId) {
  const base = process.env.APP_URL || "https://vistalia.ai";
  return `${base}/api/email-opt-out?u=${encodeURIComponent(String(userId))}&t=${optOutToken(userId)}`;
}

export async function sendTransactionalEmail({ to, subject, html, text, replyTo, tags, headers }) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.EMAIL_FROM || "Vistalia <noreply@vistalia.ai>";
  const defaultReplyTo = process.env.EMAIL_REPLY_TO || "support@vistalia.ai";

  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY missing — skipping send to", to, "subject:", subject);
    return { ok: false, skipped: true, reason: "RESEND_API_KEY not configured" };
  }
  if (!to) {
    return { ok: false, skipped: true, reason: "no recipient" };
  }

  const body = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: text || stripHtml(html),
    reply_to: replyTo || defaultReplyTo
  };
  if (headers && typeof headers === "object") {
    // v54.1: Resend passes custom headers through — used for
    // List-Unsubscribe / List-Unsubscribe-Post so Gmail renders its native
    // unsubscribe affordance instead of the spam button.
    body.headers = headers;
  }
  if (Array.isArray(tags) && tags.length) {
    // Resend uses {name, value} pairs for tags. Use ours for analytics in
    // their dashboard (filter by template, e.g. "trial-ending-3-day").
    body.tags = tags.map((t) =>
      typeof t === "string" ? { name: "template", value: t } : t
    );
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.message || json?.error || `Resend ${res.status}`;
      console.warn("[email] Resend rejected:", msg, "subject:", subject);
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true, id: json?.id };
  } catch (err) {
    console.warn("[email] Resend threw:", err.message || err, "subject:", subject);
    return { ok: false, error: err.message || "send failed" };
  }
}

// Trim HTML to a plaintext fallback. Email clients that block HTML still
// see the message — most don't, but it's good hygiene and helps deliverability.
function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
