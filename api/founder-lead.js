// Vistalia — /api/founder-lead (v62.97, the baby CRM).
//
// One lead, the whole story: where they came from (form + ad ids off the
// raw Meta payload), what they typed into the form (every field_data
// answer, the listing link/address included), every automated touch
// (welcome, nudge, auto-render status with its retry/terminal reason),
// whether TROY has contacted them (new meta_leads.contacted_at /
// contact_note — migration 39), their account activity (created, last
// sign-in, tier, credits), and every render with a playable link.
//
// GET  ?email=<email>            → the dossier
// POST {email, contacted, note}  → founder contact tracking
//
// Same static-bearer gate as /api/metrics (METRICS_TOKEN in Troy's
// browser). Service-role key never leaves the server. Everything is
// best-effort: a missing table or un-applied migration degrades that
// section, never the endpoint (crm.ready says whether migration 39 is
// live so the portal can show the exact SQL to run).

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") return response.status(204).end();

  const token = process.env.METRICS_TOKEN || "";
  if (!token) return response.status(503).json({ error: "METRICS_TOKEN not configured" });
  if (String(request.headers.authorization || "") !== `Bearer ${token}`) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) return response.status(503).json({ error: "Supabase env missing" });
  const rest = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  /* ── v62.100: photos-used for a render (the re-render helper) ─────────────
     GET ?render_photos=<jobId> → the deduped source photos that went into a
     render, plus its listing context, so Troy can pull them from the founder
     portal and rebuild a listing (e.g. a make-right redo) without hunting
     through Supabase. No email needed — the job id is unique. Same
     METRICS_TOKEN gate as everything else here. */
  if (request.method === "GET" && request.query?.render_photos) {
    const jobId = String(request.query.render_photos).slice(0, 200);
    try {
      const rows = await fetch(
        `${supabaseUrl}/rest/v1/render_audit_log?select=job_id,listing_address,listing_city,listing_price,project_title,render_config,scenes&job_id=eq.${encodeURIComponent(jobId)}&limit=1`,
        { headers: rest }
      ).then((r) => (r.ok ? r.json() : []));
      const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!row) return response.status(200).json({ status: "no_render", photos: [], context: null });
      const scenes = Array.isArray(row.scenes) ? row.scenes : [];
      const seen = new Set();
      const photos = [];
      for (const s of scenes) {
        const url = s && (s.photoUrl || s.photo_url || s.url);
        if (url && typeof url === "string" && !seen.has(url)) {
          seen.add(url);
          photos.push({ url, room: String(s.roomType || s.room_type || "").slice(0, 40) });
        }
      }
      const rc = row.render_config || {};
      return response.status(200).json({
        status: "ok",
        job_id: row.job_id,
        photos,
        context: {
          address: row.listing_address || "",
          city: row.listing_city || "",
          price: row.listing_price || "",
          title: row.project_title || "",
          style: rc.selectedStyle || "",
          music: rc.musicMood || rc.musicTrack || ""
        }
      });
    } catch (err) {
      return response.status(200).json({ status: "failed", error: String(err?.message || err).slice(0, 160), photos: [] });
    }
  }

  const email = String(
    (request.method === "POST" ? request.body?.email : request.query?.email) || ""
  ).trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || email.length > 200) {
    return response.status(400).json({ error: "A valid email is required." });
  }
  // v62.97.2: PostgREST treats double quotes in SCALAR filters as literal
  // characters (verified against a live PostgREST 13 — eq."x@y.com" matches
  // nothing, and eq."uuid" 400s on uuid columns). Quotes belong only inside
  // in.(...) lists, which is what metrics.js correctly does. Plain encode.
  const emailFilter = encodeURIComponent(email);

  /* ── POST: founder contact tracking ─────────────────────────────────── */
  if (request.method === "POST") {
    const contacted = request.body?.contacted === true;
    const note = String(request.body?.note || "").slice(0, 2000);
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/meta_leads?email=eq.${emailFilter}`,
        {
          method: "PATCH",
          headers: { ...rest, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({
            contacted_at: contacted ? new Date().toISOString() : null,
            contact_note: note
          })
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Un-applied migration 39 → PostgREST names the missing column.
        if (/contacted_at|contact_note/.test(body)) {
          return response.status(200).json({ status: "migration_needed", migration: "39_meta_leads_crm.sql" });
        }
        return response.status(200).json({ status: "failed", error: body.slice(0, 160) });
      }
      const rows = await res.json().catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) {
        return response.status(200).json({ status: "no_lead_row" }); // direct signup — nothing to mark
      }
      return response.status(200).json({ status: "ok", contacted_at: rows[0]?.contacted_at || null });
    } catch (err) {
      return response.status(200).json({ status: "failed", error: String(err?.message || err).slice(0, 160) });
    }
  }

  if (request.method !== "GET") return response.status(405).json({ error: "GET or POST" });

  /* ── GET: the dossier ───────────────────────────────────────────────── */
  const out = {
    email,
    lead: null,          // meta_leads row highlights
    came_from: null,     // form/ad provenance off the raw payload
    answers: [],         // every field_data Q&A as typed
    touches: {},         // welcome/nudge/auto-render machine touches
    crm: { ready: false, contacted_at: null, note: "" },
    account: null,       // GoTrue + profile
    renders: [],         // audit rows, newest first
    failed_jobs: []      // early-death render_jobs the audit never saw
  };

  // 1. The lead row (select=* so pre-migration schemas still answer).
  let lead = null;
  try {
    const rows = await fetch(
      // nullslast: the sync writes created_time null when Meta omits it, and
      // plain desc puts NULLs FIRST — a null row would shadow the real latest.
      `${supabaseUrl}/rest/v1/meta_leads?select=*&email=eq.${emailFilter}&order=created_time.desc.nullslast&limit=1`,
      { headers: rest }
    ).then((r) => (r.ok ? r.json() : []));
    lead = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { /* direct signups have no lead row */ }

  if (lead) {
    out.lead = {
      lead_id: lead.lead_id || null,
      full_name: lead.full_name || "",
      licensed: lead.licensed ?? null,
      listing_url: lead.listing_url || "",
      created_time: lead.created_time || lead.inserted_at || null,
      user_created: lead.user_created === true,
      user_id: lead.user_id || null
    };
    out.touches = {
      welcomed_at: lead.emailed_at || null,
      nudged_at: lead.nudged_at || null,
      auto_render_status: lead.auto_render_status || null,
      auto_render_attempts: lead.auto_render_attempts ?? null,
      auto_render_at: lead.auto_render_at || null
    };
    out.crm = {
      ready: "contacted_at" in lead,
      contacted_at: lead.contacted_at || null,
      note: lead.contact_note || ""
    };
    // Provenance + answers, defensively parsed from the raw Meta payload.
    try {
      const raw = typeof lead.raw === "string" ? JSON.parse(lead.raw) : (lead.raw || {});
      out.came_from = {
        form_id: raw.form_id || raw.formId || null,
        ad_id: raw.ad_id || raw.adId || null,
        adset_id: raw.adgroup_id || raw.adset_id || null,
        campaign_id: raw.campaign_id || null,
        platform: raw.platform || null
      };
      const fields = Array.isArray(raw.field_data) ? raw.field_data : [];
      out.answers = fields.map((f) => ({
        q: String(f?.name || "").replace(/_/g, " ").slice(0, 120),
        a: Array.isArray(f?.values) ? String(f.values[0] || "").slice(0, 500) : ""
      })).filter((x) => x.q);
    } catch { /* raw is a bonus */ }
  }

  // 2. Account: prefer the lead's user_id; fall back to a roster scan for
  // direct signups. Then the profile row for tier/credits.
  let userId = lead?.user_id || null;
  let user = null;
  try {
    if (userId) {
      user = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: rest })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    if (!user) {
      const usersBody = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, { headers: rest })
        .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      user = (Array.isArray(usersBody?.users) ? usersBody.users : [])
        .find((u) => String(u.email || "").toLowerCase() === email) || null;
      if (user) userId = user.id;
    }
  } catch { /* account section degrades */ }

  if (user) {
    let profile = null;
    try {
      const profRows = await fetch(
        `${supabaseUrl}/rest/v1/profiles?select=tier,render_credits,created_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
        { headers: rest }
      ).then((r) => (r.ok ? r.json() : []));
      profile = Array.isArray(profRows) && profRows[0] ? profRows[0] : null;
    } catch { /* profile optional */ }
    out.account = {
      user_id: userId,
      created_at: user.created_at || null,
      last_sign_in_at: user.last_sign_in_at || null,
      tier: profile?.tier || null,
      credits: profile?.render_credits ?? null
    };
  }

  // 3. Renders + early-death jobs.
  if (userId) {
    const idFilter = encodeURIComponent(userId);
    try {
      const rows = await fetch(
        `${supabaseUrl}/rest/v1/render_audit_log?select=job_id,listing_address,listing_city,project_title,engine,status,narration_applied,master_mp4_url,thumbnail_url,created_at,internal&agent_user_id=eq.${idFilter}&order=created_at.desc&limit=12`,
        { headers: rest }
      ).then((r) => (r.ok ? r.json() : []));
      out.renders = (Array.isArray(rows) ? rows : []).map((r) => ({
        job_id: r.job_id,
        title: r.listing_address || r.project_title || "Untitled listing",
        city: r.listing_city || "",
        engine: r.engine || "",
        status: r.status || "completed",
        narrated: Boolean(r.narration_applied),
        mp4_url: r.master_mp4_url || "",
        thumbnail_url: r.thumbnail_url || "",
        created_at: r.created_at,
        internal: r.internal === true
      }));
    } catch { /* renders section degrades */ }
    try {
      const auditIds = new Set(out.renders.map((r) => r.job_id));
      const failed = await fetch(
        `${supabaseUrl}/rest/v1/render_jobs?select=job_id,status,error,created_at&user_id=eq.${idFilter}&status=neq.completed&order=created_at.desc&limit=5`,
        { headers: rest }
      ).then((r) => (r.ok ? r.json() : []));
      out.failed_jobs = (Array.isArray(failed) ? failed : [])
        .filter((f) => !auditIds.has(f.job_id))
        .map((f) => ({
          job_id: f.job_id,
          status: f.status || "",
          error: String(f.error || "").slice(0, 200),
          created_at: f.created_at
        }));
    } catch { /* failures list is a bonus */ }
  }

  return response.status(200).json(out);
}
