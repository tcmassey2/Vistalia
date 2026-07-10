// Vistalia — /api/contact
//
// Receives the help-page contact form and forwards to support via Resend.
// Public endpoint (no auth) but rate-limited to prevent spam.

import { sendTransactionalEmail } from "./_lib/email.js";
import { rateLimit } from "./_lib/rate-limit.js";

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") return response.status(405).json({ error: "Use POST." });

  // 5 contact-form submissions per hour per IP. Honest users send 1; the
  // ceiling stops scripted form-spam without inconveniencing anyone real.
  const limited = await rateLimit(request, response, {
    bucket: "contact",
    max: 5,
    windowMs: 60 * 60 * 1000
  });
  if (limited) return;

  const body = parseBody(request.body);
  const email = String(body?.email || "").trim().slice(0, 200);
  const name = String(body?.name || "").trim().slice(0, 200);
  const subject = String(body?.subject || "").trim().slice(0, 200) || "Vistalia contact form";
  const message = String(body?.message || "").trim().slice(0, 4000);
  const honeypot = String(body?.website || "").trim();  // bot-trap field

  // Bot trap: honest browser users won't fill the hidden "website" field.
  // If it's populated, silently 200 so the bot thinks it succeeded.
  if (honeypot) {
    return response.status(200).json({ status: "ok" });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: "A valid email address is required." });
  }
  if (!message || message.length < 10) {
    return response.status(400).json({ error: "Tell us a bit more about what you need help with." });
  }

  const supportTo = process.env.SUPPORT_INBOX || "support@vistalia.ai";
  const safeName = escape(name || "(unnamed)");
  const safeEmail = escape(email);
  const safeSubject = escape(subject);
  const safeMessage = escape(message).replace(/\n/g, "<br>");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111;background:#fff;padding:24px;">
      <h2 style="margin:0 0 12px;font-size:18px;">New Vistalia contact form</h2>
      <p style="margin:4px 0;"><strong>From:</strong> ${safeName} &lt;${safeEmail}&gt;</p>
      <p style="margin:4px 0;"><strong>Subject:</strong> ${safeSubject}</p>
      <hr style="border:none;border-top:1px solid #ddd;margin:14px 0;">
      <div style="font-size:14px;line-height:1.6;">${safeMessage}</div>
    </div>
  `;

  const result = await sendTransactionalEmail({
    to: supportTo,
    subject: `[Contact] ${subject}`,
    html,
    replyTo: email,
    tags: ["contact-form"]
  });
  if (!result.ok && !result.skipped) {
    return response.status(500).json({ error: "We couldn't send the message. Email support@vistalia.ai directly." });
  }
  return response.status(200).json({ status: "ok" });
}

function escape(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch { return {}; }
}
