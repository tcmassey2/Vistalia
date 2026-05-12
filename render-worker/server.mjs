import http from "node:http";
import { renderEstateMotionJob } from "./src/render-job.mjs";
import { renderRunwayJob } from "./src/runway-job.mjs";
import { regenerateScene } from "./src/regenerate-job.mjs";

// Route to the correct render engine based on manifest.engine.
// "remotion" (default) — existing Ken-Burns photo-animation pipeline.
// "runway" — Runway Gen-3 Turbo image-to-video then FFmpeg stitch.
async function dispatchRender(body, options = {}) {
  const engine = String(body?.manifest?.engine || "remotion").toLowerCase();
  if (engine === "runway") {
    return renderRunwayJob(body, options);
  }
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
      version: "2026.05.12-v16-per-scene-regen",
      bootedAt: BOOTED_AT,
      uptimeSec: Math.round(process.uptime()),
      activeJobs: jobs.size,
      capabilities: {
        ffmpegTimeouts: true,
        overallJobTimeout: "18min",
        narrationFailSoft: true,
        runwayFallbacks: ["ken_burns", "simple_concat", "letterbox_wide"],
        perScenePersistence: true,
        perSceneRegenerate: true
      },
      endpoints: [
        "GET /health",
        "GET /version",
        "POST /render",
        "POST /render/sync",
        "GET /render/status/:jobId",
        "POST /regenerate-scene",
        "POST /regenerate-scene/sync"
      ]
    });
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
});

function authorized(request) {
  const secret = process.env.RENDER_WORKER_SECRET || process.env.RENDER_WEBHOOK_SECRET || "";
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
  try {
    const { default: fs } = await import("node:fs/promises");
    const body = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": fileName === "thumbnail.png" ? "image/png" : "video/mp4",
      "Content-Length": body.length,
      "Cache-Control": "no-store"
    });
    response.end(body);
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
