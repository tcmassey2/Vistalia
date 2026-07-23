import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderVistaliaJob } from "./src/render-job.mjs";
import { runCanaryOnBoot } from "./src/canary.mjs";
import { startAutoRenderClock } from "./src/lead-auto-render.mjs";
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
  return renderVistaliaJob(body, options);
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
    sendJson(response, 200, { ok: true, service: "Vistalia Remotion worker" });
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

      // Resume-don't-duplicate: if this exact scene regen is already in
      // flight (queued/rendering with a fresh heartbeat), hand back its
      // current state instead of starting a second run. Double-clicks and
      // re-opened modals resume polling the same job — no double fal spend,
      // no racing audit-row writes. A STALE in-flight row (worker died,
      // heartbeat >3 min old) falls through to a fresh enqueue, so "click
      // again" is also the user's instant recovery path.
      if (QUEUE_ENABLED) {
        const existing = await fetchQueueRow(progressKey);
        const beat = Date.parse(existing?.heartbeat_at || existing?.claimed_at || existing?.created_at || "") || 0;
        const fresh = Date.now() - beat < 3 * 60 * 1000;
        if (existing && (existing.status === "queued" || existing.status === "rendering") && fresh) {
          sendJson(response, 202, {
            status: existing.status,
            phase: existing.phase || "Working",
            progress: existing.progress ?? 5,
            jobId: progressKey,
            originalJobId: targetJobId,
            sceneIndex: body?.sceneIndex,
            mode: body?.mode || "ai",
            mp4Url: "",
            thumbnailUrl: "",
            error: "",
            createdAt: existing.created_at || now,
            updatedAt: now,
            resumed: true
          });
          return;
        }
      }

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

      // Launch fix (Jul 13): regen jobs used to live ONLY in this instance's
      // memory — persistJobStatus PATCHes matched no render_jobs row, so any
      // worker restart (every repo push auto-deploys) wiped all trace and
      // status polls died with "worker has no record of job". Route regen
      // through the same pull queue as full renders: the row makes status
      // survive restarts (api/render.js DB fallback), heartbeats flow, and
      // the stuck-job reaper re-queues a regen orphaned mid-flight.
      if (QUEUE_ENABLED) {
        try {
          await enqueueRenderJob(progressKey, { ...body, __regen: true });
          sendJson(response, 202, job);
          return; // pollAndProcess (this or any instance) claims it within ~2.5s
        } catch (e) {
          console.warn(`[queue] regen enqueue failed, running inline: ${e?.message}`);
        }
      }
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
    if (QUEUE_ENABLED) {
      try {
        await enqueueRenderJob(jobId, body); // any worker instance claims + runs it
      } catch (e) {
        console.warn(`[queue] enqueue failed, running inline: ${e?.message}`);
        runRenderJob(jobId, body);           // safe fallback (e.g. migration not applied yet)
      }
    } else {
      runRenderJob(jobId, body);
    }
    sendJson(response, 202, job);
  } catch (error) {
    sendJson(response, 500, {
      status: "failed",
      error: error.message || "Vistalia render worker failed."
    });
  }
});

server.listen(port, () => {
  console.log(`Vistalia render worker listening on http://localhost:${port}`);
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

/* ============================================================
   Render PULL queue (horizontal scaling).
   With Supabase configured, POST /render ENQUEUES a job (render_jobs row,
   status=queued); this worker — like every other instance — polls and claims
   jobs with FOR UPDATE SKIP LOCKED, running at most RENDER_CONCURRENCY at once.
   Falls back to inline rendering when Supabase / the queue objects aren't
   available, so it's safe to deploy before the migration is applied.
   ============================================================ */
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const QUEUE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const RENDER_CONCURRENCY = Math.max(1, Number(process.env.RENDER_CONCURRENCY || 2));
const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
let activeRenders = 0;

// v50.1 CRASH OBSERVABILITY (Jul 18 incident): the Summit Springs job ran
// THREE times — every container boot in the log landed in the tone-leveling→
// stitch window and every redelivery came at exact reaper spacing (20-min
// stale + 5-min tick), but nothing ever logged WHY a process ended or WHY a
// completed status failed to stick. These handlers make the next death name
// itself, and the RSS ticker shows whether it's the OOM killer.
process.on("uncaughtException", (e) => {
  console.error(`[fatal] uncaughtException on ${WORKER_ID}: ${e?.stack || e?.message || e}`);
});
process.on("unhandledRejection", (e) => {
  console.error(`[fatal] unhandledRejection on ${WORKER_ID}: ${e?.stack || e?.message || e}`);
});
process.on("SIGTERM", () => {
  console.error(`[fatal] SIGTERM on ${WORKER_ID} — platform is stopping this container (deploy/restart/OOM-adjacent). activeRenders=${activeRenders}`);
});
process.on("beforeExit", (code) => {
  console.error(`[fatal] beforeExit code=${code} on ${WORKER_ID} — event loop drained. activeRenders=${activeRenders}`);
});
setInterval(() => {
  const m = process.memoryUsage();
  if (activeRenders > 0 || m.rss > 2_000_000_000) {
    console.info(`[mem] rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB active=${activeRenders} worker=${WORKER_ID}`);
  }
}, 120_000).unref();

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json"
};

async function sbRpc(fn, payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: sbHeaders, body: JSON.stringify(payload || {})
  });
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json().catch(() => null);
}

// Enqueue a render job (idempotent on job_id). Re-enqueueing an existing
// job_id (e.g. a second regen of the same scene) resets attempts so the
// stuck-job reaper's 3-strike counter starts fresh for the new run.
async function enqueueRenderJob(jobId, body) {
  const userId = body?.userId || body?.manifest?.userId || body?.manifest?.project?.userId || null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/render_jobs`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ job_id: jobId, user_id: userId, status: "queued", phase: "Queued", progress: 3, manifest: body, attempts: 0, error: null })
  });
  if (!res.ok) throw new Error(`enqueue ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

// Read one queue row (dedupe check for regen resume). Best-effort — a null
// return just means "no usable row", and the caller enqueues fresh.
async function fetchQueueRow(jobId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/render_jobs?job_id=eq.${encodeURIComponent(jobId)}&select=status,phase,progress,heartbeat_at,claimed_at,created_at&limit=1`,
      { headers: sbHeaders }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

// Mirror an in-memory job's state to render_jobs (best-effort). PATCH by job_id
// is a no-op for non-queue ids (regen / smoke), so it's safe in shared updateJob.
function persistJobStatus(jobId, job) {
  if (!QUEUE_ENABLED || !jobId) return;
  const patch = {};
  // v31 pipeline-audit: heartbeat on every status write. Progress updates
  // fire many times a minute during honest work, so requeue_stuck_render_jobs
  // (migration 25) can distinguish "long render" from "dead worker" — the old
  // claimed_at-only rule requeued healthy >20-min jobs mid-render, double-
  // spending fal on a second worker.
  patch.heartbeat_at = new Date().toISOString();
  if (job.status) patch.status = job.status;
  if (job.phase != null) patch.phase = job.phase;
  if (typeof job.progress === "number") patch.progress = job.progress;
  if (job.mp4Url) patch.mp4_url = job.mp4Url;
  if (job.thumbnailUrl) patch.thumbnail_url = job.thumbnailUrl;
  if (job.error) patch.error = job.error;
  if (job.status === "completed") patch.result = job;
  if (Object.keys(patch).length === 0) return;
  // v50.1 MONOTONIC TERMINAL GUARD: a late/racing progress tick (or a
  // heartbeat from any stale writer) must NEVER flip a completed/failed row
  // back to 'rendering' — that exact regression re-arms the stuck reaper
  // against a finished job. Non-terminal patches now only match rows that
  // are not already terminal; terminal patches stay unconditional.
  const terminalGuard = (patch.status === "completed" || patch.status === "failed")
    ? ""
    : "&status=not.in.(completed,failed)";
  const url = `${SUPABASE_URL}/rest/v1/render_jobs?job_id=eq.${encodeURIComponent(jobId)}${terminalGuard}`;
  // v46 (Troy's smoke test): a regen finished in memory but its final
  // status=completed patch was lost (single fire-and-forget attempt) — the
  // row froze at status=rendering/progress=100 and the 20-min stuck reaper
  // would have RE-RUN the whole completed job. Terminal transitions
  // (completed/failed) now retry with backoff and log loudly on final
  // failure; progress ticks stay single-shot fire-and-forget (the next
  // tick supersedes them anyway).
  const terminal = patch.status === "completed" || patch.status === "failed";
  const attemptPatch = async (body) => {
    const res = await fetch(url, {
      method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(body)
    });
    // Deploy-order resilience: if migration 25 (heartbeat_at column) hasn't
    // been applied yet, PostgREST rejects the whole patch — retry once
    // without the heartbeat so status/result persistence NEVER silently
    // stops.
    if (!res.ok && body.heartbeat_at) {
      const { heartbeat_at, ...rest } = body;
      if (Object.keys(rest).length === 0) return res;
      return fetch(url, {
        method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(rest)
      });
    }
    return res;
  };
  (async () => {
    const attempts = terminal ? 3 : 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await attemptPatch(patch);
        if (res?.ok) return;
        if (terminal) console.warn(`[queue] terminal patch for ${jobId} got ${res?.status} (attempt ${i + 1}/${attempts})`);
      } catch (e) {
        if (terminal) console.warn(`[queue] terminal patch for ${jobId} threw (attempt ${i + 1}/${attempts}): ${e?.message}`);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
    if (terminal) {
      console.error(`[queue] ⚠️ FAILED to persist ${patch.status} for ${jobId} after ${attempts} attempts — the stuck reaper may requeue this finished job. Fix the row manually: update render_jobs set status='${patch.status}' where job_id='${jobId}'.`);
    }
  })().catch(() => {});
}

// v50.1: does a delivered artifact already exist for this job? The audit row
// (written at upload time) is the durable receipt — if it exists with a
// master URL, any fresh claim of the same job_id is a reaper redelivery of a
// FINISHED render. Best-effort: null on any error → claim proceeds normally.
async function auditRowForJob(jobId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/render_audit_log?job_id=eq.${encodeURIComponent(jobId)}&select=job_id,master_mp4_url,thumbnail_url&limit=1`,
      { headers: sbHeaders }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows[0] && rows[0].master_mp4_url ? rows[0] : null;
  } catch {
    return null;
  }
}

// v50.1: confirm a terminal status actually LANDED in render_jobs. Read-only
// poll — the writes come from persistJobStatus's retry loop; this just
// refuses to declare victory until the row agrees. Missing row = non-queue
// (inline/smoke) job — nothing to confirm.
async function confirmTerminalPersist(jobId, status) {
  if (!QUEUE_ENABLED || !jobId) return true;
  const url = `${SUPABASE_URL}/rest/v1/render_jobs?job_id=eq.${encodeURIComponent(jobId)}&select=status`;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { headers: sbHeaders });
      if (res.ok) {
        const rows = await res.json().catch(() => []);
        if (Array.isArray(rows) && rows.length === 0) return true; // inline job, no queue row
        if (rows[0]?.status === status) return true;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  console.error(`[queue] ⚠️ could not CONFIRM status=${status} for ${jobId} — the terminal write may be lost; the stuck reaper may redeliver (the idempotent claim guard will stop a re-render/re-email).`);
  return false;
}

// Poll the queue and start jobs up to the concurrency cap. Each claim is atomic
// (SKIP LOCKED) so multiple worker instances never collide on the same job.
async function pollAndProcess() {
  if (!QUEUE_ENABLED) return;
  try {
    while (activeRenders < RENDER_CONCURRENCY) {
      const claimed = await sbRpc("claim_render_job", { p_worker_id: WORKER_ID });
      if (!claimed || !claimed.job_id) break;
      // Regen jobs ride the same queue (job_id = <jobId>:regen:<n>, manifest
      // is the regen request body flagged __regen). Branch to the regen
      // runner — runRenderJob would dispatch a full render AND refund a
      // credit on failure that regen never charged.
      const isRegen = Boolean(claimed.manifest?.__regen);
      // v50.1 IDEMPOTENT CLAIM GUARD (Jul 18 incident: one job rendered 3×,
      // customer emailed 2×, ~2 renders of fal spend wasted). If the audit
      // row says this job already delivered, re-assert the terminal status
      // and skip — never re-render, never re-email.
      if (!isRegen) {
        const delivered = await auditRowForJob(claimed.job_id);
        if (delivered) {
          console.error(`[queue] ${claimed.job_id} claimed but ALREADY DELIVERED (audit row present) — reaper redelivery caught. Re-asserting completed; skipping re-render + email.`);
          updateJob(claimed.job_id, {
            status: "completed",
            phase: "Ready to download",
            progress: 100,
            mp4Url: delivered.master_mp4_url,
            thumbnailUrl: delivered.thumbnail_url || "",
            jobId: claimed.job_id
          });
          continue;
        }
      }
      activeRenders++;
      jobs.set(claimed.job_id, {
        status: "rendering", phase: isRegen ? "Starting scene redo" : "Claimed", progress: 5, jobId: claimed.job_id,
        mp4Url: "", thumbnailUrl: "", error: "",
        createdAt: claimed.created_at || new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      const run = isRegen
        ? runRegenerateJob(claimed.job_id, claimed.manifest)
        : runRenderJob(claimed.job_id, claimed.manifest);
      run
        .catch((e) => console.error(`[queue] ${isRegen ? "regen" : "render"} ${claimed.job_id} crashed: ${e?.message}`))
        .finally(() => { activeRenders--; });
    }
  } catch (e) {
    console.warn(`[queue] poll error: ${e?.message}`);
  }
}

if (QUEUE_ENABLED) {
  setInterval(pollAndProcess, 2500).unref();
  setInterval(() => { sbRpc("requeue_stuck_render_jobs", { p_timeout_minutes: 20 }).catch(() => {}); }, 5 * 60 * 1000).unref();
  console.info(`[queue] pull-queue ON · worker=${WORKER_ID} · concurrency=${RENDER_CONCURRENCY}`);
  // v56: first boot of a NEW deploy fires one internal canary render
  // (fail-open, once per commit — see src/canary.mjs). Delayed so the
  // queue loop is live before the canary job lands in it.
  setTimeout(() => { runCanaryOnBoot(); }, 15_000).unref();
  // v57: listing-link auto-render — one lead per tick (see
  // src/lead-auto-render.mjs).
  startAutoRenderClock();
} else {
  console.info("[queue] pull-queue OFF (no Supabase env) — rendering inline.");
}

// --- Meta leads sync clock (v47) ------------------------------------------
// Vercel Hobby crons are daily-only, so the always-on worker is the clock:
// ping /api/meta-leads-sync every few minutes. All instances ping; the
// endpoint's insert-first dedupe makes concurrent runs safe. Random start
// jitter keeps the three instances from stampeding in the same second.
const LEADS_SYNC_URL = process.env.LEADS_SYNC_URL || "";
if (LEADS_SYNC_URL) {
  const leadsSecret = process.env.RENDER_WEBHOOK_SECRET || process.env.RENDER_WORKER_SECRET || "";
  // 60s default (was 5 min): Instant Form leads tap "View website" seconds
  // after submitting — the welcome email should beat them to the inbox.
  const leadsEveryMs = Math.max(60_000, Number(process.env.LEADS_SYNC_INTERVAL_MS || 60_000));
  const pingLeadsSync = async () => {
    try {
      const res = await fetch(LEADS_SYNC_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${leadsSecret}` }
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) console.warn(`[leads] sync ${res.status}: ${body?.error || ""}`);
      else if (body?.new > 0 || (body?.errors || []).length) console.log("[leads]", JSON.stringify(body));
    } catch (e) {
      console.warn(`[leads] sync ping failed: ${e?.message}`);
    }
  };
  setTimeout(() => {
    pingLeadsSync();
    setInterval(pingLeadsSync, leadsEveryMs).unref();
  }, Math.floor(Math.random() * 30_000)).unref();
  console.info(`[leads] sync clock ON → every ${Math.round(leadsEveryMs / 60000)}m`);
}

async function runRenderJob(jobId, body) {
  const engine = String(body?.manifest?.engine || "remotion").toLowerCase();
  updateJob(jobId, { status: "rendering", phase: "Rendering scenes", progress: 12, engine });
  // Overall hard cap — if anything below this races slower than this, we
  // kill the job rather than let it hang forever. The heartbeat-based stuck
  // reaper (migration 25) handles dead workers; this cap only needs to catch
  // true hangs.
  //
  // v49 (2026-07-15, first customer render): the flat 25-minute cap killed a
  // 16-scene 60s render TEN SECONDS before completion — 9 QC regens, 4 floor
  // renders, 3 CPU stitches and a square variant are all legitimate work, and
  // Promise.race doesn't cancel the loser, so the "failed" job finished
  // uploading as a zombie anyway. Scale the cap with plan size instead:
  // 25 min covers ≤10 scenes; +2.5 min per extra scene; ceiling 55 min.
  const sceneCount = Array.isArray(body?.manifest?.scenes) ? body.manifest.scenes.length : 10;
  const extraScenes = Math.max(0, sceneCount - 10);
  const OVERALL_TIMEOUT_MS = Math.min(55, 25 + extraScenes * 2.5) * 60 * 1000;
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
    // v50.1: confirm the terminal row LANDED before emailing. If the
    // container dies in this window, the async persist can vanish, the
    // reaper redelivers a finished job, and the customer is emailed again
    // by the re-run (Jul 18: Summit Springs, 3 runs, 2 emails). Awaited,
    // read-only, ~max 18s; the claim guard is the backstop if it still
    // fails.
    await confirmTerminalPersist(jobId, "completed");
    // v49: "your video is ready" email. The Vercel endpoint + branded
    // template have existed since f761c5d — but nothing ever CALLED it, so
    // no customer has ever been told their render finished. Fire-and-forget
    // with the shared worker secret; an email failure must never taint a
    // completed render.
    try {
      const notifyBase = process.env.APP_URL || "https://vistalia.ai";
      const userId = body?.manifest?.project?.userId || "";
      const mp4Url = publishedResult?.mp4Url || publishedResult?.masterUrl || "";
      // v56: canary renders notify the FOUNDER (no customer email), and
      // may run without a userId at all.
      const isInternal = body?.manifest?.internal === true;
      if ((userId || isInternal) && mp4Url) {
        fetch(`${notifyBase}/api/notify-render-complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(workerSecret() ? { Authorization: `Bearer ${workerSecret()}` } : {})
          },
          body: JSON.stringify({
            userId,
            jobId,
            mp4Url,
            internal: isInternal,
            thumbnailUrl: publishedResult?.thumbnailUrl || "",
            listingTitle: body?.manifest?.project?.address || body?.manifest?.project?.title || "Your listing video"
          })
        }).then((r) => {
          if (!r.ok) console.warn(`[notify] render-complete email HTTP ${r.status} for ${jobId}`);
          else console.info(`[notify] render-complete email sent for ${jobId}`);
        }).catch((e) => console.warn(`[notify] render-complete email failed: ${e.message}`));
      }
    } catch { /* never block completion on email */ }
  } catch (error) {
    const elapsedMin = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);
    console.error(`[server] job ${jobId} failed after ${elapsedMin} min: ${error.message}`);
    updateJob(jobId, {
      status: "failed",
      phase: "Render failed",
      progress: 100,
      error: error.message || "Vistalia render worker failed.",
      errorCode: error.code || ""
    });
    // v26.4: honor the refund promise. Launch-audit fix: refund on EVERY
    // failure, not just VEO_SCENE_FAILED — stitch, voice-mix, upload, and
    // overall-timeout failures all charged the user with no refund. The
    // refund_render_credit RPC is ledger-driven (migration 15): it reverses
    // exactly what THIS job consumed (quota vs purchased credit), no-ops if
    // nothing was consumed or already refunded, and no-ops for anonymous
    // remotion renders (no userId). Fire-and-forget — refund failure must
    // not mask the render error, but it IS loud in the logs.
    refundRenderCredit(body?.manifest?.project?.userId, jobId, error.code || "RENDER_FAILED").catch((err) =>
      console.error(`[server] ⚠️ REFUND FAILED for job ${jobId}: ${err.message} — refund manually via render_credit_refunds.`)
    );
  }
}

// Refund one render credit for an aborted job. Idempotent server-side
// (unique job_id). No-ops cleanly when Supabase env or userId is absent
// (local dev / anonymous remotion renders).
async function refundRenderCredit(userId, jobId, errorCode) {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey || !userId || !jobId) return;
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/refund_render_credit`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_user_id: userId, p_job_id: jobId, p_error_code: errorCode || null })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`refund_render_credit RPC ${res.status}: ${text.slice(0, 200)}`);
  }
  console.info(`[server] refunded render credit for user ${userId}, job ${jobId}.`);
}

// Run the per-scene regenerate orchestrator with an overall timeout. Regen
// only generates 1 new clip + downloads N-1 + re-stitches, so it's much
// faster than a full render.
//
// v49: the flat 10-minute cap died the same death as the render cap — a
// 16-scene master's regen re-stitches all 17 clips on CPU, and with a
// second render running concurrently it blew past 10 minutes (first
// customer, first Redo-with-AI, 2026-07-15). Scale with the master's
// scene count: 10 min through 8 scenes, +1 min per extra scene, 25 cap.
async function runRegenerateJob(progressKey, body) {
  updateJob(progressKey, { status: "rendering", phase: "Starting regen", progress: 5 });
  const regenScenes = Array.isArray(body?.manifest?.scenes) ? body.manifest.scenes.length : 8;
  const REGEN_TIMEOUT_MS = Math.min(25, 10 + Math.max(0, regenScenes - 8)) * 60 * 1000;
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
      error: error.message || "Vistalia regenerate failed.",
      errorCode: error.code || ""
    });
  }
}

function updateJob(jobId, patch) {
  const current = jobs.get(jobId) || { jobId };
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  persistJobStatus(jobId, next); // mirror to render_jobs (no-op when off-queue)
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
