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

export async function writeRenderAudit({ manifest, jobId, engine, upload, narration }) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return;
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
    status: "completed"
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
      console.warn(`[EstateMotion audit-log] write failed (${res.status}):`, text.slice(0, 240));
    }
  } catch (err) {
    console.warn("[EstateMotion audit-log] write threw:", err.message || err);
  }
}
