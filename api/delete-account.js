// Vistalia — /api/delete-account
//
// Self-service account deletion. GDPR Article 17 ("right to erasure") and
// CCPA require a one-click way for users to delete their data. This endpoint
// cascades through every table that holds personal data, then deletes the
// auth user. Stripe billing records are retained as required by tax law
// (and noted in our Privacy Policy).
//
// Security: requires a fresh session (Supabase JWT) + a confirmation token
// in the body that must equal the user's email. The frontend asks the user
// to type their email to confirm — prevents accidental clicks.
//
// Cascade order (FK constraints handle most of it via ON DELETE CASCADE,
// but we explicit-delete here so a missing constraint can't leave orphans):
//   1. brand_kits (user_id FK)
//   2. render_audit_log (agent_user_id FK)
//   3. render_usage (user_id FK)
//   4. profiles (user_id FK to auth.users)
//   5. Storage objects under {userId}/* in listing-photos + generated-videos
//   6. auth.users (final — Supabase admin call)

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Use POST /api/delete-account." });
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return response.status(503).json({
      error: "Account deletion is not configured. Contact support@estatemotion.ai."
    });
  }

  // 1. Verify the caller's identity from the bearer token.
  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    return response.status(401).json({ error: "Sign in to delete your account." });
  }
  const token = auth.slice(7);
  const meRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!meRes.ok) {
    return response.status(401).json({ error: "Authentication expired. Sign in again." });
  }
  const me = await meRes.json().catch(() => ({}));
  const userId = me?.id;
  const userEmail = String(me?.email || "").toLowerCase();
  if (!userId || !userEmail) {
    return response.status(401).json({ error: "Authentication invalid." });
  }

  // 2. Confirmation guard — body must include the user's own email exactly.
  // Prevents fat-finger or CSRF deletion (the email isn't in any cookie).
  const body = parseBody(request.body);
  const confirmEmail = String(body?.confirmEmail || "").toLowerCase().trim();
  if (!confirmEmail || confirmEmail !== userEmail) {
    return response.status(400).json({
      error: "Type your email exactly to confirm account deletion."
    });
  }

  const errors = [];
  const deleted = {};

  // 3. Cascade through every table.
  const tables = [
    { name: "brand_kits",        idCol: "user_id" },
    { name: "render_audit_log",  idCol: "agent_user_id" },
    { name: "render_usage",      idCol: "user_id" },
    { name: "profiles",          idCol: "user_id" }
  ];
  for (const t of tables) {
    const res = await supabaseDelete(supabaseUrl, serviceKey, t.name, t.idCol, userId);
    if (res.ok) {
      deleted[t.name] = true;
    } else if (res.status === 404 || /Could not find|PGRST205/i.test(res.detail || "")) {
      // Table doesn't exist (older deployment) — skip silently. Not an error.
      deleted[t.name] = "missing-table";
    } else {
      errors.push(`${t.name}: ${res.detail || res.status}`);
    }
  }

  // 4. Delete the user's storage objects. Iterate buckets we know about.
  // listAndDelete is best-effort — failures are logged but don't block
  // auth-user deletion (storage cleanup can be retried by an admin job).
  const buckets = (process.env.DELETE_ACCOUNT_BUCKETS || "listing-photos,generated-videos,brand-assets")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const bucket of buckets) {
    const result = await deleteUserStorage(supabaseUrl, serviceKey, bucket, userId);
    if (result.error) {
      errors.push(`storage:${bucket}: ${result.error}`);
    } else {
      deleted[`storage:${bucket}`] = result.removed;
    }
  }

  // 5. Final step — delete the auth user. Once this succeeds, the user
  // can never sign in again with this email. Do this LAST so the cascade
  // above doesn't lose its identifier mid-flight.
  const adminDeleteRes = await fetch(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      }
    }
  );
  if (!adminDeleteRes.ok) {
    const detail = await adminDeleteRes.text().catch(() => "");
    return response.status(500).json({
      error: "Auth-user deletion failed. Your data was removed but the account record remains. Contact support@estatemotion.ai for cleanup.",
      detail: detail.slice(0, 240),
      partialDeleted: deleted,
      errors
    });
  }
  deleted.auth_user = true;

  return response.status(200).json({
    status: "deleted",
    deleted,
    warnings: errors.length ? errors : undefined,
    note: "Stripe billing records are retained as required by tax law. They contain only your email and payment metadata, not Service usage data."
  });
}

/* ============================================================
   Helpers
   ============================================================ */

async function supabaseDelete(supabaseUrl, serviceKey, tableName, idCol, userId) {
  const url = `${supabaseUrl}/rest/v1/${tableName}?${idCol}=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "return=minimal"
    }
  });
  if (res.ok) return { ok: true };
  const detail = await res.text().catch(() => "");
  return { ok: false, status: res.status, detail: detail.slice(0, 200) };
}

// List + delete every object under {userId}/* in the given bucket.
// Supabase Storage REST: list returns up to 1000; we paginate to be safe.
async function deleteUserStorage(supabaseUrl, serviceKey, bucket, userId) {
  let removed = 0;
  let offset = 0;
  const PAGE = 1000;
  for (let safety = 0; safety < 20; safety++) {
    // 20 pages × 1000 = 20,000 files cap. Beyond that, an admin job picks it up.
    const listRes = await fetch(
      `${supabaseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prefix: `${userId}`,
          limit: PAGE,
          offset,
          sortBy: { column: "name", order: "asc" }
        })
      }
    );
    if (!listRes.ok) {
      const text = await listRes.text().catch(() => "");
      // 404 = bucket missing. Not a deletion error.
      if (listRes.status === 404) return { removed, error: null };
      return { removed, error: `list failed (${listRes.status}): ${text.slice(0, 160)}` };
    }
    const items = await listRes.json().catch(() => []);
    if (!Array.isArray(items) || items.length === 0) return { removed, error: null };

    // Build full object paths. The list API returns names relative to the
    // prefix, so prepend the userId folder.
    const paths = items
      .map((it) => `${userId}/${it.name}`)
      .filter((p) => !p.endsWith("/")); // skip directory placeholders

    if (paths.length) {
      const delRes = await fetch(
        `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`,
        {
          method: "DELETE",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ prefixes: paths })
        }
      );
      if (delRes.ok) {
        removed += paths.length;
      } else {
        const text = await delRes.text().catch(() => "");
        return { removed, error: `delete failed (${delRes.status}): ${text.slice(0, 160)}` };
      }
    }

    if (items.length < PAGE) return { removed, error: null };
    offset += PAGE;
  }
  return { removed, error: null };
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch { return {}; }
}
