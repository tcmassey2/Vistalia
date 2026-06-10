import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderEstateMotionJob } from "./src/render-job.mjs";
import { renderRunwayJob } from "./src/runway-job.mjs";
import { regenerateScene } from "./src/regenerate-job.mjs";

// v25 Phase 1b: Veo via fal.ai (no bootstrap needed).
// The previous Vertex-AI-direct path required writing a service-account
// JSON to /tmp at boot. We pivoted to fal.ai because Google's
// Secure-by-Default org policy on free-tier accounts blocks SA key
// creation entirely. fal.ai uses a single FAL_KEY env var — no
// bootstrap, no disk writes, no IAM dance.

// v24: depth engine removed from production routing. The files
// (depth-job.mjs, depth-renderer.mjs, replicate-client.mjs) are
// preserved in the repo for future restoration but not imported
// here — that way the worker doesn't drag in gl/three/sharp/Xvfb
// just to keep the depth code on disk.
//
// Route to the correct render engine based on manifest.engine:
//   "remotion" (default) — Ken-Burns photo-animation via Remotion.
//   "veo"                — Veo 3.1 Fast (fal.ai) → ffmpeg stitch.
//   "runway"             — legacy Runway Gen-4 Turbo → ffmpeg stitch.
//
// v26.3 PRODUCTION CUTOVER: engine "runway" is transparently upgraded to
// "veo" — existing clients and tier configs all say "runway" and keep
// working, but every AI render now runs Veo 3.1 Fast. Rollback without a
// deploy: set VEO_PRODUCTION=false on Render to restore Runway routing.
async function dispatchRender(body, options = {}) {
  let engine = String(body?.manifest?.engine || "remotion").toLowerCase();
  const veoProduction = process.env.VEO_PRODUCTION !== "false";
  if (engine === "runway" && veoProduction && process.env.FAL_KEY) {
    console.info("[server] engine runway → veo (v26.3 production cutover)");
    engine = "veo";
    body.manifest.engine = "veo";
  }
  if (engine === "veo" || engine === "runway") {
    return renderRunwayJob(body, options);
  }
  // Any other engine value (including stale 'depth' from older clients)
  // falls through to the safe default.
  return renderEstateMotionJob(body, options);
}

const port = Number(process.env.PORT || 8787);
const maxBodyBytes = 25 * 1024 * 1024;
const jobs = new Map();
const jobAssets = new Map();
const BOOTED_AT = new Date().toISOString();

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, service: "EstateMotion Remotion worker" });
    return;
  }

  // /version — diagnostic endpoint so the frontend (and humans) can verify
  // which build of the worker is actually deployed. Bumps with each
  // hardening pass so we can confirm the latest fix is live.
  if (request.method === "GET" && request.url === "/version") {
    sendJson(response, 200, {
      version: "2026.06.09-v26.3",
      // v26.3 Phase 2: Veo 3.1 Fast IS the production AI engine. Incoming
      // engine:"runway" manifests are upgraded to veo at dispatch (rollback:
      // VEO_PRODUCTION=false). Runway code path preserved on disk.
      engines: ["remotion", "veo"],
      legacyEngines: ["runway (auto-upgraded to veo)"],
      veoProduction: process.env.VEO_PRODUCTION !== "false",
      veo: {
        provider: "fal.ai",
        model: process.env.FAL_VIDEO_MODEL || "fal-ai/veo3/fast/image-to-video",
        resolution: process.env.FAL_RESOLUTION || "1080p",
        duration: process.env.FAL_DURATION || "6s",
        keyConfigured: Boolean(process.env.FAL_KEY),
        testEndpoint: "POST /test/veo"
      },
      // v26: surface auth state so a missing worker secret is visible at a
      // glance instead of silently failing open.
      authConfigured: Boolean(workerSecret()),
      bootedAt: BOOTED_AT,
      uptimeSec: Math.round(process.uptime()),
      activeJobs: jobs.size,
      capabilities: {
        ffmpegTimeouts: true,
        overallJobTimeout: "18min",
        narrationFailSoft: true,
        runwayFallbacks: ["ken_burns", "simple_concat", "letterbox_wide"],
        perScenePersistence: true,
        perSceneRegenerate: true,
        hallucinationGuard: ["off", "balanced", "strict"],
        hallucinationGuardDefault: "balanced",
        cornerHeadshot: true,
        aiCuration: true,
        encode: {
          preset: "superfast",
          crfMaster: 19,
          crfDerived: 20,
          unsharp: true,
          x264Params: "rc-lookahead=10:ref=2:bframes=2:keyint=60:scenecut=0",
          bufsize: "2M"
        }
      },
      endpoints: [
        "GET /health",
        "GET /version",
        "POST /render",
        "POST /render/sync",
        "GET /render/status/:jobId",
        "POST /regenerate-scene",
        "POST /regenerate-scene/sync",
        "POST /test/veo  (v25 Phase 1 — Veo 3.1 Fast smoke test)"
      ]
    });
    return;
  }

  // v25 Phase 1: standalone Veo 3.1 Fast smoke test.
  // Not auth-gated — meant for local testing with the $300 Google Cloud
  // free credit. Once Phase 2 wires Veo into production, this endpoint
  // stays as a diagnostic to verify SA credentials + Veo quota.
  //
  // POST /test/veo
  // Body: { imageUrl, prompt, aspectRatio?, duration? }
  // Returns: { status, clipServePath, gcsUri, veoOpName, durationMs }
  if (request.method === "POST" && request.url === "/test/veo") {
    // v26: was auth-free ("gated by knowing the worker URL" — which appears
    // in client-visible network traffic). Each call is ~$1 of fal.ai spend,
    // so it gets the same bearer gate as production renders. test-veo.mjs
    // sends the secret from its WORKER_SECRET env var.
    if (!authorized(request)) {
      sendJson(response, 401, { status: "failed", error: "Render worker authorization failed." });
      return;
    }
    await handleVeoSmokeTest(request, response);
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/render/assets/")) {
    await serveRenderAsset(request, response);
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/render/status/")) {
    const jobId = decodeURIComponent(request.url.split("/").pop() || "");
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(response, 404, { status: "failed", error: "Render job was not found. It may have expired or the worker restarted." });
      return;
    }
    sendJson(response, 200, job);
    return;
  }

  const renderRoutes = ["/render", "/render/sync"];
  const regenRoutes = ["/regenerate-scene", "/regenerate-scene/sync"];
  const isRenderRoute = renderRoutes.includes(request.url || "");
  const isRegenRoute = regenRoutes.includes(request.url || "");

  if (request.method !== "POST" || (!isRenderRoute && !isRegenRoute)) {
    sendJson(response, 404, {
      status: "failed",
      error: "Use POST /render, POST /regenerate-scene, or GET /render/status/:jobId."
    });
    return;
  }

  if (!authorized(request)) {
    sendJson(response, 401, { status: "failed", error: "Render worker authorization failed." });
    return;
  }

  try {
    const body = await readJsonBody(request);

    // Per-scene regenerate. The new job runs against the EXISTING jobId — we
    // intentionally don't mint a new one because the audit row, master URL,
    // and library entry are all keyed off the original jobId and we want
    // them to update in place.
    if (isRegenRoute) {
      const targetJobId = body?.jobId;
      if (!targetJobId) {
        sendJson(response, 400, { status: "failed", error: "regenerate-scene requires jobId." });
        return;
      }
      if (request.url === "/regenerate-scene/sync") {
        const result = await regenerateScene(body);
        sendJson(response, 200, result);
        return;
      }
      const now = new Date().toISOString();
      // Use a derived progress key so the original render's job entry stays
      // intact for status polling. Format: <jobId>:regen:<sceneIndex>.
      const progressKey = `${targetJobId}:regen:${body?.sceneIndex ?? "?"}`;
      const job = {
        status: "queued",
        phase: "Preparing scene regenerate",
        progress: 3,
        jobId: progressKey,
        originalJobId: targetJobId,
        sceneIndex: body?.sceneIndex,
        mode: body?.mode || "ai",
        mp4Url: "",
        thumbnailUrl: "",
        error: "",
        createdAt: now,
        updatedAt: now
      };
      jobs.set(progressKey, job);
      sendJson(response, 202, job);
      runRegenerateJob(progressKey, body);
      return;
    }

    if (request.url === "/render/sync") {
      const result = await dispatchRender(body);
      sendJson(response, 200, publishLocalAssetUrls(result));
      return;
    }
    const jobId = createJobId(body.manifest);
    const now = new Date().toISOString();
    const job = {
      status: "queued",
      phase: "Preparing video",
      progress: 5,
      jobId,
      mp4Url: "",
      thumbnailUrl: "",
      error: "",
      createdAt: now,
      updatedAt: now
    };
    jobs.set(jobId, job);
    sendJson(response, 202, job);
    runRenderJob(jobId, body);
  } catch (error) {
    sendJson(response, 500, {
      status: "failed",
      error: error.message || "EstateMotion render worker failed."
    });
  }
});

server.listen(port, () => {
  console.log(`EstateMotion render worker listening on http://localhost:${port}`);
  // v26: make missing auth LOUD. authorized() fails open by design (local
  // dev), but in production an unset secret means anyone with the worker
  // URL can submit Runway/Veo jobs on our API keys. /version also reports
  // authConfigured so this is checkable from a browser.
  if (!workerSecret()) {
    console.warn(
      "[server] ⚠️  NO WORKER SECRET SET (RENDER_WORKER_SECRET / RENDER_WEBHOOK_SECRET). " +
      "All render endpoints are UNAUTHENTICATED. Set the secret on Render before going live."
    );
  }
});

function workerSecret() {
  return process.env.RENDER_WORKER_SECRET || process.env.RENDER_WEBHOOK_SECRET || "";
}

function authorized(request) {
  const secret = workerSecret();
  if (!secret) return true;
  return request.headers.authorization === `Bearer ${secret}`;
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function runRenderJob(jobId, body) {
  const engine = String(body?.manifest?.engine || "remotion").toLowerCase();
  updateJob(jobId, { status: "rendering", phase: "Rendering scenes", progress: 12, engine });
  // Overall hard cap — if anything below this races slower than 18 minutes,
  // we kill the job rather than let it hang forever. 18 minutes covers the
  // legitimate worst case (24-clip Cinematic AI render with 4K upscale +
  // narration on Render Standard) with ~50% headroom.
  const OVERALL_TIMEOUT_MS = 18 * 60 * 1000;
  const startedAt = Date.now();
  try {
    const result = await Promise.race([
      dispatchRender(body, { jobId, onProgress: (patch) => updateJob(jobId, patch) }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Render exceeded ${OVERALL_TIMEOUT_MS / 1000 / 60}-minute hard timeout.`)), OVERALL_TIMEOUT_MS)
      )
    ]);
    const publishedResult = publishLocalAssetUrls(result);
    const elapsedMin = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);
    console.info(`[server] job ${jobId} completed in ${elapsedMin} min`);
    updateJob(jobId, {
      ...publishedResult,
      status: "completed",
      phase: "Ready to download",
      progress: 100,
      jobId
    });
  } catch (error) {
    const elapsedMin = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);
    console.error(`[server] job ${jobId} failed after ${elapsedMin} min: ${error.message}`);
    updateJob(jobId, {
      status: "failed",
      phase: "Render failed",
      progress: 100,
      error: error.message || "EstateMotion render worker failed."
    });
  }
}

// Run the per-scene regenerate orchestrator with an overall timeout. Regen
// only generates 1 new clip + downloads N-1 + re-stitches, so it's much
// faster than a full render. 10-minute cap is conservative — typical
// runtime is 60-180 seconds.
async function runRegenerateJob(progressKey, body) {
  updateJob(progressKey, { status: "rendering", phase: "Starting regen", progress: 5 });
  const REGEN_TIMEOUT_MS = 10 * 60 * 1000;
  const startedAt = Date.now();
  try {
    const result = await Promise.race([
      regenerateScene(body, { onProgress: (patch) => updateJob(progressKey, patch) }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Regenerate exceeded ${REGEN_TIMEOUT_MS / 1000 / 60}-minute hard timeout.`)), REGEN_TIMEOUT_MS)
      )
    ]);
    const elapsedMin = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);
    console.info(`[server] regen ${progressKey} completed in ${elapsedMin} min`);
    updateJob(progressKey, {
      ...result,
      status: "completed",
      phase: "Ready to download",
      progress: 100
    });
  } catch (error) {
    const elapsedMin = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);
    console.error(`[server] regen ${progressKey} failed after ${elapsedMin} min: ${error.message}`);
    updateJob(progressKey, {
      status: "failed",
      phase: "Regenerate failed",
      progress: 100,
      error: error.message || "EstateMotion regenerate failed.",
      errorCode: error.code || ""
    });
  }
}

function updateJob(jobId, patch) {
  const current = jobs.get(jobId) || { jobId };
  jobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

// v26: the jobs/jobAssets Maps previously grew until worker restart — a
// slow leak that also kept temp-file paths alive long past usefulness.
// Prune terminal (completed/failed) jobs after 2 h; hard-cap with
// oldest-first eviction as a backstop. Status polls for pruned jobs fall
// back to the render_jobs Supabase table (api/render.js already handles
// the worker-404 path), so nothing user-facing breaks.
const JOB_RETENTION_MS = 2 * 60 * 60 * 1000;
const JOBS_HARD_CAP = 500;
setInterval(() => {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    const terminal = job.status === "completed" || job.status === "failed";
    const updatedAt = Date.parse(job.updatedAt || "") || 0;
    if (terminal && updatedAt < cutoff) {
      jobs.delete(id);
      jobAssets.delete(id);
    }
  }
  while (jobs.size > JOBS_HARD_CAP) {
    const oldest = jobs.keys().next().value;
    jobs.delete(oldest);
    jobAssets.delete(oldest);
  }
}, 10 * 60 * 1000).unref();

function publishLocalAssetUrls(result = {}) {
  if (!result.storageSkipped || !result.localMp4Path) return result;
  const publicBase = (process.env.RENDER_WORKER_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");
  jobAssets.set(result.jobId, {
    mp4Path: result.localMp4Path,
    thumbnailPath: result.localThumbnailPath || ""
  });
  return {
    ...result,
    mp4Url: `${publicBase}/render/assets/${encodeURIComponent(result.jobId)}/estate-motion.mp4`,
    thumbnailUrl: result.localThumbnailPath ? `${publicBase}/render/assets/${encodeURIComponent(result.jobId)}/thumbnail.png` : ""
  };
}

// v25 Phase 1 — Veo smoke test handler. Generates ONE clip via Veo
// 3.1 Fast and parks the resulting mp4 under /render/assets/<token>/...
// so the caller can grab it via a normal HTTP GET. Auth-free on purpose:
// this is a developer diagnostic, gated by knowing the worker URL.
async function handleVeoSmokeTest(request, response) {
  const startedAt = Date.now();
  let body;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    sendJson(response, 400, { status: "failed", error: err.message });
    return;
  }
  const imageUrl = String(body?.imageUrl || "").trim();
  const prompt = String(body?.prompt || "").trim();
  if (!imageUrl || !prompt) {
    sendJson(response, 400, {
      status: "failed",
      error: "Body requires { imageUrl, prompt }. Optional: aspectRatio, duration."
    });
    return;
  }

  // Park output under the same temp/asset machinery the production
  // renders use so the existing GET /render/assets/:id/:file serves it.
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "veo-smoke-"));

  // v26.1: async mode. Generation takes 60-180s; some callers (CI, proxies,
  // sandboxed shells) can't hold a connection that long. With async:true
  // we return 202 + a jobId immediately and run the generation through the
  // same jobs map the production renders use — poll GET /render/status/:id.
  const runOnce = async () => {
    const { runVeoSmokeTest } = await import("./src/veo-job.mjs");
    const result = await runVeoSmokeTest({
      imageUrl,
      prompt,
      aspectRatio: body.aspectRatio || "9:16",
      duration: body.duration || "6s",
      // Optional per-call model override so the bake-off runner can
      // sweep through Veo 3 Fast / Veo 3.1 Lite / Kling / Luma / etc.
      model: body.model || undefined,
      tempDir
    });
    const tokenId = `veo-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    jobAssets.set(tokenId, { mp4Path: result.clipPath, thumbnailPath: "" });
    return {
      clipServePath: `/render/assets/${tokenId}/render.mp4`,
      gcsUri: result.gcsUri,
      veoOpName: result.veoOpName,
      durationSec: result.duration,
      durationMs: Date.now() - startedAt,
      notes: "Asset is in-memory only — restart the worker and the URL 404s."
    };
  };

  if (body.async === true) {
    const jobId = `veo-smoke-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    jobs.set(jobId, {
      status: "rendering", phase: "Generating clip", progress: 10,
      jobId, mp4Url: "", thumbnailUrl: "", error: "", createdAt: now, updatedAt: now
    });
    sendJson(response, 202, { status: "queued", jobId, poll: `/render/status/${jobId}` });
    runOnce()
      .then((out) => updateJob(jobId, { ...out, status: "completed", phase: "Ready", progress: 100 }))
      .catch((err) => updateJob(jobId, {
        status: "failed", phase: "Generation failed", progress: 100,
        error: err.message || String(err), errorCode: err.code || "VEO_UNKNOWN"
      }));
    return;
  }

  try {
    const out = await runOnce();
    sendJson(response, 200, { status: "ok", ...out });
  } catch (err) {
    sendJson(response, 500, {
      status: "failed",
      error: err.message || String(err),
      code: err.code || "VEO_UNKNOWN",
      durationMs: Date.now() - startedAt
    });
  }
}

async function serveRenderAsset(request, response) {
  const parts = (request.url || "").split("/");
  const jobId = decodeURIComponent(parts[3] || "");
  const fileName = parts[4] || "";
  const asset = jobAssets.get(jobId);
  const filePath = fileName === "thumbnail.png" ? asset?.thumbnailPath : asset?.mp4Path;
  if (!asset || !filePath) {
    sendJson(response, 404, { status: "failed", error: "Rendered asset was not found. It may have expired or the worker restarted." });
    return;
  }
  // v26: stream instead of buffering. readFile() pulled entire mp4s
  // (often 50-150 MB) into heap on a 4 GB box that's also running ffmpeg —
  // a couple of concurrent downloads during a render risked OOM.
  try {
    const stat = await fs.promises.stat(filePath);
    response.writeHead(200, {
      "Content-Type": fileName === "thumbnail.png" ? "image/png" : "video/mp4",
      "Content-Length": stat.size,
      "Cache-Control": "no-store"
    });
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  } catch (error) {
    sendJson(response, 404, { status: "failed", error: error.message || "Rendered asset could not be read." });
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBodyBytes) {
        reject(new Error("Render request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Render request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function createJobId(manifest = {}) {
  const projectId = manifest.project?.id || manifest.project?.title || "estate-motion";
  return `${slug(projectId)}-${Date.now()}`;
}

function slug(value) {
  return String(value || "render").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "render";
}
