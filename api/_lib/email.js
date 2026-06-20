// Shared Resend email sender for transactional notifications.
//
// Required env vars:
//   RESEND_API_KEY        — re_… secret from resend.com/api-keys
//   EMAIL_FROM            — verified sender, e.g. "Vistalia <noreply@estatemotion.ai>"
//   EMAIL_REPLY_TO        — optional, e.g. "support@estatemotion.ai"
//
// Why Resend over Postmark/Sendgrid: simplest API, free tier covers our
// expected volume (3,000/mo), and the React Email ecosystem they push
// gives us a path to richer templates later if we want.
//
// All functions silently no-op when RESEND_API_KEY is unset, so dev/test
// environments don't fail. They DO log a warning so missing config is
// caught in production.

const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendTransactionalEmail({ to, subject, html, text, replyTo, tags }) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.EMAIL_FROM || "Vistalia <noreply@estatemotion.ai>";
  const defaultReplyTo = process.env.EMAIL_REPLY_TO || "support@estatemotion.ai";

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
