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

  // --- recent signups roster (founder-only; behind the same token) ---
  // GoTrue admin list is the guaranteed source of email + created_at;
  // meta_leads enriches with lead name/licensed; render_audit_log gives
  // the activation count. All best-effort — roster failures never break
  // the counters.
  let recent = [];
  try {
    const usersRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    const usersBody = await usersRes.json().catch(() => ({}));
    const users = (Array.isArray(usersBody?.users) ? usersBody.users : [])
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 25);

    const ids = users.map((u) => u.id).filter(Boolean);
    const emails = users.map((u) => String(u.email || "").toLowerCase()).filter(Boolean);
    const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const inList = (arr) => arr.map((v) => `"${v}"`).join(",");

    const [leadRows, renderRows, profileRows] = await Promise.all([
      emails.length
        ? fetch(`${supabaseUrl}/rest/v1/meta_leads?select=email,full_name,licensed&email=in.(${encodeURIComponent(inList(emails))})`, { headers: restHeaders })
            .then((r) => (r.ok ? r.json() : [])).catch(() => [])
        : [],
      ids.length
        ? fetch(`${supabaseUrl}/rest/v1/render_audit_log?select=agent_user_id&agent_user_id=in.(${encodeURIComponent(inList(ids))})&limit=1000`, { headers: restHeaders })
            .then((r) => (r.ok ? r.json() : [])).catch(() => [])
        : [],
      ids.length
        ? fetch(`${supabaseUrl}/rest/v1/profiles?select=user_id,tier,render_credits&user_id=in.(${encodeURIComponent(inList(ids))})`, { headers: restHeaders })
            .then((r) => (r.ok ? r.json() : [])).catch(() => [])
        : []
    ]);

    const leadByEmail = new Map((Array.isArray(leadRows) ? leadRows : []).map((l) => [String(l.email).toLowerCase(), l]));
    const renderCount = new Map();
    for (const r of Array.isArray(renderRows) ? renderRows : []) {
      renderCount.set(r.agent_user_id, (renderCount.get(r.agent_user_id) || 0) + 1);
    }
    const profileById = new Map((Array.isArray(profileRows) ? profileRows : []).map((p) => [p.user_id, p]));

    recent = users.map((u) => {
      const email = String(u.email || "").toLowerCase();
      const lead = leadByEmail.get(email);
      const prof = profileById.get(u.id);
      return {
        email,
        name: lead?.full_name || u.user_metadata?.full_name || "",
        created_at: u.created_at,
        source: lead ? "meta_lead" : "direct",
        licensed: lead ? lead.licensed : null,
        renders: renderCount.get(u.id) || 0,
        tier: prof?.tier || null,
        credits: prof?.render_credits ?? null
      };
    });
  } catch {
    recent = [];
  }

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
    paying: { subscribers: payingSubs, credit_holders: creditHolders },
    recent
  });
}
