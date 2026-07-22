// Vistalia — daily trial-reminder emails.
//
// Runs once per day via Vercel Cron (configured in vercel.json). Scans
// profiles with tier='trial' and dispatches the right email based on how
// close trial_ends_at is to NOW():
//   - 3 days out: "Your trial ends in 3 days"
//   - 1 day out:  "Last day of your trial"
//   - 0 days (today, but still trial tier): "Your trial has ended"
//
// To prevent duplicate emails when the cron runs twice in a day (or if
// we manually re-trigger it), each profile carries a `last_reminder_sent`
// column we check against the bucket name. Migration 08 adds this column.
//
// Auth: Vercel Cron sends a signed header. We accept any request when
// CRON_SECRET is unset (dev), and require Bearer match in production.

import { sendTransactionalEmail } from "../_lib/email.js";
import {
  trialEndingThreeDays,
  trialEndingOneDay,
  trialExpired
} from "../_lib/email-templates.js";

export default async function handler(request, response) {
  // v53.6 (Amy VanDenburgh, Jul 22 2026): DISABLED. This ladder is a fossil
  // of the pre-launch 7-day-trial pricing model. Under q6/q7 (first video
  // free + PAYG + subs) NOTHING expires — there is no trial_ends_at
  // enforcement anywhere in the render path — yet these emails told every
  // lead-provisioned agent "the Generate button stops responding until you
  // pick a plan." A Fox & Roach agent read it as an auto-billing threat and
  // wrote in asking us not to charge her. No card exists; nothing renews.
  // The cron entry is removed from vercel.json; this guard makes a manual
  // or stale-config invocation a no-op. If a nudge ladder returns, it sells
  // the unused free video — it never claims a deadline that doesn't exist.
  if (process.env.TRIAL_REMINDERS_ENABLED !== "true") {
    return response.status(200).json({
      status: "disabled",
      reason: "retired with q6 pricing — no trial expiry exists (v53.6)"
    });
  }
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

  // Pull every trial-tier profile with a non-null trial_ends_at. We're
  // dealing with hundreds at most for the foreseeable future — no need
  // to paginate yet.
  const profilesRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?tier=eq.trial&select=user_id,email,trial_ends_at,last_reminder_sent`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      }
    }
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
  const sent = { three_day: 0, one_day: 0, expired: 0, skipped: 0, errored: 0 };
  const errors = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.email || !row?.trial_ends_at) { sent.skipped++; continue; }
    const endsAt = new Date(row.trial_ends_at);
    if (!Number.isFinite(endsAt.getTime())) { sent.skipped++; continue; }

    const msUntilEnd = endsAt.getTime() - now.getTime();
    const daysUntilEnd = Math.ceil(msUntilEnd / 86_400_000);

    let bucket = "";
    let template = null;
    if (daysUntilEnd === 3) {
      bucket = "trial-3d";
      template = trialEndingThreeDays({ email: row.email });
    } else if (daysUntilEnd === 1) {
      bucket = "trial-1d";
      template = trialEndingOneDay({ email: row.email });
    } else if (daysUntilEnd <= 0 && daysUntilEnd >= -1) {
      // Run once on the day of expiry (and one buffer day for cron drift).
      bucket = "trial-expired";
      template = trialExpired({ email: row.email });
    } else {
      sent.skipped++;
      continue;
    }

    // De-dupe: don't re-send the same bucket to the same user.
    if (row.last_reminder_sent === bucket) {
      sent.skipped++;
      continue;
    }

    const result = await sendTransactionalEmail({
      to: row.email,
      subject: template.subject,
      html: template.html,
      tags: [bucket]
    });

    if (!result.ok && !result.skipped) {
      errors.push(`${row.email}: ${result.error || "unknown"}`);
      sent.errored++;
      continue;
    }

    // Mark this bucket sent on the profile so we don't re-fire tomorrow.
    await markReminderSent(supabaseUrl, serviceKey, row.user_id, bucket);

    if (bucket === "trial-3d") sent.three_day++;
    else if (bucket === "trial-1d") sent.one_day++;
    else if (bucket === "trial-expired") sent.expired++;
  }

  return response.status(200).json({
    status: "ok",
    sent,
    errors: errors.length ? errors : undefined,
    scanned: Array.isArray(rows) ? rows.length : 0,
    runAt: now.toISOString()
  });
}

async function markReminderSent(supabaseUrl, serviceKey, userId, bucket) {
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ last_reminder_sent: bucket })
      }
    );
  } catch (err) {
    console.warn("[cron/trial-reminders] mark sent failed:", err.message);
  }
}
