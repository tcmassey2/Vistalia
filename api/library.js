// Vistalia — Render library.
//
// GET    /api/library          → returns the signed-in user's past renders, newest first.
// DELETE /api/library?jobId=X  → deletes one library entry (audit row + storage objects).
//
// Source of truth is the render_audit_log table (one row per completed
// render, written by the worker). If the table doesn't exist yet (the
// brokerage migration hasn't been applied), we return an empty list with
// a helpful warning rather than 500ing.
//
// All requests require a Supabase JWT in Authorization: Bearer <token>.
// We use the service role key to query the audit log so we can bypass
// RLS and apply our own scoping (agent_user_id = caller's id).
//
// DELETE flow (v24.5):
//   1. Verify the caller owns the audit row (agent_user_id match).
//   2. Best-effort wipe the entire job folder in the renders bucket
//      (master + thumbnail + per-scene clips + intermediates).
//   3. Hard-delete the audit row so the entry disappears from the library.
//   We do storage delete FIRST so a partial failure leaves the row
//   visible — better than orphan files with no UI to clean them up.

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

export default async function handler(request, response) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method !== "GET" && request.method !== "DELETE") {
    response.status(405).json({ status: "failed", error: "Use GET or DELETE /api/library." });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    response.status(503).json({
      status: "failed",
      error: "Library is unavailable: Supabase env vars missing on server."
    });
    return;
  }

  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    response.status(401).json({ status: "failed", error: "Sign in required." });
    return;
  }
  const token = auth.slice(7);

  try {
    // Resolve the caller's user id.
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) {
      response.status(401).json({ status: "failed", error: "Authentication invalid or expired." });
      return;
    }
    const userPayload = await userRes.json().catch(() => ({}));
    const userId = userPayload?.id;
    if (!userId) {
      response.status(401).json({ status: "failed", error: "Authentication invalid." });
      return;
    }

    const url = new URL(request.url || "", "http://localhost");

    // DELETE branch — wipe one library entry the caller owns.
    if (request.method === "DELETE") {
      const jobId = String(url.searchParams.get("jobId") || "").trim();
      if (!jobId) {
        response.status(400).json({ status: "failed", error: "jobId query param required." });
        return;
      }
      return await handleDelete(response, userId, jobId);
    }

    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));

    // Query the audit log scoped to this agent. Order newest first.
    // Only show completed renders (we don't want failed/in-progress noise).
    const queryUrl =
      `${SUPABASE_URL}/rest/v1/render_audit_log` +
      `?agent_user_id=eq.${encodeURIComponent(userId)}` +
      `&status=eq.completed` +
      `&master_mp4_url=neq.` +
      `&order=created_at.desc` +
      `&limit=${limit}&offset=${offset}` +
      `&select=*`;

    const auditRes = await fetch(queryUrl, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      }
    });

    if (!auditRes.ok) {
      const body = await auditRes.text().catch(() => "");
      // Audit table doesn't exist yet — graceful empty state with hint.
      if (auditRes.status === 404 && /PGRST205|Could not find the table/i.test(body)) {
        response.status(200).json({
          status: "ok",
          library: [],
          note: "Render history will start appearing here after you apply supabase/migrations/04_brokerages.sql in your Supabase project."
        });
        return;
      }
      throw new Error(`Audit log fetch failed (${auditRes.status}): ${body.slice(0, 200)}`);
    }

    const rows = await auditRes.json().catch(() => []);
    response.status(200).json({
      status: "ok",
      library: rows.map((row) => ({
        id: row.id,
        jobId: row.job_id,
        engine: row.engine,
        listingAddress: row.listing_address || "",
        listingCity: row.listing_city || "",
        listingPrice: row.listing_price || "",
        projectTitle: row.project_title || row.listing_address || "Untitled listing",
        mp4Url: row.master_mp4_url || "",
        thumbnailUrl: row.thumbnail_url || "",
        socialShortCount: Number(row.social_short_count || 0),
        formatsCount: Number(row.formats_count || 1),
        narrationApplied: Boolean(row.narration_applied),
        narrationVoiceId: row.narration_voice_id || null,
        // v46 (Troy's smoke test): the client used to GUESS clone-vs-preset
        // from the ID's shape (kebab = preset) — but the worker resolves
        // preset slugs to RAW ElevenLabs IDs before the audit write, so
        // every narrated render read as "Your cloned voice". Classify
        // server-side against the premade catalog instead.
        narrationVoiceKind: classifyNarrationVoice(row.narration_voice_id),
        // Per-scene metadata for the LibraryDetailModal's regen UI. Older
        // renders predating the v16 migration won't have this — UI shows a
        // "regen requires re-render once" hint in that case.
        scenes: Array.isArray(row.scenes) ? row.scenes : [],
        // v23.2 diagnostic fields. The LibraryDetailModal renders a small
        // "Render details" panel from these so the user can see exactly
        // what shipped (or didn't) on every render.
        promptVersion: row.prompt_version || null,
        renderConfig: row.render_config || null,
        createdAt: row.created_at
      })),
      pagination: { limit, offset, returned: rows.length }
    });
  } catch (error) {
    response.status(500).json({
      status: "failed",
      error: error.message || "Library request failed."
    });
  }
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/**
 * Parse a public Supabase Storage URL to extract bucket + parent folder.
 * URL shape: <SUPABASE_URL>/storage/v1/object/public/<bucket>/<folder...>/master.mp4
 * Returns { bucket, folder } or null if it doesn't look like a Supabase
 * Storage URL we can wipe.
 */
function parseStorageFolderFromMasterUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Path is "/storage/v1/object/public/{bucket}/{folder}/master.mp4"
    // (or "/storage/v1/object/sign/..." for signed URLs — also supported).
    const m = u.pathname.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const bucket = decodeURIComponent(m[1]);
    const fullPath = decodeURIComponent(m[2]);
    // Strip filename — we want the folder so all sibling files (variants,
    // thumbnails, per-scene clips) get wiped together.
    const lastSlash = fullPath.lastIndexOf("/");
    if (lastSlash <= 0) return null;
    const folder = fullPath.slice(0, lastSlash);
    return { bucket, folder };
  } catch {
    return null;
  }
}

/* ============================================================
   DELETE handler — wipes one library entry + its storage assets.
   Caller must own the audit row (agent_user_id match).
   ============================================================ */
async function handleDelete(response, userId, jobId) {
  // 1) Fetch the audit row. We need the master URL to derive the storage
  //    folder + a strict ownership check.
  const lookupUrl =
    `${SUPABASE_URL}/rest/v1/render_audit_log` +
    `?agent_user_id=eq.${encodeURIComponent(userId)}` +
    `&job_id=eq.${encodeURIComponent(jobId)}` +
    `&select=id,master_mp4_url,thumbnail_url,scenes&limit=1`;

  const lookupRes = await fetch(lookupUrl, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    }
  });
  if (!lookupRes.ok) {
    const body = await lookupRes.text().catch(() => "");
    response.status(500).json({
      status: "failed",
      error: `Lookup failed (${lookupRes.status}): ${body.slice(0, 200)}`
    });
    return;
  }
  const rows = await lookupRes.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    // Either doesn't exist or isn't owned by caller — same response so we
    // don't leak existence to a different user.
    response.status(404).json({
      status: "failed",
      error: "Library entry not found (or not yours to delete)."
    });
    return;
  }
  const row = rows[0];

  // 2) Best-effort storage cleanup. Parse the master URL to derive
  //    (bucket, folder) so we don't need to know whether the upload used
  //    the runway/ or remotion/ path prefix. Master URL pattern:
  //      <SUPABASE_URL>/storage/v1/object/public/<bucket>/<userId>/<engine>/<jobId>/master.mp4
  //    Worker writes both per-scene clips + variants into the same
  //    {bucket}/{folder} folder so one DELETE-by-prefix wipes everything.
  const storageWarnings = [];
  const parsed = parseStorageFolderFromMasterUrl(row.master_mp4_url || "");
  if (!parsed) {
    storageWarnings.push("Could not derive storage folder from master URL — files left in place.");
  } else {
    const { bucket, folder } = parsed;
    try {
      // List everything under the folder so we can DELETE by full key.
      const listRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
        {
          method: "POST",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            prefix: folder,
            limit: 1000,
            offset: 0,
            sortBy: { column: "name", order: "asc" }
          })
        }
      );
      if (listRes.ok) {
        const objects = await listRes.json().catch(() => []);
        const keys = Array.isArray(objects)
          ? objects.map((o) => `${folder}/${o.name}`)
          : [];
        if (keys.length > 0) {
          const delRes = await fetch(
            `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}`,
            {
              method: "DELETE",
              headers: {
                apikey: SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ prefixes: keys })
            }
          );
          if (!delRes.ok) {
            const txt = await delRes.text().catch(() => "");
            storageWarnings.push(`Storage delete returned ${delRes.status}: ${txt.slice(0, 120)}`);
          }
        }
      } else {
        // List failure isn't fatal — the row still gets deleted so the user
        // sees their library shrink. Orphaned files are a janitor problem.
        const txt = await listRes.text().catch(() => "");
        storageWarnings.push(`Storage list returned ${listRes.status}: ${txt.slice(0, 120)}`);
      }
    } catch (err) {
      storageWarnings.push(`Storage cleanup threw: ${err.message || err}`);
    }
  }

  // 3) Hard-delete the audit row. Scoped by agent_user_id + id so we can
  //    NEVER delete someone else's row even with a stolen jobId.
  const delRowRes = await fetch(
    `${SUPABASE_URL}/rest/v1/render_audit_log` +
      `?id=eq.${encodeURIComponent(row.id)}` +
      `&agent_user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal"
      }
    }
  );
  if (!delRowRes.ok) {
    const txt = await delRowRes.text().catch(() => "");
    response.status(500).json({
      status: "failed",
      error: `Row delete failed (${delRowRes.status}): ${txt.slice(0, 200)}`,
      storageWarnings
    });
    return;
  }

  response.status(200).json({
    status: "ok",
    deleted: { jobId, auditRowId: row.id },
    storageWarnings: storageWarnings.length ? storageWarnings : undefined
  });
}

/* ============================================================
   v46 — narration voice classification.
   Mirrors render-worker/src/voices.mjs VOICE_SLUG_TO_ID (same env
   overrides, same defaults — the two-copy convention api/voices.js
   documents). The worker stores the RESOLVED ElevenLabs ID in
   narration_voice_id, so "is it a preset?" must be answered against
   this list, never against the ID's shape.
   ============================================================ */
const PREMADE_VOICE_IDS = new Set([
  process.env.EVOICE_LUXURY_WARM     || "EXAVITQu4vr4xnSDxMaL", // Sarah
  process.env.EVOICE_LUXURY_MALE     || "pNInz6obpgDQGcFmaJgB", // Adam
  process.env.EVOICE_LUXURY_BRITISH  || "XB0fDUnXU5powFXDhCwa", // Charlotte
  process.env.EVOICE_VIRAL_ENERGETIC || "XrExE9yKIg1WjnnlVkGX", // Matilda
  process.env.EVOICE_VIRAL_CONFIDENT || "AZnzlk1XvdvUeBnXmlld", // Domi
  process.env.EVOICE_INVESTOR_DEEP   || "29vD33N1CtxCmqQRPOHJ", // Drew
  process.env.EVOICE_MLS_NEUTRAL     || "21m00Tcm4TlvDq8ikWAM"  // Rachel
]);

function classifyNarrationVoice(voiceId) {
  const id = String(voiceId || "").trim();
  if (!id) return null;
  // Premade catalog ID, or a legacy row that stored the slug itself.
  if (PREMADE_VOICE_IDS.has(id) || /^[a-z]+-[a-z]+$/.test(id)) return "preset";
  return "cloned";
}
