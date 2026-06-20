// Vistalia — /api/export-account
//
// Returns a JSON manifest of the signed-in user's data: brand kit, library
// (with deep links to every rendered file), and account profile. Intended
// to be downloaded by the user before they delete their account, satisfying
// the GDPR "right to data portability" alongside the deletion endpoint.
//
// Format: a single JSON document. Listing photos and rendered videos are
// NOT inlined (they're large) — instead we emit their public URLs the
// user can curl/wget themselves.

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "GET") {
    return response.status(405).json({ error: "Use GET /api/export-account." });
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return response.status(503).json({ error: "Export is not configured." });
  }

  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    return response.status(401).json({ error: "Sign in to export your data." });
  }
  const token = auth.slice(7);
  const meRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!meRes.ok) {
    return response.status(401).json({ error: "Authentication expired." });
  }
  const me = await meRes.json().catch(() => ({}));
  const userId = me?.id;
  if (!userId) return response.status(401).json({ error: "Authentication invalid." });

  // Pull each table in parallel.
  const [profile, brandKits, library] = await Promise.all([
    supabaseSelect(supabaseUrl, serviceKey, `profiles?user_id=eq.${userId}&select=*`),
    supabaseSelect(supabaseUrl, serviceKey, `brand_kits?user_id=eq.${userId}&select=*`),
    supabaseSelect(supabaseUrl, serviceKey,
      `render_audit_log?agent_user_id=eq.${userId}&order=created_at.desc&select=*`
    )
  ]);

  // Strip Stripe + auth fields the user doesn't need to see (and that we
  // don't want in a shared export). Everything else passes through.
  const sanitizedProfile = (profile?.[0] || null);
  if (sanitizedProfile) {
    delete sanitizedProfile.stripe_subscription_id;
    delete sanitizedProfile.stripe_customer_id;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    accountVersion: 1,
    note: "This is a portable snapshot of your Vistalia data. Listing photos and rendered videos are linked by URL (not inlined). Save this file before deleting your account if you'd like a record.",
    user: {
      id: userId,
      email: me?.email || "",
      created_at: me?.created_at,
      email_confirmed_at: me?.email_confirmed_at
    },
    profile: sanitizedProfile,
    brand_kits: brandKits || [],
    library: (library || []).map((row) => ({
      job_id: row.job_id,
      created_at: row.created_at,
      engine: row.engine,
      listing_address: row.listing_address,
      listing_city: row.listing_city,
      listing_price: row.listing_price,
      project_title: row.project_title,
      master_mp4_url: row.master_mp4_url,
      thumbnail_url: row.thumbnail_url,
      narration_applied: row.narration_applied,
      formats_count: row.formats_count,
      social_short_count: row.social_short_count,
      scenes: Array.isArray(row.scenes) ? row.scenes.map((s) => ({
        sceneIndex: s.sceneIndex,
        roomType: s.roomType,
        clipUrl: s.clipUrl,
        photoUrl: s.photoUrl
      })) : []
    }))
  };

  // Serve as a downloadable JSON file. The Content-Disposition prompts
  // the browser to save instead of render in-tab.
  const date = new Date().toISOString().split("T")[0];
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="estatemotion-export-${date}.json"`);
  return response.status(200).send(JSON.stringify(payload, null, 2));
}

async function supabaseSelect(supabaseUrl, serviceKey, pathAndQuery) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      }
    });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
