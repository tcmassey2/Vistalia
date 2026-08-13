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
// POST {action:"re_render", job_id} → v62.110: re-render a customer's video
//      TO THEIR ACCOUNT on the current engine (the make-right button).
//      Photos + context come from the original render's audit row; the plan
//      runs on-behalf (x-canary-secret) and the submit goes through
//      /api/render's front door with founderComp — so the customer's tier
//      machinery runs exactly as if THEY clicked Generate (trial ⇒
//      watermark + clean master retained ⇒ the unlock purchase stays
//      correct), except the spend gate and usage bump are waived. The
//      render-complete email delivers to the customer as usual.
//
// Same static-bearer gate as /api/metrics (METRICS_TOKEN in Troy's
// browser). Service-role key never leaves the server. Everything is
// best-effort: a missing table or un-applied migration degrades that
// section, never the endpoint (crm.ready says whether migration 39 is
// live so the portal can show the exact SQL to run).

// v62.110: the re_render action waits on a full plan build (the plan
// endpoint's own ceiling is 120s) plus the queue submit — a default
// function window would kill it mid-plan.
export const config = { maxDuration: 300 };

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

  /* ── v62.110: POST {action:"re_render", job_id} — the make-right button.
     Rebuilds the customer's video on the CURRENT engine, into THEIR
     account. Sequence mirrors the worker's lead-auto-render lane (the
     proven server-side path): audit row → photos + context → on-behalf
     plan → front-door submit as the customer with founderComp. Tier
     machinery runs as them (watermark/clean-master/unlock all correct by
     construction); the comp flag only waives the spend gate + usage bump.
     Narration follows the ORIGINAL render: a voiced original re-renders
     voiced, a music-only original stays music-only. */
  if (request.method === "POST" && String(request.body?.action || "") === "re_render") {
    const jobId = String(request.body?.job_id || "").slice(0, 200);
    if (!jobId) return response.status(400).json({ error: "job_id is required." });
    const cronSecret = process.env.CRON_SECRET || "";
    if (!cronSecret) return response.status(503).json({ error: "CRON_SECRET not configured — the on-behalf lane is closed." });
    const appUrl =
      process.env.APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
      "https://vistalia.ai";
    try {
      const rows = await fetch(
        `${supabaseUrl}/rest/v1/render_audit_log?select=*&job_id=eq.${encodeURIComponent(jobId)}&limit=1`,
        { headers: rest }
      ).then((r) => (r.ok ? r.json() : []));
      const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!row) return response.status(404).json({ error: "No render found for that job id." });
      const ownerId = String(row.agent_user_id || row.user_id || "").trim();
      if (!ownerId) return response.status(422).json({ error: "The audit row carries no owner — can't render on their behalf." });

      const photos = auditPhotosForPlan(row.scenes);
      if (photos.length < 4) {
        return response.status(422).json({ error: `Only ${photos.length} usable photo(s) in the audit row — need at least 4.` });
      }

      const rc = row.render_config || {};
      // Narration follows the original. The audit writer's real column is
      // `narration_applied` (v42.1 — the boolean the metrics API derives
      // its `narrated` flag from); everything else here is compat padding
      // for rows written by other versions.
      const wantNarration = !!(
        row.narration_applied === true ||
        row.narrated === true ||
        (typeof rc.narrationScript === "string" && rc.narrationScript.trim())
      );
      const listingDetails = {
        address: String(row.listing_address || "").slice(0, 200),
        city: String(row.listing_city || "").slice(0, 120),
        ...(row.listing_price ? { price: String(row.listing_price).slice(0, 40) } : {})
      };
      const selectedStyle = String(rc.selectedStyle || "Cinematic Luxury").slice(0, 60);
      const targetDurationSec = Math.max(15, Math.min(60, Number(rc.targetDurationSec) || 30));
      // v62.18: shape is a customer choice. The audit row records what the
      // original actually shipped — a square original re-renders square.
      const exportFormat = String(rc.exportFormat || "").toLowerCase() === "square" ? "square" : "vertical";

      console.info(`[founder] RE-RENDER start: job ${jobId} → owner ${ownerId} (${photos.length} photos, narration=${wantNarration}).`);
      const planController = new AbortController();
      const planTimer = setTimeout(() => planController.abort(), 150_000);
      let plan;
      try {
        plan = await fetch(`${appUrl}/api/create-edit-plan`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-canary-secret": cronSecret,
            "x-on-behalf-user": ownerId
          },
          body: JSON.stringify({
            photos,
            listingDetails,
            selectedStyle,
            exportFormat,
            engine: "veo",
            targetDurationSec,
            includeNarration: wantNarration
          }),
          signal: planController.signal
        }).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));
      } finally {
        clearTimeout(planTimer);
      }
      if (!plan.ok || !plan.json?.editPlan?.scenes?.length) {
        return response.status(502).json({ error: `Plan failed (${plan.status}).` });
      }
      // Same rule as the auto-render lane: a make-right must NEVER ship the
      // stock-narration fallback template — that's worse than not sending.
      if (plan.json?.status === "fallback") {
        return response.status(502).json({ error: `Plan fell back to the template (${plan.json?.errorCategory || "?"}) — try again in a minute.` });
      }

      const manifest = buildReRenderManifest({
        userId: ownerId,
        jobSeed: jobId,
        title: String(row.project_title || row.listing_address || "Your listing").slice(0, 140),
        listingDetails,
        photos,
        editPlan: plan.json.editPlan,
        wantNarration,
        selectedStyle,
        targetDurationSec,
        exportFormat
      });
      const sub = await fetch(`${appUrl}/api/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": cronSecret },
        body: JSON.stringify({ manifest })
      }).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));
      if (!sub.ok || !sub.json?.jobId) {
        return response.status(502).json({
          error: `Submit failed (${sub.status}${sub.json?.error ? `: ${String(sub.json.error).slice(0, 80)}` : ""}).`
        });
      }
      console.info(`[founder] RE-RENDER queued: ${sub.json.jobId} for owner ${ownerId} (comp; narration=${wantNarration}).`);
      return response.status(200).json({
        status: "ok",
        job_id: sub.json.jobId,
        owner: ownerId,
        narrated: wantNarration,
        note: "Renders to the customer's library under their own plan — watermark and unlock behave exactly like their original."
      });
    } catch (err) {
      return response.status(500).json({ error: String(err?.message || err).slice(0, 160) });
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

/* ── v62.110 helpers ──────────────────────────────────────────────────── */

// The audit row's scenes[] → the photo list the plan endpoint expects.
// Dedupe by URL preserving first-seen (scene) order; the audit roomType
// rides along as `category`, which the plan's reconciliation (and the
// v62.105 close-up pool filter) treat exactly like the classifier's label.
function auditPhotosForPlan(scenes) {
  const list = Array.isArray(scenes) ? scenes : [];
  const seen = new Set();
  const photos = [];
  for (const s of list) {
    const url = s && (s.photoUrl || s.photo_url || s.url);
    if (!url || typeof url !== "string" || seen.has(url)) continue;
    seen.add(url);
    let fileName = "";
    try {
      fileName = decodeURIComponent(String(url).split("/").pop() || "").slice(0, 120);
    } catch {
      fileName = String(url).split("/").pop() || "";
    }
    photos.push({
      id: `p${photos.length + 1}`,
      url,
      durableUrl: url,
      publicUrl: url,
      fileName: fileName || `photo-${photos.length + 1}.jpg`,
      category: String(s.roomType || s.room_type || "").slice(0, 40),
      order: photos.length
    });
  }
  return photos;
}

// Mirrors the webapp's plan→manifest mapping the same way the worker's
// lead-auto-render buildManifest does (that file's comment: "if the webapp
// mapping changes, update all three" — this makes four; keep them in step).
// Differences from the lead lane, all deliberate:
//   - narration follows the ORIGINAL render (wantNarration), never the
//     LEAD_RENDERS_VOICELESS env — a voiced original re-renders voiced;
//   - founderComp rides the manifest so /api/render waives the spend gate
//     and usage bump while running every other tier consequence as the
//     customer (watermark, clean-master retention, 30s free cap);
//   - brandKit stays null: make-rights ship clean (the Floramar precedent).
function buildReRenderManifest({ userId, jobSeed, title, listingDetails, photos, editPlan, wantNarration, selectedStyle, targetDurationSec, exportFormat }) {
  const projectId = `project-rerender-${String(jobSeed).replace(/[^a-z0-9]/gi, "").slice(-10)}-${Date.now()}`;
  return {
    app: "Vistalia",
    engine: "veo",
    exportFormat: exportFormat || "vertical",
    targetDurationSec,
    autoRendered: false,
    founderReRender: true,
    founderComp: true,
    project: {
      id: projectId,
      userId,
      title,
      address: listingDetails.address || "",
      city: listingDetails.city || "",
      price: listingDetails.price || "",
      beds: null,
      baths: null,
      squareFeet: null,
      hook: ""
    },
    scenes: editPlan.scenes.map((scene) => {
      const photo = photos.find((p) => p.id === scene.photoId) || null;
      return {
        photoId: scene.photoId,
        type: "photo",
        durableUrl: photo?.durableUrl,
        publicUrl: photo?.publicUrl,
        fileName: photo?.fileName,
        duration: scene.duration,
        roomType: scene.roomType,
        qualityScore: scene.qualityScore,
        cameraMotion: scene.cameraMotion,
        transition: scene.transition,
        overlay: scene.overlay,
        runwayPrompt: scene.runwayPrompt,
        veoPrompt: scene.veoPrompt,
        narrationLine: scene.narrationLine || ""
      };
    }),
    orderedPhotos: photos,
    promptVersion: editPlan.promptVersion || null,
    introCard: editPlan.introCard,
    outroCard: editPlan.outroCard,
    narration: wantNarration ? (editPlan.narration || null) : null,
    narrationScript: wantNarration ? (editPlan.narrationScript || "") : "",
    musicMood: editPlan.musicMood,
    musicTrack: "",
    skipMusic: false,
    musicBedLevel: 0.22,
    selectedStyle,
    runwayConfig: { ...(editPlan.runwayConfig || {}), useCrossfades: true },
    brandKit: null,
    organizationId: null,
    skipNarration: !wantNarration,
    hallucinationGuard: "balanced",
    includeSquare: false,
    captionsEnabled: wantNarration,
    finishOptions: { blueHourCorrection: true }
  };
}
