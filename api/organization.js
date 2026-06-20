// Vistalia — Organization API
//
// Handles the brokerage tier surface:
//   GET  /api/organization                   → caller's primary org + role
//   POST /api/organization                   → create a new org (caller becomes owner)
//   GET  /api/organization?audit=1           → audit log (admins only, paginated)
//   GET  /api/organization?roster=1          → member roster (admins only)
//
// All requests require a Supabase JWT in Authorization: Bearer <token>.
// Insert / lookup / mutation use the service role key so we can bypass
// RLS at the right moments (creating an org needs to insert both the row
// and the owner-membership atomically before any RLS policies could
// accept the second insert).

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

export default async function handler(request, response) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    response.status(503).json({
      status: "failed",
      error: "Brokerage admin is unavailable: Supabase env vars missing."
    });
    return;
  }

  const authHeader = String(request.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) {
    response.status(401).json({ status: "failed", error: "Sign in required." });
    return;
  }
  const token = authHeader.slice(7);

  // Resolve the caller's user id once. Every code path needs it.
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

  try {
    if (request.method === "GET") {
      const url = new URL(request.url || "", "http://localhost");
      if (url.searchParams.get("audit") === "1") {
        await handleAuditLog({ userId, response, url });
        return;
      }
      if (url.searchParams.get("roster") === "1") {
        await handleRoster({ userId, response });
        return;
      }
      await handleGetOrganization({ userId, response });
      return;
    }

    if (request.method === "POST") {
      await handleCreateOrganization({ userId, request, response });
      return;
    }

    response.status(405).json({ status: "failed", error: "Method not allowed." });
  } catch (error) {
    response.status(500).json({
      status: "failed",
      error: error.message || "Organization request failed."
    });
  }
}

/* ============================================================
   GET — caller's primary organization
   ============================================================ */
async function handleGetOrganization({ userId, response }) {
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_user_organization`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ p_user_id: userId })
  });
  if (!rpcRes.ok) {
    const text = await rpcRes.text().catch(() => "");
    throw new Error(`get_user_organization RPC failed (${rpcRes.status}): ${text.slice(0, 200)}`);
  }
  const rows = await rpcRes.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : rows;

  if (!row) {
    response.status(200).json({ status: "ok", organization: null });
    return;
  }

  response.status(200).json({
    status: "ok",
    organization: {
      id: row.organization_id,
      name: row.organization_name,
      slug: row.organization_slug,
      tier: row.organization_tier,
      state: row.organization_state,
      licenseNumber: row.organization_license_number,
      logoUrl: row.organization_logo_url,
      accentColor: row.organization_accent_color,
      role: row.role,
      joinedAt: row.joined_at,
      agentSeatCap: row.agent_seat_cap,
      agentSeatCount: Number(row.agent_seat_count_used || 0)
    }
  });
}

/* ============================================================
   POST — create a new org and make caller the owner
   ============================================================ */
async function handleCreateOrganization({ userId, request, response }) {
  const body = parseBody(request.body);
  const name = String(body.name || "").trim();
  const state = String(body.state || "").trim().toUpperCase().slice(0, 2);
  const licenseNumber = String(body.licenseNumber || "").trim().slice(0, 60);

  if (!name || name.length < 2) {
    response.status(400).json({ status: "failed", error: "Brokerage name is required." });
    return;
  }
  if (state && !/^[A-Z]{2}$/.test(state)) {
    response.status(400).json({ status: "failed", error: "State must be a 2-letter US code (CA, TX, AZ, etc)." });
    return;
  }

  // Block duplicate org-per-owner for now. A user creating their second
  // org should be an explicit edge case (multi-brokerage broker) we
  // surface in a follow-up.
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/organization_members?user_id=eq.${userId}&select=organization_id`,
    { headers: serviceHeaders() }
  );
  const existing = await existingRes.json().catch(() => []);
  if (Array.isArray(existing) && existing.length > 0) {
    response.status(409).json({
      status: "failed",
      error: "You already belong to a brokerage. Contact support to switch organizations."
    });
    return;
  }

  const slug = slugify(name);
  const orgInsertRes = await fetch(`${SUPABASE_URL}/rest/v1/organizations`, {
    method: "POST",
    headers: { ...serviceHeaders(), Prefer: "return=representation" },
    body: JSON.stringify([
      {
        name,
        slug,
        state: state || null,
        license_number: licenseNumber || null,
        created_by: userId,
        tier: "team",
        agent_seat_cap: 5
      }
    ])
  });
  if (!orgInsertRes.ok) {
    const text = await orgInsertRes.text().catch(() => "");
    throw new Error(`Org insert failed (${orgInsertRes.status}): ${text.slice(0, 240)}`);
  }
  const inserted = await orgInsertRes.json().catch(() => []);
  const org = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!org?.id) {
    throw new Error("Org insert returned no row.");
  }

  // Add caller as owner.
  const memberRes = await fetch(`${SUPABASE_URL}/rest/v1/organization_members`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify([
      {
        organization_id: org.id,
        user_id: userId,
        role: "owner"
      }
    ])
  });
  if (!memberRes.ok) {
    const text = await memberRes.text().catch(() => "");
    throw new Error(`Membership insert failed (${memberRes.status}): ${text.slice(0, 240)}`);
  }

  response.status(201).json({
    status: "ok",
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      tier: org.tier,
      state: org.state,
      licenseNumber: org.license_number,
      logoUrl: org.logo_url,
      accentColor: org.accent_color,
      role: "owner",
      joinedAt: new Date().toISOString(),
      agentSeatCap: org.agent_seat_cap,
      agentSeatCount: 1
    }
  });
}

/* ============================================================
   GET ?audit=1 — render audit log for the org (admins only)
   ============================================================ */
async function handleAuditLog({ userId, response, url }) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));

  const orgInfo = await resolveOrgAndRole(userId);
  if (!orgInfo) {
    response.status(403).json({ status: "failed", error: "You are not part of a brokerage." });
    return;
  }
  if (!["owner", "admin"].includes(orgInfo.role)) {
    response.status(403).json({ status: "failed", error: "Only owners and admins can view the audit log." });
    return;
  }

  const auditRes = await fetch(
    `${SUPABASE_URL}/rest/v1/render_audit_log` +
      `?organization_id=eq.${orgInfo.organizationId}` +
      `&order=created_at.desc` +
      `&limit=${limit}&offset=${offset}` +
      `&select=*`,
    { headers: serviceHeaders() }
  );
  if (!auditRes.ok) {
    const text = await auditRes.text().catch(() => "");
    throw new Error(`Audit log fetch failed (${auditRes.status}): ${text.slice(0, 200)}`);
  }
  const rows = await auditRes.json().catch(() => []);

  // Hydrate with agent emails so the dashboard can show "rendered by ..."
  const agentIds = [...new Set(rows.map((r) => r.agent_user_id).filter(Boolean))];
  const agents = agentIds.length ? await lookupAgents(agentIds) : {};

  response.status(200).json({
    status: "ok",
    auditLog: rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      engine: row.engine,
      agentUserId: row.agent_user_id,
      agentEmail: agents[row.agent_user_id]?.email || "",
      agentDisplayName: agents[row.agent_user_id]?.fullName || "",
      listingAddress: row.listing_address,
      listingCity: row.listing_city,
      listingPrice: row.listing_price,
      projectTitle: row.project_title,
      mp4Url: row.master_mp4_url,
      thumbnailUrl: row.thumbnail_url,
      socialShortCount: row.social_short_count,
      formatsCount: row.formats_count,
      narrationApplied: row.narration_applied,
      status: row.status,
      errorMessage: row.error_message,
      createdAt: row.created_at
    })),
    pagination: { limit, offset, returned: rows.length }
  });
}

/* ============================================================
   GET ?roster=1 — agents in the org (admins only)
   ============================================================ */
async function handleRoster({ userId, response }) {
  const orgInfo = await resolveOrgAndRole(userId);
  if (!orgInfo) {
    response.status(403).json({ status: "failed", error: "You are not part of a brokerage." });
    return;
  }
  if (!["owner", "admin"].includes(orgInfo.role)) {
    response.status(403).json({ status: "failed", error: "Only owners and admins can view the roster." });
    return;
  }

  const memberRes = await fetch(
    `${SUPABASE_URL}/rest/v1/organization_members` +
      `?organization_id=eq.${orgInfo.organizationId}` +
      `&order=joined_at.asc` +
      `&select=user_id,role,joined_at`,
    { headers: serviceHeaders() }
  );
  if (!memberRes.ok) throw new Error(`Roster fetch failed (${memberRes.status}).`);
  const members = await memberRes.json().catch(() => []);
  const userIds = members.map((m) => m.user_id);
  const profiles = userIds.length ? await lookupAgents(userIds) : {};

  // Per-agent render counts (last 30 days)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const countsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/render_audit_log` +
      `?organization_id=eq.${orgInfo.organizationId}` +
      `&created_at=gte.${encodeURIComponent(since)}` +
      `&select=agent_user_id`,
    { headers: serviceHeaders() }
  );
  const countRows = await countsRes.json().catch(() => []);
  const renderCounts = {};
  for (const row of countRows) {
    renderCounts[row.agent_user_id] = (renderCounts[row.agent_user_id] || 0) + 1;
  }

  response.status(200).json({
    status: "ok",
    roster: members.map((m) => ({
      userId: m.user_id,
      role: m.role,
      joinedAt: m.joined_at,
      email: profiles[m.user_id]?.email || "",
      fullName: profiles[m.user_id]?.fullName || "",
      rendersLast30Days: renderCounts[m.user_id] || 0
    }))
  });
}

/* ============================================================
   Helpers
   ============================================================ */

async function resolveOrgAndRole(userId) {
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_user_organization`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ p_user_id: userId })
  });
  if (!rpcRes.ok) return null;
  const rows = await rpcRes.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.organization_id) return null;
  return { organizationId: row.organization_id, role: row.role };
}

async function lookupAgents(userIds) {
  if (!userIds.length) return {};
  // Pull from the auth.users table via the admin REST API. We expose only
  // email + raw_user_meta_data (full_name) — never the password hash.
  const result = {};
  // Supabase admin endpoint accepts up to 200 lookups per call. Chunk if more.
  for (const chunk of chunkArray(userIds, 50)) {
    const idFilter = `(${chunk.map((id) => `"${id}"`).join(",")})`;
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?ids=in.${encodeURIComponent(idFilter)}`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`
        }
      }
    );
    if (!res.ok) continue;
    const payload = await res.json().catch(() => ({}));
    const users = Array.isArray(payload?.users) ? payload.users : [];
    for (const u of users) {
      result[u.id] = {
        email: u.email || "",
        fullName: u.user_metadata?.full_name || u.raw_user_meta_data?.full_name || ""
      };
    }
  }
  return result;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function serviceHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "brokerage";
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}
