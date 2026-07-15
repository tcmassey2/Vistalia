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
import { leadWelcomeEmail, leadNudgeEmail } from "./_lib/email-templates.js";

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
      }

      // Fresh magic link (the welcome's expired long ago).
      let magicLink = "";
      const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: rest,
        body: JSON.stringify({
          type: "magiclink",
          email: lead.email,
          options: { redirect_to: `${process.env.APP_URL || "https://vistalia.ai"}/app/` }
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
      options: { redirect_to: `${process.env.APP_URL || "https://vistalia.ai"}/app/` }
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
  const out = { email: "", fullName: "", licensed: null };
  for (const f of Array.isArray(fieldData) ? fieldData : []) {
    const name = String(f?.name || "").toLowerCase();
    const value = Array.isArray(f?.values) ? String(f.values[0] || "") : "";
    if (!value) continue;
    if (name === "email" || name.includes("email")) out.email = value;
    else if (name === "full_name" || name.includes("full name") || name === "name") out.fullName = value;
    else if (name.includes("licensed")) out.licensed = /^yes/i.test(value.trim());
  }
  return out;
}
