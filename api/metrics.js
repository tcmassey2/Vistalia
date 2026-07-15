// Vistalia — /api/metrics
//
// Read-only funnel counters for the founder dashboard (Cowork artifact).
// Everything is a COUNT — no emails, no names, no lead rows leave this
// endpoint. Auth is a static bearer (METRICS_TOKEN env) that lives in
// Troy's dashboard localStorage, so a leaked URL alone shows nothing.
//
// "Today" = since midnight America/Phoenix (UTC-7, no DST).

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "GET") return response.status(405).json({ error: "GET only" });

  const token = process.env.METRICS_TOKEN || "";
  if (!token) return response.status(503).json({ error: "METRICS_TOKEN not configured" });
  if (String(request.headers.authorization || "") !== `Bearer ${token}`) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return response.status(503).json({ error: "Supabase env missing" });

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Prefer: "count=exact",
    Range: "0-0"
  };

  // PostgREST: Range + count=exact → Content-Range "0-0/N". null = table or
  // column missing; the dashboard renders those as "—" instead of erroring.
  async function count(pathAndQuery) {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, { headers });
      if (!res.ok && res.status !== 206) return null;
      const range = res.headers.get("content-range") || "";
      const total = Number(range.split("/")[1]);
      return Number.isFinite(total) ? total : null;
    } catch {
      return null;
    }
  }

  // Midnight in Phoenix (UTC-7 fixed), expressed as UTC ISO.
  const nowUtcMs = Date.now();
  const phx = new Date(nowUtcMs - 7 * 3600 * 1000);
  phx.setUTCHours(0, 0, 0, 0);
  const midnight = new Date(phx.getTime() + 7 * 3600 * 1000).toISOString();
  const enc = encodeURIComponent(midnight);

  const [
    leadsTotal, leadsToday, leadsEmailed, leadsNudged, leadsCreatedUsers,
    rendersTotal, rendersToday,
    usersTotal, usersToday,
    payingSubs, creditHolders
  ] = await Promise.all([
    count(`meta_leads?select=lead_id`),
    count(`meta_leads?select=lead_id&inserted_at=gte.${enc}`),
    count(`meta_leads?select=lead_id&emailed_at=not.is.null`),
    count(`meta_leads?select=lead_id&nudged_at=not.is.null`),
    count(`meta_leads?select=lead_id&user_created=is.true`),
    count(`render_audit_log?select=job_id`),
    count(`render_audit_log?select=job_id&created_at=gte.${enc}`),
    count(`profiles?select=user_id`),
    count(`profiles?select=user_id&created_at=gte.${enc}`),
    count(`profiles?select=user_id&tier=in.(pro,studio)`),
    count(`profiles?select=user_id&render_credits=gt.0`)
  ]);

  return response.status(200).json({
    generated_at: new Date().toISOString(),
    day_started_at: midnight,
    leads: {
      total: leadsTotal,
      today: leadsToday,
      emailed: leadsEmailed,
      nudged: leadsNudged,
      accounts_created: leadsCreatedUsers
    },
    renders: { total: rendersTotal, today: rendersToday },
    users: { total: usersTotal, today: usersToday },
    paying: { subscribers: payingSubs, credit_holders: creditHolders }
  });
}
