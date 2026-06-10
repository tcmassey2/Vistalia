const DEFAULT_TIMEOUT_MS = 1000 * 60 * 8;

import { rateLimit } from "./_lib/rate-limit.js";

export default async function handler(request, response) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  // Rate-limit the POST submit path. 10 renders per hour per user is well
  // above any honest workflow (a 24-scene Cinematic AI render takes 3-5 min,
  // so 10 in an hour means hammering Generate constantly) but a reasonable
  // ceiling against credit-burning abuse. GET status polls bypass.
  if (request.method === "POST") {
    const limited = await rateLimit(request, response, {
      bucket: "render",
      max: 10,
      windowMs: 60 * 60 * 1000
    });
    if (limited) return;
  }

  if (request.method === "GET") {
    try {
      const jobId = new URL(request.url || "", "http://localhost").searchParams.get("jobId");
      if (!jobId) {
        response.status(400).json({ status: "failed", error: "Render status requires jobId." });
        return;
      }
      const workerUrl = renderWorkerStatusUrl(jobId);
      if (!workerUrl) {
        response.status(503).json({
          status: "failed",
          phase: "Render worker unavailable",
          progress: 100,
          error: "Video rendering is not connected yet."
        });
        return;
      }
      const workerResponse = await fetchWithTimeout(workerUrl, {
        method: "GET",
        headers: {
          ...(workerSecret() ? { Authorization: `Bearer ${workerSecret()}` } : {})
        }
      }, 30000);

      // Fast path — worker has the job in memory.
      if (workerResponse.ok) {
        const text = await workerResponse.text();
        const payload = parseBody(text);
        response.status(200).json(payload || { status: "rendering" });
        return;
      }

      // Slow path — worker doesn't know the job (restart between submit
      // and poll, or horizontally-scaled worker that's not the one that
      // accepted the submit). Fall back to the render_jobs table in
      // Supabase. Migration 09 created this table; opted-in workers
      // PUT progress to it so multi-instance topology works.
      if (workerResponse.status === 404) {
        const fallback = await fetchRenderJobFromSupabase(jobId);
        if (fallback) {
          response.status(200).json(fallback);
          return;
        }
      }

      const text = await workerResponse.text();
      const payload = parseBody(text);
      response.status(workerResponse.status).json(payload || { status: workerResponse.ok ? "rendering" : "failed", message: text });
    } catch (error) {
      response.status(500).json({ status: "failed", error: error.message || "Could not fetch render status." });
    }
    return;
  }

  if (request.method !== "POST") {
    response.status(405).json({ status: "failed", error: "Use POST /api/render with an EstateMotion render manifest." });
    return;
  }

  try {
    const body = parseBody(request.body);
    const manifest = body.manifest;

    if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
      response.status(400).json({ status: "failed", error: "Render manifest is missing scenes." });
      return;
    }

    const manifestError = validateManifestForServerRender(manifest, { live: !readFlag("MOCK_RENDERING", true) });
    if (manifestError) {
      response.status(400).json({ status: "failed", error: manifestError });
      return;
    }

    // Tier / quota guard. Soft-fails when Supabase isn't configured (so demos
    // and mock-mode still work). When configured + user is signed in, we
    // enforce the user's monthly_video_quota and available_engines.
    const tierGuard = await enforceTierGuard(request, manifest);
    if (!tierGuard.ok) {
      response.status(tierGuard.status || 402).json({
        status: "failed",
        error: tierGuard.error,
        upgradeRequired: tierGuard.upgradeRequired || false,
        currentTier: tierGuard.currentTier || null
      });
      return;
    }

    // v23: stamp the resolved tier onto the manifest so downstream worker
    // code (photo-preprocess upscale gate, future tier-gated features) can
    // make pricing decisions without re-querying Supabase.
    if (tierGuard.state?.tier) {
      manifest.userTier = tierGuard.state.tier;
    }
    if (tierGuard.userId) {
      manifest.project = manifest.project || {};
      manifest.project.userId = manifest.project.userId || tierGuard.userId;
    }

    // v23.2 HARD BLOCK: Gen-4.5 + 4K is an OOM trap on the current Render
    // Pro 4GB worker. The combo overwhelms ffmpeg's stitch step every
    // time. Worker dies, /render/status returns 502, customer waits 10
    // minutes for nothing. Until we move to a larger worker class:
    //
    //   - tier === 'cinematic_4k' + manifest.export4K === true
    //     → silently downgrade to export4K=false. Log it so we can
    //       audit how often this fires. Customer still gets Gen-4.5
    //       (the bigger visible upgrade) at 1080p — better than a 502.
    //
    // When we have a larger worker, remove this block and let users
    // re-enable 4K on Gen-4.5 if they want the wait.
    if (manifest.userTier === "cinematic_4k" && manifest.export4K === true) {
      console.warn(
        `[render] auto-downgrading 4K → 1080p for user ${tierGuard.userId} ` +
        `(cinematic_4k tier defaults to Gen-4.5 which OOMs the worker when ` +
        `4K is also on). Customer still gets Gen-4.5 at 1080p.`
      );
      manifest.export4K = false;
      manifest._autoDowngrade4K = true; // surfaced in response so the UI can toast
    }

    if (readFlag("MOCK_RENDERING", true)) {
      response.status(503).json({
        status: "failed",
        mock: true,
        jobId: createJobId(manifest),
        error: "Video rendering is not connected yet.",
        message: "Connect the Remotion render worker and set MOCK_RENDERING=false to generate real MP4 downloads.",
        mp4Url: "",
        thumbnailUrl: ""
      });
      return;
    }

    const workerUrl = renderWorkerUrl();
    if (!workerUrl) {
      response.status(503).json({
        status: "failed",
        error: "Live rendering is enabled, but RENDER_WORKER_URL or RENDER_ENDPOINT is not configured."
      });
      return;
    }

    const workerResponse = await fetchWithTimeout(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(workerSecret() ? { Authorization: `Bearer ${workerSecret()}` } : {})
      },
      body: JSON.stringify({
        manifest,
        jobs: body.jobs || [],
        requestedFormat: body.requestedFormat || "vertical"
      })
    }, DEFAULT_TIMEOUT_MS);

    const text = await workerResponse.text();
    const payload = parseBody(text);

    // Bump the trial-renders counter for users on the trial tier as soon
    // as the worker accepts the job. Fire-and-forget — a counter increment
    // failure must NOT block the render. The next /api/usage call surfaces
    // the new count to the dashboard banner.
    if (workerResponse.ok && tierGuard.userId && tierGuard.state?.tier === "trial") {
      bumpTrialCounter(tierGuard.userId).catch((err) => {
        console.warn("[render] trial counter increment failed:", err.message || err);
      });
    }

    response.status(workerResponse.status).json(payload || {
      status: workerResponse.ok ? "queued" : "failed",
      message: text
    });
  } catch (error) {
    response.status(500).json({
      status: "failed",
      error: error.message || "EstateMotion render request failed."
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

// v26.2: accept either secret name. health.js and the worker itself have
// always accepted RENDER_WORKER_SECRET as an alias, but this file only read
// RENDER_WEBHOOK_SECRET — so a Vercel deployment with the alias name passed
// /api/health checks while every render was sent UNAUTHENTICATED and 401'd.
// Cost us a production outage on June 9, 2026. Never read this env var
// directly again; use this helper.
function workerSecret() {
  return process.env.RENDER_WEBHOOK_SECRET || process.env.RENDER_WORKER_SECRET || "";
}

function renderWorkerUrl() {
  const configured = process.env.RENDER_WORKER_URL || process.env.RENDER_ENDPOINT || "";
  if (!configured) return "";
  return configured.endsWith("/render") ? configured : `${configured.replace(/\/$/, "")}/render`;
}

function renderWorkerStatusUrl(jobId) {
  const configured = process.env.RENDER_WORKER_URL || process.env.RENDER_ENDPOINT || "";
  if (!configured) return "";
  const base = configured.endsWith("/render") ? configured : `${configured.replace(/\/$/, "")}/render`;
  return `${base}/status/${encodeURIComponent(jobId)}`;
}

function validateManifestForServerRender(manifest, options = {}) {
  const photos = new Map((manifest.orderedPhotos || []).map((photo) => [photo.id, photo]));
  const problems = [];
  manifest.scenes.forEach((scene, index) => {
    if (["title", "intro", "outro", "card", "stats"].includes(String(scene.type || "").toLowerCase())) return;
    const label = scene.fileName || `scene ${index + 1}`;
    const imageUrl = scene.durableUrl || scene.durable_url || scene.publicUrl || scene.public_url || scene.imageUrl || "";
    if (!scene.photoId) problems.push(`${label} is missing photoId.`);
    if (scene.photoId && photos.size && !photos.has(scene.photoId)) problems.push(`${label} is not present in orderedPhotos.`);
    if (!imageUrl) problems.push(`${label} is missing imageUrl.`);
    if (options.live && !(scene.durableUrl || scene.durable_url)) problems.push(`${label} is missing durableUrl.`);
    if (options.live && isLocalOnlyUrl(imageUrl)) problems.push(`${label} uses a browser-only image URL.`);
    if (isUnsupportedImageUrl(imageUrl)) problems.push(`${label} uses an unsupported image format.`);
    if (isLikelyExpiredImageUrl(imageUrl)) problems.push(`${label} appears to use an expired signed URL.`);
  });
  if (!problems.length) return "";
  return `Render manifest validation failed: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` ${problems.length - 3} more issue${problems.length - 3 === 1 ? "" : "s"} found.` : ""}`;
}

function isLocalOnlyUrl(url) {
  const value = String(url || "");
  return value.startsWith("blob:") || value.startsWith("data:");
}

function isUnsupportedImageUrl(url) {
  const value = String(url || "").toLowerCase();
  if (value.startsWith("data:")) {
    return !value.startsWith("data:image/jpeg") && !value.startsWith("data:image/jpg") && !value.startsWith("data:image/png") && !value.startsWith("data:image/webp");
  }
  const path = value.split("?")[0];
  return /\.(heic|heif|tif|tiff|bmp|svg|gif)$/i.test(path);
}

function isLikelyExpiredImageUrl(url) {
  try {
    const parsed = new URL(String(url));
    const rawExpiry = parsed.searchParams.get("expires") || parsed.searchParams.get("expires_at") || parsed.searchParams.get("expiry") || parsed.searchParams.get("exp");
    if (!rawExpiry) return false;
    const numeric = Number(rawExpiry);
    const expiresAt = Number.isFinite(numeric)
      ? new Date(numeric < 10000000000 ? numeric * 1000 : numeric)
      : new Date(rawExpiry);
    return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now();
  } catch {
    return false;
  }
}

function createJobId(manifest) {
  const projectId = manifest.project?.id || manifest.project?.title || "estate-motion";
  return `${slug(projectId)}-${Date.now()}`;
}

function slug(value) {
  return String(value || "render").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
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
   Tier / quota guard
   ============================================================ */
async function enforceTierGuard(request, manifest) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  // If Supabase isn't fully configured, allow the render (development / demo mode).
  if (!supabaseUrl || !anonKey || !serviceKey) return { ok: true };

  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    // No JWT — anonymous request. Only allow Remotion engine, no Runway.
    if (String(manifest.engine || "remotion").toLowerCase() === "runway") {
      return {
        ok: false,
        status: 401,
        error: "Sign in or start a free trial to render Cinematic AI videos.",
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
    // RPC failure shouldn't block legitimate users; log and allow.
    console.warn("[render] tier RPC failed", { status: stateRes.status });
    return { ok: true };
  }
  const stateRows = await stateRes.json().catch(() => []);
  const state = Array.isArray(stateRows) ? stateRows[0] : stateRows;
  if (!state) return { ok: true };

  if (!state.can_render) {
    return {
      ok: false,
      status: 402,
      error: state.reason || "Your plan does not allow more videos this month.",
      upgradeRequired: true,
      currentTier: state.tier
    };
  }

  const requestedEngine = String(manifest.engine || "remotion").toLowerCase();
  const available = Array.isArray(state.available_engines) ? state.available_engines : ["remotion"];
  if (!available.includes(requestedEngine)) {
    // Engine label for the error message — name the actual engine the
    // user asked for instead of hard-coding 'Cinematic AI'. Previously
    // every entitlement failure said 'Cinematic AI requires...' even
    // when the request was for Cinematic Depth, which made the message
    // wrong on the highest tier (cinematic_4k) where Cinematic AI is
    // already unlocked but Depth wasn't in the engines list.
    const engineLabel =
      requestedEngine === "depth" ? "Cinematic Depth" :
      requestedEngine === "runway" ? "Cinematic AI" :
      requestedEngine === "remotion" ? "Quick Reel" :
      requestedEngine;
    const minTier =
      requestedEngine === "depth" || requestedEngine === "runway"
        ? "Cinematic AI ($149) or Cinematic AI 4K ($299)"
        : "any paid";
    return {
      ok: false,
      status: 402,
      error: `${engineLabel} isn't included in your current plan (${state.tier}). Upgrade to ${minTier} to unlock it, or pick a different engine.`,
      upgradeRequired: true,
      currentTier: state.tier,
      requestedEngine
    };
  }

  return { ok: true, userId, state };
}

// Look up an in-flight render in Supabase render_jobs table when the worker
// returns 404 (typically because the worker restarted). Returns the same
// shape as the worker's status response so the frontend can stay generic.
async function fetchRenderJobFromSupabase(jobId) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey || !jobId) return null;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/render_jobs?job_id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!row) return null;
    return {
      jobId: row.job_id,
      status: row.status || "rendering",
      phase: row.phase || "Render in progress",
      progress: Number.isFinite(row.progress) ? row.progress : 0,
      mp4Url: row.mp4_url || "",
      thumbnailUrl: row.thumbnail_url || "",
      engine: row.engine || "remotion",
      error: row.error || ""
    };
  } catch {
    return null;
  }
}

// Bump the trial-renders counter via the increment_trial_render RPC.
// No-op server-side if the user isn't on tier='trial' (the SQL function
// has its own WHERE clause). Service role required because the function
// updates a tier/quota field that RLS blocks for normal users.
async function bumpTrialCounter(userId) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey || !userId) return;
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/increment_trial_render`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_user_id: userId })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`increment_trial_render failed (${res.status}): ${body.slice(0, 200)}`);
  }
}
