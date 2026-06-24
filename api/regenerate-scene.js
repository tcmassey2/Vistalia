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
    const normalizedMode = String(mode || "ai").toLowerCase();
    if (!["ai", "kenburns"].includes(normalizedMode)) {
      response.status(400).json({ status: "failed", error: "mode must be 'ai' or 'kenburns'." });
      return;
    }
    if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
      response.status(400).json({ status: "failed", error: "manifest with scenes[] is required." });
      return;
    }

    // Tier guard — regen still costs Runway credits when mode=ai, so enforce
    // the same engine availability rules a full render would. Ken-Burns-only
    // regen is free for any tier with rendering enabled.
    const tierEngine = normalizedMode === "kenburns" ? "remotion" : "runway";
    const tierGuard = await enforceTierGuard(request, { ...manifest, engine: tierEngine });
    if (!tierGuard.ok) {
      response.status(tierGuard.status || 402).json({
        status: "failed",
        error: tierGuard.error,
        upgradeRequired: tierGuard.upgradeRequired || false,
        currentTier: tierGuard.currentTier || null
      });
      return;
    }

    if (readFlag("MOCK_RENDERING", true)) {
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
        mode: normalizedMode,
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
async function enforceTierGuard(request, manifest) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !anonKey || !serviceKey) return { ok: true };

  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    if (String(manifest.engine || "remotion").toLowerCase() === "runway") {
      return {
        ok: false,
        status: 401,
        error: "Sign in to regenerate scenes with Cinematic AI.",
        upgradeRequired: true
      };
    }
    return { ok: true };
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
      error: `${engineLabel} regen isn't included in your current plan (${state.tier}). Try the "Replace with Ken Burns" option instead — it's free on any plan.`,
      upgradeRequired: true,
      currentTier: state.tier,
      requestedEngine
    };
  }

  return { ok: true, userId, state };
}
