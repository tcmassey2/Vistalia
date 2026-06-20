// Vistalia — /api/notify-render-complete
//
// Called by the render-worker when a render finishes successfully. Sends
// a "your video is ready" email to the agent with the master URL +
// thumbnail. The worker doesn't talk to Resend directly because we want
// email keys to live only on Vercel, not on the render-worker host.
//
// Auth: requires the RENDER_WEBHOOK_SECRET (same secret the worker uses
// for /api/render). Vercel-side enforcement keeps a random caller from
// spamming our users.

import { sendTransactionalEmail } from "./_lib/email.js";
import { renderComplete } from "./_lib/email-templates.js";

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") return response.status(405).json({ error: "Use POST." });

  const secret = process.env.RENDER_WEBHOOK_SECRET || process.env.RENDER_WORKER_SECRET || "";
  if (secret) {
    const auth = String(request.headers.authorization || "");
    if (auth !== `Bearer ${secret}`) {
      return response.status(401).json({ error: "Unauthorized" });
    }
  }

  const body = parseBody(request.body);
  const userId = String(body?.userId || "").trim();
  const jobId = String(body?.jobId || "").trim();
  const mp4Url = String(body?.mp4Url || "").trim();
  const thumbnailUrl = String(body?.thumbnailUrl || "").trim();
  const listingTitle = String(body?.listingTitle || "Your listing video").trim();

  if (!userId || !jobId || !mp4Url) {
    return response.status(400).json({ error: "userId, jobId, and mp4Url required." });
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    return response.status(503).json({ error: "Supabase not configured." });
  }

  // Look up the user's email from profiles (worker only knows the userId).
  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=email`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  if (!profileRes.ok) {
    return response.status(500).json({ error: "Profile lookup failed." });
  }
  const rows = await profileRes.json().catch(() => []);
  const email = Array.isArray(rows) && rows.length ? rows[0]?.email : "";
  if (!email) {
    return response.status(404).json({ error: "User email not found." });
  }

  const tpl = renderComplete({ email, listingTitle, mp4Url, thumbnailUrl, jobId });
  const result = await sendTransactionalEmail({
    to: email,
    subject: tpl.subject,
    html: tpl.html,
    tags: ["render-complete"]
  });

  if (!result.ok && !result.skipped) {
    return response.status(500).json({ error: result.error || "Email send failed." });
  }
  return response.status(200).json({
    status: "ok",
    sent: result.ok === true,
    skipped: result.skipped || false,
    to: email
  });
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
