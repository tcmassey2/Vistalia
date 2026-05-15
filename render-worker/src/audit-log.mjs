// EstateMotion — Render audit log writer.
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
    thumbnail_url: upload?.thumbnailUrl || "",
    social_short_count: Array.isArray(upload?.socialShorts) ? upload.socialShorts.length : 0,
    formats_count: Object.keys(upload?.formats || {}).length || 1,
    narration_applied: Boolean(narration?.applied),
    narration_voice_id: narration?.voiceId || null,
    status: "completed",
    // v23: prompt version stamp — propagated from create-edit-plan.js's
    // PROMPT_VERSION constant onto the manifest. Lets us correlate quality
    // complaints with specific prompt revisions when tuning later.
    prompt_version: manifest?.promptVersion || manifest?.editPlan?.promptVersion || null,
    // v23: render config snapshot — captures the toggle state used for this
    // render so we can replay or diff against future renders. JSONB column.
    render_config: {
      selectedStyle: manifest?.selectedStyle || null,
      complianceMode: Boolean(manifest?.complianceMode),
      hallucinationGuard: manifest?.hallucinationGuard || null,
      protectHighRiskRooms: Boolean(manifest?.protectHighRiskRooms),
      twilightHero: Boolean(manifest?.creative?.twilightHero),
      injectBroll: manifest?.creative?.injectBroll !== false,
      disableAddressCard: Boolean(manifest?.disableAddressCard),
      userTier: manifest?.userTier || null,
      // v23.1: which Runway model the tier-based resolver picked. Surfaced
      // here at the render-level (per-scene model usage lives on the
      // scenes[] array). Lets analytics queries answer "what % of 4K-tier
      // renders actually got Gen-4.5 vs fell back to Turbo".
      runwayModelRequested: manifest?.runwayConfig?.model
        || (String(manifest?.userTier || "").toLowerCase() === "cinematic_4k"
            ? (process.env.RUNWAY_PREMIUM_MODEL || "gen4.5")
            : "gen4_turbo")
    },
    // Per-scene metadata for regenerate-scene flow. JSONB column.
    // v23: per-scene now includes engineUsed / fallbackReason / guardRisk
    // / guardLevel / runwayTaskId / durationMs (added in 11. above).
    scenes: Array.isArray(scenes) ? scenes : []
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/render_audit_log`, {
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
      const text = await res.text().catch(() => "");
      // Detect "table does not exist" once and stop attempting future writes.
      // The PostgREST code for missing-relation is PGRST205.
      if (res.status === 404 && /PGRST205|Could not find the table/i.test(text)) {
        auditTableMissing = true;
        console.warn(`[EstateMotion audit-log] table 'render_audit_log' is missing — run supabase/migrations/04_brokerages.sql to enable. Skipping all future audit writes until worker restarts.`);
      } else {
        console.warn(`[EstateMotion audit-log] write failed (${res.status}):`, text.slice(0, 240));
      }
    }
  } catch (err) {
    console.warn("[EstateMotion audit-log] write threw:", err.message || err);
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
      console.warn(`[EstateMotion audit-log] update failed (${res.status}):`, text.slice(0, 240));
    }
  } catch (err) {
    console.warn("[EstateMotion audit-log] update threw:", err.message || err);
  }
}

// Upsert in-flight job state to public.render_jobs so the Vercel side can
// serve status polls even when this worker instance doesn't have the job
// in its memory Map (e.g., after a restart, or when horizontally scaled).
// Fire-and-forget — never blocks the render. Workers that opt in get
// cleaner status-poll behavior; workers that don't still work via the
// existing in-memory path + library-recovery fallback.
const WORKER_INSTANCE_ID = process.env.RENDER_INSTANCE_ID || `worker-${Date.now().toString(36)}`;
let renderJobsTableMissing = false;
export async function upsertRenderJob({ jobId, userId, status, phase, progress, engine, mp4Url, thumbnailUrl, error }) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;
  if (renderJobsTableMissing) return;
  if (!jobId) return;
  const row = {
    job_id: jobId,
    user_id: userId || null,
    status: status || "rendering",
    phase: phase || "Render in progress",
    progress: Math.max(0, Math.min(100, Math.round(Number(progress) || 0))),
    engine: engine || null,
    mp4_url: mp4Url || null,
    thumbnail_url: thumbnailUrl || null,
    worker_instance_id: WORKER_INSTANCE_ID,
    error: error || null
  };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/render_jobs?on_conflict=job_id`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal,resolution=merge-duplicates"
      },
      body: JSON.stringify(row)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404 && /PGRST205|Could not find the table/i.test(text)) {
        renderJobsTableMissing = true;
        console.warn(`[render_jobs] table missing — run supabase/migrations/09_render_jobs_queue.sql to enable horizontal-scaling status fallback. Skipping until worker restart.`);
      }
      // Other errors are silent — single-instance topology doesn't depend on this.
    }
  } catch {
    // Network blip — drop the update; next progress event will catch up.
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
