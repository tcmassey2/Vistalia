// Vistalia — one-click email opt-out (v54.1).
//
// GET/POST /api/email-opt-out?u=<user_id>&t=<hmac>
//
// The link lives in the footer of every lead-flow email and in the
// List-Unsubscribe header (Gmail one-click sends a POST — both methods
// land here and do the same thing). The token is HMAC-SHA256 of the user
// id keyed on the service-role secret (see optOutToken in _lib/email.js):
// stateless, unguessable, and revocable only by rotating the key.
//
// Flips profiles.email_opt_out = true and confirms with a small branded
// page. Idempotent — clicking twice is fine. Invalid or missing token
// gets a 400 with no detail (don't teach enumeration).

import crypto from "crypto";
import { optOutToken } from "./_lib/email.js";

export default async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const userId = String(request.query?.u || "").trim();
  const token = String(request.query?.t || "").trim();
  if (!userId || !token || token.length !== 32) {
    return response.status(400).send("Invalid link.");
  }
  const expected = optOutToken(userId);
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return response.status(400).send("Invalid link.");
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    return response.status(503).send("Temporarily unavailable.");
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ email_opt_out: true })
    }
  );
  if (!res.ok) {
    console.warn("[email-opt-out] PATCH failed:", res.status);
    return response.status(500).send("Something went wrong — email support@vistalia.ai and we'll sort it by hand.");
  }

  response.setHeader("Content-Type", "text/html; charset=utf-8");
  return response.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Vistalia</title></head>
<body style="margin:0;background:#0E0E10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#E8E2D6;display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="max-width:420px;padding:48px 32px;text-align:center;">
    <div style="display:inline-block;width:40px;height:40px;border-radius:10px;background:#0B0B0D;border:1.5px solid #C7A76C;line-height:37px;font-weight:600;color:#E6CE8E;font-size:22px;font-family:Georgia,serif;margin-bottom:24px;">V</div>
    <h1 style="margin:0 0 12px;font-size:24px;font-weight:600;color:#F5F0E2;">You won't hear from us again.</h1>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#B5AC9A;">Done — no more emails. Your account and your free listing video stay right where they are if you ever want them.</p>
  </div>
</body></html>`);
}
