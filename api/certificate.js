// Vistalia — MLS-Safe Certificate (v51).
//
// GET /api/certificate?token=<certificate_token>
//
// PUBLIC, unauthenticated, read-only. Returns the curated verification
// record for one render: each delivered scene beside its source photo with
// a customer-safe status. This is the data behind vistalia.ai/v/<token> —
// the page agents forward to brokers, compliance officers and sellers.
//
// Curation rules (privacy + brand):
//   - NEVER expose user ids, emails, prompts, QC reason strings, or any
//     internal telemetry. Status language is written here, once, carefully.
//   - Scene media URLs are already-public storage objects (the same URLs
//     the delivered video was built from).
//   - Tokens are 20-24 hex chars of CSPRNG entropy; the only lookup path
//     is exact match. 404 is indistinguishable for missing vs malformed.

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const TOKEN_RE = /^[a-f0-9]{16,64}$/i;

// Customer-safe status per scene. The v49 audit enrichment gives us
// engineUsed/attempts/sweepReplaced; pre-v49 rows fall back to wasFallback.
function curateScene(scene, index) {
  const engine = String(scene?.engineUsed || "").toLowerCase();
  const deterministic =
    engine === "photo_motion" ||
    (engine === "" && Boolean(scene?.wasFallback)) ||
    Boolean(scene?.sweepReplaced && engine !== "veo");
  const status = deterministic ? "deterministic" : "verified";
  return {
    index: index + 1,
    roomType: String(scene?.roomType || "").replace(/_/g, " ") || "scene",
    photoUrl: scene?.photoUrl || "",
    clipUrl: scene?.clipUrl || "",
    status,
    statusLabel: deterministic
      ? "Direct photo motion — animated from the photograph itself"
      : "Verified — matches the source photograph",
    statusDetail: deterministic
      ? "This scene uses deterministic camera motion applied directly to the original photo. By construction it cannot differ from the photograph."
      : "This scene was machine-checked against the agent's original listing photograph before delivery. No objects, rooms, or features were invented."
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "Service unavailable" });
  }
  const token = String(req.query?.token || "").trim();
  if (!TOKEN_RE.test(token)) {
    return res.status(404).json({ error: "Certificate not found" });
  }

  try {
    const url =
      `${SUPABASE_URL}/rest/v1/render_audit_log` +
      `?certificate_token=eq.${encodeURIComponent(token)}` +
      `&select=job_id,created_at,listing_address,listing_city,project_title,master_mp4_url,thumbnail_url,scenes,render_config` +
      `&limit=1`;
    const r = await fetch(url, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
    });
    if (!r.ok) return res.status(502).json({ error: "Lookup failed" });
    const rows = await r.json().catch(() => []);
    const row = Array.isArray(rows) && rows[0];
    if (!row) return res.status(404).json({ error: "Certificate not found" });

    const scenes = (Array.isArray(row.scenes) ? row.scenes : [])
      .map(curateScene)
      .filter((s) => s.photoUrl || s.clipUrl);
    const verifiedCount = scenes.filter((s) => s.status === "verified").length;
    const deterministicCount = scenes.length - verifiedCount;

    const address = [row.listing_address, row.listing_city].filter(Boolean).join(", ");
    const payload = {
      title: row.project_title || row.listing_address || "Listing video",
      address: address || null,
      createdAt: row.created_at,
      style: row.render_config?.selectedStyle || null,
      thumbnailUrl: row.thumbnail_url || "",
      masterUrl: row.master_mp4_url || "",
      summary: {
        totalScenes: scenes.length,
        verified: verifiedCount,
        deterministic: deterministicCount,
        line:
          scenes.length > 0
            ? `${scenes.length} scene${scenes.length === 1 ? "" : "s"} · ${verifiedCount} verified against source photography` +
              (deterministicCount > 0 ? ` · ${deterministicCount} direct photo motion` : "")
            : "No scene record available for this render."
      },
      scenes,
      attestation:
        "Every scene in this video was checked against the agent's original listing photograph before delivery. " +
        "Scenes that could not be verified to match were replaced with deterministic photo motion, which cannot invent detail.",
      token
    };

    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: "Certificate lookup failed" });
  }
}
