// Vistalia — free-video ladder (v54.1). Daily via Vercel Cron.
//
// Replaces the retired trial-expiry ladder (v53.6): that one was a fossil
// of pre-launch 7-day-trial pricing and threatened an expiry the product
// never enforced — a Fox & Roach agent read it as an auto-billing warning.
// HARD RULE for everything this file sends: no deadlines, no lockouts, no
// urgency the product doesn't enforce. The pitch is the opposite — the
// free video never expires, and we say so.
//
// Two touches, then permanent silence:
//   day 4 of the account  → "Your free listing video is still waiting"
//   day 7                 → "Last note from us"
//
// Audience per send, ALL conditions required:
//   tier = 'trial'                  (never converted)
//   trial_renders_used = 0          (never rendered — renderers get the
//                                    post-render upsell flow instead;
//                                    nobody is emailed by both)
//   render_credits = 0              (never bought)
//   email_opt_out is not true       (migration 31 — one-click opt-out)
//
// Day math anchors on trial_ends_at (= signup + 7d, migration 07), which
// every trial profile carries: daysUntilEnd 3 ≙ account day 4, 0 ≙ day 7.
// last_reminder_sent dedupes buckets and is claimed BEFORE the send (a
// failed send costs one email; a double-send costs trust). CTA is a fresh
// magic link — these accounts have no passwords. Sends carry
// List-Unsubscribe headers so Gmail offers native unsubscribe instead of
// the spam button.

import { sendTransactionalEmail, optOutUrl } from "../_lib/email.js";
import { freeVideoWaiting, freeVideoLastNote } from "../_lib/email-templates.js";

export default async function handler(request, response) {
  // Vercel Cron auth — protects against random internet calls.
  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret) {
    const auth = String(request.headers.authorization || "");
    if (auth !== `Bearer ${cronSecret}`) {
      return response.status(401).json({ error: "Unauthorized" });
    }
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    return response.status(503).json({ error: "Supabase not configured for cron." });
  }
  const rest = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  // email_opt_out=not.is.true catches false AND null (rows predating
  // migration 31). Hundreds of rows at most — no pagination yet.
  const profilesRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?tier=eq.trial&trial_ends_at=not.is.null&email_opt_out=not.is.true` +
      `&select=user_id,email,trial_ends_at,last_reminder_sent,trial_renders_used,render_credits`,
    { headers: rest }
  );
  if (!profilesRes.ok) {
    const detail = await profilesRes.text().catch(() => "");
    return response.status(500).json({
      error: "Failed to read profiles",
      detail: detail.slice(0, 240)
    });
  }
  const rows = await profilesRes.json().catch(() => []);

  const now = new Date();
  const sent = { day4: 0, day7: 0, skipped: 0, errored: 0 };
  const errors = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.email || !row?.user_id || !row?.trial_ends_at) { sent.skipped++; continue; }
    // Renderers belong to the post-render upsell flow; buyers to nobody.
    if (Number(row.trial_renders_used || 0) > 0 || Number(row.render_credits || 0) > 0) {
      sent.skipped++;
      continue;
    }
    const endsAt = new Date(row.trial_ends_at);
    if (!Number.isFinite(endsAt.getTime())) { sent.skipped++; continue; }
    const daysUntilEnd = Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000);

    let bucket = "";
    let template = null;
    if (daysUntilEnd === 3) {
      bucket = "free-video-4d";
      template = freeVideoWaiting;
    } else if (daysUntilEnd === 0) {
      bucket = "free-video-7d";
      template = freeVideoLastNote;
    } else {
      sent.skipped++;
      continue;
    }
    if (row.last_reminder_sent === bucket) { sent.skipped++; continue; }

    try {
      // Claim the bucket BEFORE sending (double-send costs more than a
      // lost email; the nudge pass established this doctrine).
      const claim = await fetch(
        `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(row.user_id)}`,
        {
          method: "PATCH",
          headers: { ...rest, Prefer: "return=minimal" },
          body: JSON.stringify({ last_reminder_sent: bucket })
        }
      );
      if (!claim.ok) { sent.errored++; errors.push(`claim ${row.email}: ${claim.status}`); continue; }

      // Fresh magic link — no-password accounts. Top-level redirect_to:
      // the REST admin API ignores the SDK's nested shape (proven 2026-07-15).
      let magicLink = "";
      const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: rest,
        body: JSON.stringify({
          type: "magiclink",
          email: row.email,
          redirect_to: `${process.env.APP_URL || "https://vistalia.ai"}/app/`
        })
      });
      if (linkRes.ok) {
        const link = await linkRes.json().catch(() => ({}));
        magicLink = link?.action_link || link?.properties?.action_link || "";
      }

      const optOut = optOutUrl(row.user_id);
      const tpl = template({ email: row.email, magicLink, optOutUrl: optOut });
      const result = await sendTransactionalEmail({
        to: row.email,
        subject: tpl.subject,
        html: tpl.html,
        tags: [bucket],
        headers: {
          "List-Unsubscribe": `<${optOut}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
        }
      });
      if (result?.ok) sent[bucket === "free-video-4d" ? "day4" : "day7"]++;
      else { sent.errored++; errors.push(`send ${row.email}: ${result?.error || "failed"}`); }
    } catch (error) {
      sent.errored++;
      errors.push(`${row.email}: ${error.message}`);
    }
  }

  console.info("[free-video-ladder]", JSON.stringify({ ...sent, errors: errors.slice(0, 5) }));
  return response.status(200).json({ status: "ok", ...sent, errors });
}
