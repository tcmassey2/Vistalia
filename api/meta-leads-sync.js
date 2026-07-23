// Vistalia — /api/meta-leads-sync
//
// Pulls Instant Form leads from Meta's Graph API and turns each one into a
// live Vistalia account: insert into meta_leads (dedupe), create the Supabase
// user (email pre-confirmed), mint a magic link, send the branded welcome.
// The lead's account exists before they ever leave Instagram.
//
// Clock: the render worker pings this every few minutes (LEADS_SYNC_URL on
// Render), because Vercel Hobby crons are daily-only. A Vercel cron can also
// call it — both are accepted, and concurrent invocations are safe:
//
//   DISTRIBUTED GUARD — we INSERT into meta_leads with
//   `Prefer: resolution=ignore-duplicates, return=representation` FIRST.
//   PostgREST only returns rows it actually inserted, so when three worker
//   instances race, exactly one gets the row back and proceeds to provision
//   + email. The others see [] and skip. No advisory locks needed.
//
// Auth (any of):
//   - Bearer RENDER_WEBHOOK_SECRET / RENDER_WORKER_SECRET (worker clock)
//   - Bearer CRON_SECRET (Vercel cron)
//
// Env:
//   META_PAGE_ACCESS_TOKEN   required — System User token w/ leads_retrieval
//                            (Business settings → System users → generate,
//                            assign the Vistalia Page asset). Never expires.
//   META_LEADGEN_FORM_IDS    optional — comma-separated form ids. If unset,
//                            forms are discovered via /{page}/leadgen_forms.
//   META_PAGE_ID             optional — defaults to the Vistalia Page.

import { sendTransactionalEmail } from "./_lib/email.js";
import { leadWelcomeEmail, leadNudgeEmail, firstRenderUpsellEmail } from "./_lib/email-templates.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const DEFAULT_PAGE_ID = "1250774388114584"; // Vistalia (true Graph id)
const MAX_NEW_PER_RUN = 25;   // cap runtime; the clock comes back around
const MAX_PAGES_PER_FORM = 5; // 100/page — plenty until volume says otherwise
const NUDGE_AFTER_MS = Math.max(60 * 60 * 1000, Number(process.env.LEAD_NUDGE_AFTER_MS || 20 * 60 * 60 * 1000));
const NUDGE_BATCH = 15;       // per run; the 5-min clock drains any backlog

export default async function handler(request, response) {
  if (request.method !== "POST" && request.method !== "GET") {
    return response.status(405).json({ error: "Use POST /api/meta-leads-sync." });
  }

  // --- auth: worker secret or cron secret ---
  const auth = String(request.headers.authorization || "");
  const accepted = [
    process.env.RENDER_WEBHOOK_SECRET,
    process.env.RENDER_WORKER_SECRET,
    process.env.CRON_SECRET
  ].filter(Boolean).map((s) => `Bearer ${s}`);
  if (!accepted.length || !accepted.includes(auth)) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const pageToken = process.env.META_PAGE_ACCESS_TOKEN || "";
  if (!pageToken) {
    return response.status(503).json({
      status: "failed",
      error: "META_PAGE_ACCESS_TOKEN not configured (Business settings → System users → token with leads_retrieval + the Page asset)."
    });
  }
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    return response.status(503).json({ status: "failed", error: "Supabase admin env missing." });
  }

  const summary = { forms: 0, seen: 0, new: 0, created: 0, existing: 0, emailed: 0, errors: [] };

  try {
    // (#190) day-2 fix: the leadgen edges (leadgen_forms, /leads) reject
    // system-user tokens outright — they demand a PAGE access token. The
    // system user's token can mint one at runtime via /{page}?fields=
    // access_token (it holds the page's ADVERTISE task + pages_show_list),
    // so no new secret is needed in env.
    const pageId = process.env.META_PAGE_ID || DEFAULT_PAGE_ID;
    const exchRes = await fetch(`${GRAPH}/${pageId}?fields=access_token&access_token=${encodeURIComponent(pageToken)}`);
    const exchBody = await exchRes.json().catch(() => ({}));
    const pageAccessToken = exchBody?.access_token || "";
    if (!exchRes.ok || !pageAccessToken) {
      throw new Error(`page token exchange: ${exchBody?.error?.message || exchRes.status}`);
    }

    // --- which forms ---
    let formIds = String(process.env.META_LEADGEN_FORM_IDS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (!formIds.length) {
      const res = await fetch(`${GRAPH}/${pageId}/leadgen_forms?fields=id,name,status&limit=50&access_token=${encodeURIComponent(pageAccessToken)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`leadgen_forms: ${body?.error?.message || res.status}`);
      formIds = (body.data || []).filter((f) => f.status !== "DELETED").map((f) => f.id);
    }
    summary.forms = formIds.length;

    // --- pull + process ---
    let budget = MAX_NEW_PER_RUN;
    for (const formId of formIds) {
      if (budget <= 0) break;
      let url = `${GRAPH}/${formId}/leads?fields=id,created_time,field_data&limit=100&access_token=${encodeURIComponent(pageAccessToken)}`;
      for (let page = 0; page < MAX_PAGES_PER_FORM && url && budget > 0; page++) {
        const res = await fetch(url);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { summary.errors.push(`form ${formId}: ${body?.error?.message || res.status}`); break; }
        for (const lead of body.data || []) {
          summary.seen++;
          if (budget <= 0) break;
          const handled = await processLead({ lead, formId, supabaseUrl, serviceKey, summary });
          if (handled) budget--;
        }
        url = body?.paging?.next || "";
      }
    }

    // --- nudge pass: ~20h old, welcomed, never nudged, never rendered ---
    await runNudgePass({ supabaseUrl, serviceKey, summary });
    await runUpsellPass({ supabaseUrl, serviceKey, summary });

    if (summary.errors.length) console.error("[meta-leads-sync]", JSON.stringify(summary.errors));
    return response.status(200).json({ status: "ok", ...summary });
  } catch (error) {
    summary.errors.push(error.message);
    console.error("[meta-leads-sync] FAILED", JSON.stringify(summary.errors));
    return response.status(500).json({ status: "failed", ...summary });
  }
}

/* ============================================================
   Nudge pass — the one-shot "your video is still free" reminder.
   Claim-first (PATCH nudged_at WHERE nudged_at IS NULL, returning) so
   concurrent invocations can't double-send; a lead who already rendered
   gets claimed-and-skipped, which also permanently retires them.
   ============================================================ */
async function runNudgePass({ supabaseUrl, serviceKey, summary }) {
  summary.nudged = 0;
  summary.nudge_skipped = 0;
  const rest = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };
  try {
    const cutoff = new Date(Date.now() - NUDGE_AFTER_MS).toISOString();
    const listRes = await fetch(
      `${supabaseUrl}/rest/v1/meta_leads?select=lead_id,email,full_name,user_id` +
      `&emailed_at=lt.${encodeURIComponent(cutoff)}&nudged_at=is.null&limit=${NUDGE_BATCH}`,
      { headers: rest }
    );
    if (!listRes.ok) throw new Error(`nudge list: ${listRes.status}`);
    const candidates = await listRes.json().catch(() => []);

    for (const lead of Array.isArray(candidates) ? candidates : []) {
      // Claim first — only the invocation that flips nudged_at proceeds.
      const claimRes = await fetch(
        `${supabaseUrl}/rest/v1/meta_leads?lead_id=eq.${encodeURIComponent(lead.lead_id)}&nudged_at=is.null`,
        {
          method: "PATCH",
          headers: { ...rest, Prefer: "return=representation" },
          body: JSON.stringify({ nudged_at: new Date().toISOString() })
        }
      );
      const claimed = await claimRes.json().catch(() => []);
      if (!claimRes.ok || !Array.isArray(claimed) || claimed.length === 0) continue;

      // Already rendered? Then they activated — no reminder needed, and the
      // claim above retires them for good.
      if (lead.user_id) {
        const renderRes = await fetch(
          `${supabaseUrl}/rest/v1/render_audit_log?select=job_id&agent_user_id=eq.${encodeURIComponent(lead.user_id)}&limit=1`,
          { headers: rest }
        );
        const renders = renderRes.ok ? await renderRes.json().catch(() => []) : [];
        if (Array.isArray(renders) && renders.length > 0) {
          summary.nudge_skipped++;
          continue;
        }
        // v54.1: one-click opt-out is absolute — the claim above already
        // retired this lead, so an opted-out agent is never nudged, now or
        // on any later run.
        const optRes = await fetch(
          `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(lead.user_id)}&select=email_opt_out`,
          { headers: rest }
        );
        const optRows = optRes.ok ? await optRes.json().catch(() => []) : [];
        if (Array.isArray(optRows) && optRows[0]?.email_opt_out === true) {
          summary.nudge_skipped++;
          continue;
        }
      }

      // Fresh magic link (the welcome's expired long ago).
      let magicLink = "";
      const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: rest,
        body: JSON.stringify({
          type: "magiclink",
          email: lead.email,
          // NOTE: top-level redirect_to. The REST admin API ignores the JS
          // SDK's nested options.redirect_to shape — proven 2026-07-15 when
          // every lead link fell back to the Site URL.
          redirect_to: `${process.env.APP_URL || "https://vistalia.ai"}/app/`
        })
      });
      if (linkRes.ok) {
        const link = await linkRes.json().catch(() => ({}));
        magicLink = link?.action_link || link?.properties?.action_link || "";
      }

      const firstName = (lead.full_name || "").trim().split(/\s+/)[0] || "";
      const tpl = leadNudgeEmail({ email: lead.email, firstName, magicLink });
      const sent = await sendTransactionalEmail({
        to: lead.email,
        subject: tpl.subject,
        html: tpl.html,
        tags: ["lead-nudge"]
      });
      if (sent?.ok) summary.nudged++;
      else summary.errors.push(`nudge send ${lead.email}: failed`);
    }
  } catch (error) {
    summary.errors.push(`nudge pass: ${error.message}`);
  }
}

/* Returns true if this invocation OWNED the lead (won the insert race). */
async function processLead({ lead, formId, supabaseUrl, serviceKey, summary }) {
  const fields = parseFieldData(lead.field_data);
  const email = (fields.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) return false;

  // Insert-first dedupe + distributed lock (see file header).
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/meta_leads`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation"
    },
    body: JSON.stringify({
      lead_id: String(lead.id),
      form_id: String(formId),
      email,
      full_name: fields.fullName || null,
      licensed: fields.licensed,
      listing_url: fields.listingUrl || null,
      raw: lead.field_data || null,
      created_time: lead.created_time || null
    })
  });
  if (!insertRes.ok) {
    summary.errors.push(`insert ${lead.id}: ${insertRes.status}`);
    return false;
  }
  const inserted = await insertRes.json().catch(() => []);
  if (!Array.isArray(inserted) || inserted.length === 0) return false; // already processed elsewhere
  summary.new++;

  // Provision the account. 422 = already registered → still magic-link them.
  let userId = null;
  let userCreated = false;
  const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(serviceKey),
    body: JSON.stringify({
      email,
      email_confirm: true,
      user_metadata: {
        full_name: fields.fullName || "",
        source: "meta_lead_form",
        licensed_agent: fields.licensed
      }
    })
  });
  if (createRes.ok) {
    const user = await createRes.json().catch(() => ({}));
    userId = user?.id || null;
    userCreated = true;
    summary.created++;
  } else if (createRes.status === 422) {
    summary.existing++; // fine — welcome them back with a magic link
  } else {
    summary.errors.push(`createUser ${email}: ${createRes.status}`);
  }

  // Magic link (works for new AND pre-existing accounts).
  let magicLink = "";
  const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: adminHeaders(serviceKey),
    body: JSON.stringify({
      type: "magiclink",
      email,
      // Top-level redirect_to — the REST admin API ignores options.redirect_to.
      redirect_to: `${process.env.APP_URL || "https://vistalia.ai"}/app/`
    })
  });
  if (linkRes.ok) {
    const link = await linkRes.json().catch(() => ({}));
    magicLink = link?.action_link || link?.properties?.action_link || "";
    if (!userId) userId = link?.user?.id || link?.id || null;
  } else {
    summary.errors.push(`generate_link ${email}: ${linkRes.status}`);
  }

  // Branded welcome. Magic link missing → CTA falls back to /app/.
  const firstName = (fields.fullName || "").trim().split(/\s+/)[0] || "";
  const tpl = leadWelcomeEmail({ email, firstName, magicLink });
  const sent = await sendTransactionalEmail({
    to: email,
    subject: tpl.subject,
    html: tpl.html,
    tags: ["lead-welcome"]
  });
  if (sent?.ok) summary.emailed++;

  // Record outcome (best-effort).
  await fetch(`${supabaseUrl}/rest/v1/meta_leads?lead_id=eq.${encodeURIComponent(String(lead.id))}`, {
    method: "PATCH",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({
      user_id: userId,
      user_created: userCreated,
      emailed_at: sent?.ok ? new Date().toISOString() : null
    })
  }).catch(() => {});

  return true;
}

function adminHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };
}

/* Meta field_data → { email, fullName, licensed }. Field names come from the
   form builder: standard ones are lowercase ("email", "full_name"); custom
   multiple-choice questions arrive with the question text as the name. */
function parseFieldData(fieldData) {
  const out = { email: "", fullName: "", licensed: null, listingUrl: "" };
  for (const f of Array.isArray(fieldData) ? fieldData : []) {
    const name = String(f?.name || "").toLowerCase();
    const value = Array.isArray(f?.values) ? String(f.values[0] || "") : "";
    if (!value) continue;
    if (name === "email" || name.includes("email")) out.email = value;
    else if (name === "full_name" || name.includes("full name") || name === "name") out.fullName = value;
    else if (name.includes("licensed")) out.licensed = /^yes/i.test(value.trim());
    // v57: the listing-link question ("link to your current listing").
    // Only URLs qualify — the auto-render pass feeds api/import-listing,
    // which is URL-based. A typed street address is kept in `raw` but
    // doesn't trigger auto-render. Leads often paste without the scheme
    // ("zillow.com/homedetails/…"), so a bare known-portal domain counts.
    else if (name.includes("listing") || name.includes("property")) {
      const v = value.trim();
      if (/^https?:\/\/\S+$/i.test(v)) out.listingUrl = v;
      else if (/^(www\.)?(zillow|redfin|realtor|homes|trulia|compass|kw|exp)\S*\.\S+/i.test(v)) out.listingUrl = `https://${v}`;
    }
  }
  return out;
}

/* ============================================================
   Post-first-render upsell pass (PROFITABILITY_PLAN Phase 0).
   The paywall moment we never email: a trial user rendered their first
   video 20+ hours ago and hasn't bought. Sell the NEXT listing ($39
   wedge / Pro graduation) while the first one is still fresh.

   Rules: first render 20h–7d old · tier=trial · zero credits (goodwill
   holders get the in-app credits-exhausted paywall instead) · one send
   ever via app_metadata.upsell_sent (claim-first, like the nudge).
   Failures are logged and never break the lead sync.
   ============================================================ */
async function runUpsellPass({ supabaseUrl, serviceKey, summary }) {
  summary.upsold = 0;
  summary.upsell_skipped = 0;
  const UPSELL_AFTER_MS = Number(process.env.UPSELL_AFTER_MS || 20 * 3600 * 1000);
  const UPSELL_BATCH = Number(process.env.UPSELL_BATCH || 10);
  const rest = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const rows = await fetch(
      `${supabaseUrl}/rest/v1/render_audit_log?select=agent_user_id,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=300`,
      { headers: rest }
    ).then((r) => (r.ok ? r.json() : []));

    // First render per user inside the window.
    const firstRender = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r.agent_user_id && !firstRender.has(r.agent_user_id)) {
        firstRender.set(r.agent_user_id, new Date(r.created_at).getTime());
      }
    }

    let sentCount = 0;
    for (const [userId, firstAt] of firstRender) {
      if (sentCount >= UPSELL_BATCH) break;
      if (Date.now() - firstAt < UPSELL_AFTER_MS) continue;

      // Trial with no credits only — payers and goodwill-credit holders skip.
      const prof = await fetch(
        `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=tier,render_credits,email,email_opt_out`,
        { headers: rest }
      ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      const p = Array.isArray(prof) ? prof[0] : null;
      if (!p || p.tier !== "trial" || Number(p.render_credits || 0) > 0) { summary.upsell_skipped++; continue; }
      // v54.1: opted out means no upsell either.
      if (p.email_opt_out === true) { summary.upsell_skipped++; continue; }

      // One-shot claim via app_metadata (no migration needed).
      const userRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: rest });
      if (!userRes.ok) { summary.upsell_skipped++; continue; }
      const user = await userRes.json().catch(() => ({}));
      const email = String(user?.email || p.email || "");
      if (!email || user?.app_metadata?.upsell_sent) { summary.upsell_skipped++; continue; }

      const claim = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        headers: rest,
        body: JSON.stringify({ app_metadata: { ...(user.app_metadata || {}), upsell_sent: true } })
      });
      if (!claim.ok) { summary.errors.push(`upsell claim ${email}: ${claim.status}`); continue; }

      // Fresh magic link (top-level redirect_to — REST admin API shape).
      let magicLink = "";
      const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: rest,
        body: JSON.stringify({
          type: "magiclink",
          email,
          redirect_to: `${process.env.APP_URL || "https://vistalia.ai"}/app/`
        })
      });
      if (linkRes.ok) {
        const link = await linkRes.json().catch(() => ({}));
        magicLink = link?.action_link || link?.properties?.action_link || "";
      }

      const tpl = firstRenderUpsellEmail({ email, magicLink });
      const sent = await sendTransactionalEmail({
        to: email,
        subject: tpl.subject,
        html: tpl.html,
        tags: ["first-render-upsell"]
      });
      if (sent?.ok) { summary.upsold++; sentCount++; }
      else if (!sent?.skipped) summary.errors.push(`upsell send ${email}: ${sent?.error || "failed"}`);
    }
  } catch (err) {
    summary.errors.push(`upsell pass: ${err.message}`);
  }
}
