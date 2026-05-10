// EstateMotion — Render library.
//
// GET /api/library  → returns the signed-in user's past renders, newest first.
//
// Source of truth is the render_audit_log table (one row per completed
// render, written by the worker). If the table doesn't exist yet (the
// brokerage migration hasn't been applied), we return an empty list with
// a helpful warning rather than 500ing.
//
// All requests require a Supabase JWT in Authorization: Bearer <token>.
// We use the service role key to query the audit log so we can bypass
// RLS and apply our own scoping (agent_user_id = caller's id).

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

export default async function handler(request, response) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method !== "GET") {
    response.status(405).json({ status: "failed", error: "Use GET /api/library." });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    response.status(503).json({
      status: "failed",
      error: "Library is unavailable: Supabase env vars missing on server."
    });
    return;
  }

  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    response.status(401).json({ status: "failed", error: "Sign in required." });
    return;
  }
  const token = auth.slice(7);

  try {
    // Resolve the caller's user id.
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) {
      response.status(401).json({ status: "failed", error: "Authentication invalid or expired." });
      return;
    }
    const userPayload = await userRes.json().catch(() => ({}));
    const userId = userPayload?.id;
    if (!userId) {
      response.status(401).json({ status: "failed", error: "Authentication invalid." });
      return;
    }

    const url = new URL(request.url || "", "http://localhost");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));

    // Query the audit log scoped to this agent. Order newest first.
    // Only show completed renders (we don't want failed/in-progress noise).
    const queryUrl =
      `${SUPABASE_URL}/rest/v1/render_audit_log` +
      `?agent_user_id=eq.${encodeURIComponent(userId)}` +
      `&status=eq.completed` +
      `&master_mp4_url=neq.` +
      `&order=created_at.desc` +
      `&limit=${limit}&offset=${offset}` +
      `&select=*`;

    const auditRes = await fetch(queryUrl, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      }
    });

    if (!auditRes.ok) {
      const body = await auditRes.text().catch(() => "");
      // Audit table doesn't exist yet — graceful empty state with hint.
      if (auditRes.status === 404 && /PGRST205|Could not find the table/i.test(body)) {
        response.status(200).json({
          status: "ok",
          library: [],
          note: "Render history will start appearing here after you apply supabase/migrations/04_brokerages.sql in your Supabase project."
        });
        return;
      }
      throw new Error(`Audit log fetch failed (${auditRes.status}): ${body.slice(0, 200)}`);
    }

    const rows = await auditRes.json().catch(() => []);
    response.status(200).json({
      status: "ok",
      library: rows.map((row) => ({
        id: row.id,
        jobId: row.job_id,
        engine: row.engine,
        listingAddress: row.listing_address || "",
        listingCity: row.listing_city || "",
        listingPrice: row.listing_price || "",
        projectTitle: row.project_title || row.listing_address || "Untitled listing",
        mp4Url: row.master_mp4_url || "",
        thumbnailUrl: row.thumbnail_url || "",
        socialShortCount: Number(row.social_short_count || 0),
        formatsCount: Number(row.formats_count || 1),
        narrationApplied: Boolean(row.narration_applied),
        createdAt: row.created_at
      })),
      pagination: { limit, offset, returned: rows.length }
    });
  } catch (error) {
    response.status(500).json({
      status: "failed",
      error: error.message || "Library request failed."
    });
  }
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
