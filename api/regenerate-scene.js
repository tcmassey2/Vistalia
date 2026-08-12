// Vistalia — /api/regenerate-scene
//
// Vercel-side proxy for per-scene regenerate. Forwards the frontend's request
// to the render-worker /regenerate-scene endpoint. The worker handles the
// heavy lifting (one Runway clip OR Ken Burns, download the other 23 from
// Supabase, re-stitch, re-upload, update audit row).
//
// Why this proxy exists instead of calling the worker directly from the app:
//   1. Keeps RENDER_WORKER_SECRET on the server side, never in the browser.
//   2. Lets us do the same tier/quota guard as a regular render (a regen
//      still spends Runway credits unless mode=kenburns).
//   3. CORS — the worker only needs to trust our Vercel origin.
//
// Status polling reuses GET /api/render?jobId=<progressKey>. The worker
// returns 202 with `jobId` set to "<originalJobId>:regen:<sceneIndex>" — the
// frontend polls /api/render?jobId=<progressKey> just like any other job.

import { rateLimit } from "./_lib/rate-limit.js";

const DEFAULT_TIMEOUT_MS = 1000 * 60 * 8;

export default async function handler(request, response) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  // v60.2: same maintenance gate as /api/render — scene regens spend fal
  // credits too. See render.js for semantics.
  if (
    request.method === "POST" &&
    String(process.env.MAINTENANCE_MODE || "").toLowerCase() === "true" &&
    !(process.env.CRON_SECRET && String(request.headers["x-internal-secret"] || "") === process.env.CRON_SECRET)
  ) {
    return response.status(503).json({
      maintenance: true,
      error:
        "Vistalia is briefly down for scheduled maintenance — rendering is paused and will be back shortly. " +
        "Your photos, projects, and finished videos are safe."
    });
  }

  if (request.method !== "POST") {
    response.status(405).json({
      status: "failed",
      error: "Use POST /api/regenerate-scene with { jobId, sceneIndex, mode, manifest }."
    });
    return;
  }

  // Each AI regen burns one Runway credit (~$0.25). 20/hour caps the
  // pathological case at $5/hour per user; honest users hit this 1-3
  // times per project to fix individual hallucinations.
  const limited = await rateLimit(request, response, {
    bucket: "regen",
    max: 20,
    windowMs: 60 * 60 * 1000
  });
  if (limited) return;

  try {
    const body = parseBody(request.body);
    const { jobId, sceneIndex, mode, manifest } = body || {};

    if (!jobId) {
      response.status(400).json({ status: "failed", error: "regenerate-scene requires jobId." });
      return;
    }
    if (!Number.isInteger(sceneIndex) || sceneIndex < 0) {
      response.status(400).json({ status: "failed", error: "regenerate-scene requires sceneIndex (non-negative integer)." });
      return;
    }
    // v62.38: AI regen is retired — every replacement is a deterministic
    // steady shot at the original scene's exact length, so the voiceover is
    // preserved rather than re-synthesized. Legacy mode values are accepted
    // (older clients still send them) and all mean the same thing now.
    const normalizedMode = String(mode || "steady").toLowerCase();
    if (!["ai", "kenburns", "steady"].includes(normalizedMode)) {
      response.status(400).json({ status: "failed", error: "mode must be 'steady' (legacy 'ai'/'kenburns' accepted)." });
      return;
    }
    if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
      response.status(400).json({ status: "failed", error: "manifest with scenes[] is required." });
      return;
    }

    // Tier guard — v62.38: the steady-shot replacement spends no fal or
    // ElevenLabs money (deterministic floor + restitch), so it's gated like
    // the free engine: any tier with rendering enabled can fix a scene.
    const tierGuard = await enforceTierGuard(request, { ...manifest, engine: "remotion" });
    if (!tierGuard.ok) {
      response.status(tierGuard.status || 402).json({
        status: "failed",
        error: tierGuard.error,
        upgradeRequired: tierGuard.upgradeRequired || false,
        currentTier: tierGuard.currentTier || null
      });
      return;
    }

    // v62.98 (security audit): bind jobId to the caller before touching the
    // worker. The regen re-stitches and re-uploads the master at the job's
    // public URL; a jobId + userId is discoverable from any public certificate
    // link. Without this check a tier-eligible attacker could pass a victim's
    // jobId plus their own manifest and drive a re-stitch on the victim's
    // render. We block only when the audit row PROVES the job belongs to
    // someone else — a missing/owner-less row (older renders) still passes, so
    // no legitimate redo is ever refused.
    const ownership = await verifyJobOwnership(jobId, tierGuard.userId);
    if (!ownership.allow) {
      response.status(403).json({ status: "failed", error: "That render was not found on your account." });
      return;
    }

    // v46: regens re-stitch the whole master, so the free-render watermark
    // must be re-derived here or a trial user's redo would silently launder
    // the mark off. Same rule as /api/render: trial tier + no purchased
    // credits = free = watermarked. (A user who upgraded after their trial
    // render gets an unmarked master on their next redo — upgrade perk.)
    if (
      String(tierGuard.state?.tier || "") === "trial" &&
      Number(tierGuard.state?.render_credits || 0) < 1
    ) {
      manifest.freeRenderWatermark = true;
    }

    // Launch fix: default to LIVE whenever a worker URL is configured (the old
    // hardcoded `true` fallback put production in mock mode when the stale
    // MOCK_RENDERING var was deleted). Explicit MOCK_RENDERING=true still wins.
    if (readFlag("MOCK_RENDERING", !(process.env.RENDER_WORKER_URL || process.env.RENDER_ENDPOINT))) {
      response.status(503).json({
        status: "failed",
        mock: true,
        jobId: `${jobId}:regen:${sceneIndex}`,
        error: "Live rendering is not connected — set MOCK_RENDERING=false to enable per-scene regen."
      });
      return;
    }

    const workerUrl = regenerateWorkerUrl();
    if (!workerUrl) {
      response.status(503).json({
        status: "failed",
        error: "Per-scene regenerate requires RENDER_WORKER_URL or RENDER_ENDPOINT to be configured."
      });
      return;
    }

    const workerResponse = await fetchWithTimeout(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // v26.2: accept either secret name (see render.js workerSecret note).
        ...((process.env.RENDER_WEBHOOK_SECRET || process.env.RENDER_WORKER_SECRET) ? { Authorization: `Bearer ${process.env.RENDER_WEBHOOK_SECRET || process.env.RENDER_WORKER_SECRET}` } : {})
      },
      body: JSON.stringify({
        jobId,
        sceneIndex,
        // v62.38: the worker ignores mode (all replacements are steady
        // shots), but a mid-deploy OLD worker still branches on it —
        // "kenburns" is the value both generations treat as "no AI spend".
        mode: "kenburns",
        manifest
      })
    }, DEFAULT_TIMEOUT_MS);

    const text = await workerResponse.text();
    const payload = parseBody(text);
    response.status(workerResponse.status).json(payload || {
      status: workerResponse.ok ? "queued" : "failed",
      message: text
    });
  } catch (error) {
    response.status(500).json({
      status: "failed",
      error: error.message || "Vistalia regenerate-scene request failed."
    });
  }
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

function readFlag(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1";
}

function regenerateWorkerUrl() {
  const configured = process.env.RENDER_WORKER_URL || process.env.RENDER_ENDPOINT || "";
  if (!configured) return "";
  // RENDER_WORKER_URL is sometimes set to ".../render". Normalize to the
  // worker root, then append /regenerate-scene.
  const root = configured.endsWith("/render")
    ? configured.slice(0, -"/render".length)
    : configured;
  return `${root.replace(/\/$/, "")}/regenerate-scene`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/* ============================================================
   Tier / quota guard — same logic as /api/render, scoped here so
   regen is gated by the same rules. mode=kenburns sidesteps the
   Runway engine check (still free for all paying tiers).
   ============================================================ */
// v62.98 (security audit): does render_audit_log show this jobId belonging to
// a DIFFERENT user? Returns {allow:false} only on a proven cross-tenant match.
// Fail-open on any ambiguity (Supabase unconfigured, lookup blip, missing or
// owner-less row) so a legitimate scene fix is never blocked — the goal is to
// stop tampering with someone else's clearly-owned render, not to gate redos.
async function verifyJobOwnership(jobId, userId) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey || !userId || !jobId) return { allow: true };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/render_audit_log?select=agent_user_id&job_id=eq.${encodeURIComponent(jobId)}&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!res.ok) return { allow: true };
    const rows = await res.json().catch(() => []);
    const owner = Array.isArray(rows) && rows[0] ? rows[0].agent_user_id : null;
    if (owner && owner !== userId) return { allow: false };
    return { allow: true };
  } catch {
    return { allow: true };
  }
}

async function enforceTierGuard(request, manifest) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !anonKey || !serviceKey) return { ok: true };

  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    // v62.38 (adversarial review): this used to fail OPEN for non-runway
    // engines — and v62.38 hardcodes engine "remotion", so an
    // unauthenticated request skipped the tier lookup entirely,
    // tierGuard.state stayed undefined, the trial watermark re-derivation
    // never ran, and the worker trusted the CLIENT-posted
    // freeRenderWatermark. Executed proof: omit the Authorization header →
    // 202 → unmarked master overwrites the trial's marked one at the same
    // public URL. Regen operates on an authenticated user's library entry;
    // there is no anonymous regen. Fail closed.
    return { ok: false, status: 401, error: "Sign in to replace scenes." };
  }

  const token = auth.slice(7);
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!userRes.ok) {
    return { ok: false, status: 401, error: "Authentication expired. Sign in again." };
  }
  const user = await userRes.json().catch(() => ({}));
  const userId = user?.id;
  if (!userId) return { ok: false, status: 401, error: "Authentication invalid." };

  const stateRes = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_tier_state`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_user_id: userId })
  });
  if (!stateRes.ok) {
    console.warn("[regenerate-scene] tier RPC failed", { status: stateRes.status });
    return { ok: true };
  }
  const stateRows = await stateRes.json().catch(() => []);
  const state = Array.isArray(stateRows) ? stateRows[0] : stateRows;
  if (!state) return { ok: true };

  // Note: per-scene regen does NOT count toward monthly quota — it's a fix
  // for an existing render, not a new render. We still check can_render to
  // ensure their plan is in good standing.
  if (!state.can_render) {
    return {
      ok: false,
      status: 402,
      error: state.reason || "Your plan does not allow rendering this month.",
      upgradeRequired: true,
      currentTier: state.tier
    };
  }

  const requestedEngine = String(manifest.engine || "remotion").toLowerCase();
  const available = Array.isArray(state.available_engines) ? state.available_engines : ["remotion"];
  // v26.11: mirror api/render.js — veo and runway are the SAME entitlement (the
  // worker upgrades runway→veo). Treat them as interchangeable so a tier that
  // grants either grants both, and so per-scene regen works even though
  // tier_plans still lists 'runway' rather than 'veo'. Without this, every Edit
  // Studio re-render on an AI render 402'd ("Cinematic AI regen isn't included").
  const AI_ENGINES = new Set(["veo", "runway"]);
  const entitled =
    available.includes(requestedEngine) ||
    (AI_ENGINES.has(requestedEngine) && available.some((e) => AI_ENGINES.has(String(e).toLowerCase())));
  if (!entitled) {
    const engineLabel =
      requestedEngine === "depth" ? "Cinematic Depth" :
      requestedEngine === "runway" ? "Cinematic AI" :
      requestedEngine === "remotion" ? "Quick Reel" :
      requestedEngine;
    return {
      ok: false,
      status: 402,
      error: `${engineLabel} isn't included in your current plan (${state.tier}). Scene replacement is available on every plan with rendering enabled.`,
      upgradeRequired: true,
      currentTier: state.tier,
      requestedEngine
    };
  }

  return { ok: true, userId, state };
}
