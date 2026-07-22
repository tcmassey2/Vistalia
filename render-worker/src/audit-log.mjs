// Vistalia — Render audit log writer.
//
// Called from both render pipelines (Quick Reel + Cinematic AI) right after
// upload completes. Writes a single row to public.render_audit_log so that
// brokerage admins have a permanent record of every video produced under
// their license.
//
// Service role key is required and bypasses RLS — that's the whole point;
// the worker is the trusted writer of audit rows.
//
// Failures here are logged but never rethrown. Audit-log writes must NEVER
// take down a render that otherwise succeeded.

import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Process-level guard — once we've seen the table-not-found error, stop
// trying. Without this we'd hammer Supabase REST on every render and clog
// the worker's log with the same PGRST205 error, masking real issues.
// Resets when the worker restarts (so re-running the migration takes
// effect on next deploy).
let auditTableMissing = false;

export async function writeRenderAudit({ manifest, jobId, engine, upload, narration, scenes }) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;
  if (auditTableMissing) return; // already determined the table doesn't exist
  const organizationId = manifest?.organizationId || null;
  const agentUserId = manifest?.project?.userId;
  if (!agentUserId) return; // anonymous renders don't get logged

  const row = {
    organization_id: organizationId,
    agent_user_id: agentUserId,
    job_id: jobId,
    engine,
    listing_address: manifest?.project?.address || null,
    listing_city: manifest?.project?.city || null,
    listing_price: manifest?.project?.price || null,
    project_title: manifest?.project?.title || null,
    master_mp4_url: upload?.formats?.vertical?.mp4Url || "",
    // v55 instant unlock: the clean (unwatermarked) master's URL, uploaded
    // alongside the marked deliverable on trial renders. Never exposed by
    // the library until the webhook stamps unlocked_at on purchase.
    // Migration 30 adds the column; insert retries without it (same
    // deploy-order resilience as certificate_token).
    master_clean_url: upload?.formats?.clean?.mp4Url || "",
    thumbnail_url: upload?.thumbnailUrl || "",
    social_short_count: Array.isArray(upload?.socialShorts) ? upload.socialShorts.length : 0,
    formats_count: Object.keys(upload?.formats || {}).length || 1,
    // v42.1 (Troy: "library shows captions off even though they are on"):
    // the mixer returns `narrationApplied`; this read `.applied` — undefined
    // → narration_applied has been FALSE for every narrated render since
    // the audit log shipped. Read the real field (keep .applied as compat).
    narration_applied: Boolean(narration?.narrationApplied ?? narration?.applied),
    narration_voice_id: narration?.voiceId || null,
    status: "completed",
    // v42: render_config was READ by api/library.js + the detail modal since
    // v23.2 but never written here — the Library's "Video details" showed
    // null fallbacks forever (Troy: "demo style thing"). Persist the
    // customer-meaningful manifest facts + what per-scene regen needs to
    // re-stitch faithfully.
    render_config: {
      selectedStyle: manifest?.selectedStyle || null,
      musicMood: manifest?.musicMood || null,
      musicTrack: manifest?.musicTrack || null,
      // What the user asked for AND what actually shipped — the panel
      // shows truth, not intent.
      captionsEnabled: manifest?.captionsEnabled !== false,
      captionsApplied: Boolean(narration?.captionsApplied),
      useCrossfades: manifest?.runwayConfig?.useCrossfades !== false,
      targetDurationSec: Number(manifest?.targetDurationSec) || null,
      twilightHero: Boolean(manifest?.twilightHero),
      disableAddressCard: Boolean(manifest?.disableAddressCard)
    },
    // Per-scene metadata for regenerate-scene flow. JSONB column.
    scenes: Array.isArray(scenes) ? scenes : [],
    // v51 MLS-Safe Certificate: unguessable public handle for
    // vistalia.ai/v/<token>. Migration 29 adds the column; the insert
    // below retries WITHOUT the field if the migration hasn't been
    // applied yet (deploy-order resilience, same pattern as heartbeat_at).
    certificate_token: crypto.randomBytes(12).toString("hex")
  };

  try {
    let res = await fetch(`${SUPABASE_URL}/rest/v1/render_audit_log`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify([row])
    });
    if (!res.ok) {
      const early = await res.text().catch(() => "");
      if (/certificate_token|master_clean_url/i.test(early)) {
        console.warn("[Vistalia audit-log] newer column missing (run migrations 29/30) — writing audit row without certificate_token/master_clean_url.");
        const { certificate_token, master_clean_url, ...rest } = row;
        res = await fetch(`${SUPABASE_URL}/rest/v1/render_audit_log`, {
          method: "POST",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify([rest])
        });
        if (res.ok) return;
      }
      const text = early || (await res.text().catch(() => ""));
      // Detect "table does not exist" once and stop attempting future writes.
      // The PostgREST code for missing-relation is PGRST205.
      if (res.status === 404 && /PGRST205|Could not find the table/i.test(text)) {
        auditTableMissing = true;
        console.warn(`[Vistalia audit-log] table 'render_audit_log' is missing — run supabase/migrations/04_brokerages.sql to enable. Skipping all future audit writes until worker restarts.`);
      } else {
        console.warn(`[Vistalia audit-log] write failed (${res.status}):`, text.slice(0, 240));
      }
    }
  } catch (err) {
    console.warn("[Vistalia audit-log] write threw:", err.message || err);
  }
}

// Update an existing audit row — used by the regenerate-scene flow when
// the new master + scene clip + scenes array need to overwrite the
// previous render's row. Matched by job_id.
export async function updateRenderAudit({ jobId, patch }) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;
  if (auditTableMissing) return;
  if (!jobId || !patch) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/render_audit_log?job_id=eq.${encodeURIComponent(jobId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify(patch)
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[Vistalia audit-log] update failed (${res.status}):`, text.slice(0, 240));
    }
  } catch (err) {
    console.warn("[Vistalia audit-log] update threw:", err.message || err);
  }
}

// Fetch a single audit row by job_id — used by /api/regenerate-scene to
// load the original scenes array before re-rolling one of them.
export async function readRenderAudit(jobId) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  if (auditTableMissing) return null;
  if (!jobId) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/render_audit_log?job_id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`
        }
      }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}
