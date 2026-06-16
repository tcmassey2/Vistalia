// EstateMotion — usage / tier state lookup.
// GET /api/usage  with Authorization: Bearer <Supabase JWT>
// Returns: { tier, monthly_video_quota, videos_used_this_month, available_engines, can_render, reason, render_credits }
//
// The frontend calls this to render the dashboard meter and gate the "Render"
// button. /api/render also calls the same RPC server-side as a hard guard.

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "GET") return response.status(405).json({ error: "Use GET." });

  const userId = await verifyUserId(request);
  if (!userId) return response.status(401).json({ error: "Sign in to view usage." });

  try {
    const state = await fetchTierState(userId);
    return response.status(200).json(state);
  } catch (error) {
    console.error("[usage] error", { message: error.message });
    return response.status(500).json({ error: error.message || "Usage lookup failed." });
  }
}

export async function fetchTierState(userId) {
  const res = await supabaseAdmin(
    `rpc/get_user_tier_state`,
    "POST",
    { p_user_id: userId }
  );
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    return {
      tier: "trial",
      monthly_video_quota: 1,
      videos_used_this_month: 0,
      available_engines: ["remotion", "veo"],
      can_render: true,
      reason: null,
      render_credits: 0
    };
  }
  return row;
}

export async function verifyUserId(request) {
  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return "";
  const token = auth.slice(7);
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !anonKey) return "";
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return "";
  const data = await res.json().catch(() => ({}));
  return data?.id || "";
}

async function supabaseAdmin(pathAndQuery, method, body) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase admin env vars missing.");
  const init = {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    }
  };
  if (body && method !== "GET") init.body = JSON.stringify(body);
  return fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, init);
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
