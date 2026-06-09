// EstateMotion — Veo image-to-video worker via fal.ai (v25 Phase 1b).
//
// This file replaces our previous Vertex-AI-direct implementation. The
// direct path required a Google Cloud service-account JSON key, which
// is blocked by Google's Secure-by-Default org policy on free-tier
// accounts (iam.disableServiceAccountKeyCreation). Rather than fight
// the org policy, we route Veo via fal.ai which:
//   - accepts a single API key (FAL_KEY) instead of SA + IAM + bucket
//   - accepts our Supabase image URL directly (no GCS upload)
//   - returns a plain HTTPS mp4 URL (no GCS download with auth)
//   - lets us A/B test Veo, Luma, Kling, and Seedance against each
//     other by changing one env var (FAL_VIDEO_MODEL)
//
// Phase 1b ships ONLY the standalone smoke test. Production routing
// stays on Runway until Phase 2 swaps the dispatcher.
//
// ─── Environment ────────────────────────────────────────────────
// Required:
//   FAL_KEY            - your fal.ai API key (starts with fal_)
//
// Optional:
//   FAL_VIDEO_MODEL    - endpoint id, default "fal-ai/veo3/fast/image-to-video"
//                        Other options worth testing in the bake-off:
//                          fal-ai/veo3.1/lite/image-to-video
//                          fal-ai/veo3.1/image-to-video
//                          fal-ai/kling-video/o3/standard/image-to-video
//                          fal-ai/luma-dream-machine/ray-2/image-to-video
//                          fal-ai/bytedance/seedance/v1/pro/image-to-video
//   FAL_RESOLUTION     - "720p" or "1080p" (default "1080p")
//   FAL_DURATION       - "4s" | "6s" | "8s" (default "6s"; our scenes
//                        are 5s and Veo only does 4/6/8 — round up)
//   FAL_GENERATE_AUDIO - "true" or "false" (default "false" — we have
//                        our own music + ElevenLabs voice pipeline)
//   FAL_SAFETY         - 1-6 (default "4"; higher = looser)

import fs from "node:fs/promises";
import path from "node:path";

// Lazy-import @fal-ai/client so the worker can boot even before the
// dep is installed (npm install runs at deploy time).
let _fal = null;
async function getFalClient() {
  if (_fal) return _fal;
  try {
    const mod = await import("@fal-ai/client");
    _fal = mod.fal || mod.default?.fal;
    if (!_fal) {
      throw new Error("@fal-ai/client loaded but `fal` export not found.");
    }
    return _fal;
  } catch (err) {
    const msg = err?.code === "ERR_MODULE_NOT_FOUND"
      ? "@fal-ai/client not installed. Run `npm install @fal-ai/client` in render-worker/."
      : `Failed to load @fal-ai/client: ${err.message || err}`;
    const wrapped = new Error(msg);
    wrapped.code = "FAL_SDK_UNAVAILABLE";
    throw wrapped;
  }
}

// Defaults.
const DEFAULT_MODEL = "fal-ai/veo3/fast/image-to-video";
const DEFAULT_RESOLUTION = "1080p";
const DEFAULT_DURATION = "6s";
const DEFAULT_GENERATE_AUDIO = false;
const DEFAULT_SAFETY = "4";

/* =================================================================
   generateVeoClip — the per-scene primitive.

   Submits one image + one motion prompt to fal.ai, blocks until the
   queue completes, downloads the resulting mp4 to local disk. Returns:
     {
       clipPath:    "/tmp/.../veo-scene-003.mp4",
       sceneIndex:  3,
       photoId:     "uuid",
       duration:    "6s",
       videoUrl:    "https://...mp4" // fal.ai's hosted output URL
       requestId:   "abc-123",       // for ops/debug
       model:       "fal-ai/veo3/fast/image-to-video"
     }

   Failures throw with .code:
     FAL_CONFIG_MISSING   - FAL_KEY not set
     FAL_SDK_UNAVAILABLE  - @fal-ai/client not on disk
     FAL_BAD_INPUT        - missing imageUrl or prompt
     FAL_GENERATE_FAILED  - submit/queue threw (API error)
     FAL_NO_OUTPUT        - queue completed but no video URL returned
     FAL_DOWNLOAD_FAILED  - couldn't fetch the mp4 from fal.ai's CDN
   ================================================================= */
export async function generateVeoClip({
  imageUrl,
  prompt,
  aspectRatio = "9:16",        // EstateMotion ships vertical 9:16 masters
  duration,                    // string: "4s" | "6s" | "8s"
  sceneIndex = 0,
  photoId = "",
  tempDir,
  // Allow per-call overrides so the bake-off script can sweep models.
  model = process.env.FAL_VIDEO_MODEL || DEFAULT_MODEL,
  resolution = process.env.FAL_RESOLUTION || DEFAULT_RESOLUTION,
  generateAudio = toBool(process.env.FAL_GENERATE_AUDIO, DEFAULT_GENERATE_AUDIO),
  safetyTolerance = process.env.FAL_SAFETY || DEFAULT_SAFETY
}) {
  if (!process.env.FAL_KEY) {
    const err = new Error(
      "FAL_KEY env var is required. Get one at https://fal.ai/dashboard/keys."
    );
    err.code = "FAL_CONFIG_MISSING";
    throw err;
  }
  if (!imageUrl) {
    const err = new Error("generateVeoClip: imageUrl is required.");
    err.code = "FAL_BAD_INPUT";
    throw err;
  }
  if (!prompt || !prompt.trim()) {
    const err = new Error("generateVeoClip: prompt is required.");
    err.code = "FAL_BAD_INPUT";
    throw err;
  }
  if (!tempDir) {
    const err = new Error("generateVeoClip: tempDir is required.");
    err.code = "FAL_BAD_INPUT";
    throw err;
  }

  const fal = await getFalClient();
  // @fal-ai/client auto-reads FAL_KEY from env, but call config() explicitly
  // so a different runtime that injected the var late still works.
  fal.config({ credentials: process.env.FAL_KEY });

  // fal.ai Veo 3 Fast accepts duration as enum "4s"|"6s"|"8s". Our pipeline
  // uses numeric 5s — round up to 6s for cinematic flow (4s feels choppy).
  const durationEnum = normalizeDuration(duration);

  // v26.1: per-model input mapping. Each fal.ai model family has its own
  // schema — sending Veo-shaped input (duration "6s", resolution,
  // generate_audio, safety_tolerance) to Luma or Kling 422s with
  // "Unprocessable Entity". Discovered live during the laundry/pool
  // bake-off. Map to the right shape per family so --model sweeps work.
  const input = buildModelInput(model, {
    prompt,
    imageUrl,
    aspectRatio,
    durationEnum,
    resolution,
    generateAudio,
    safetyTolerance
  });

  let result;
  try {
    // subscribe() blocks until the queue completes (60-180s typical for
    // Veo 3 Fast). It internally handles status polling so we don't have
    // to roll our own poll loop like we did with Vertex AI direct.
    result = await fal.subscribe(model, {
      input,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && Array.isArray(update.logs)) {
          for (const log of update.logs) {
            console.info(`[fal/${model}] scene ${sceneIndex + 1}: ${log.message}`);
          }
        }
      }
    });
  } catch (err) {
    const wrapped = new Error(
      `fal.subscribe failed for scene ${sceneIndex + 1} on ${model}: ${err.message || err}`
    );
    wrapped.code = "FAL_GENERATE_FAILED";
    wrapped.cause = err;
    throw wrapped;
  }

  // Output schema:
  //   { video: { url, content_type?, file_name?, file_size? } }
  const videoUrl = result?.data?.video?.url || "";
  if (!videoUrl) {
    const err = new Error(
      `fal.ai scene ${sceneIndex + 1} completed but no video URL was returned.`
    );
    err.code = "FAL_NO_OUTPUT";
    err.responseSnapshot = JSON.stringify(result?.data || {}).slice(0, 300);
    throw err;
  }

  // Download the mp4 from fal.ai's CDN. Public URL, no auth required.
  const clipPath = path.join(
    tempDir,
    `veo-scene-${String(sceneIndex).padStart(3, "0")}.mp4`
  );
  try {
    await downloadToFile(videoUrl, clipPath);
  } catch (err) {
    const wrapped = new Error(
      `fal.ai scene ${sceneIndex + 1} download failed (${videoUrl}): ${err.message || err}`
    );
    wrapped.code = "FAL_DOWNLOAD_FAILED";
    wrapped.cause = err;
    throw wrapped;
  }

  return {
    clipPath,
    sceneIndex,
    photoId,
    duration: durationEnum,
    videoUrl,
    requestId: result?.requestId || "",
    model
  };
}

/* =================================================================
   runVeoSmokeTest — POST /test/veo handler helper.
   One image + one prompt → one local clip path.
   ================================================================= */
export async function runVeoSmokeTest({ imageUrl, prompt, aspectRatio, duration, model, tempDir }) {
  return generateVeoClip({
    imageUrl,
    prompt,
    aspectRatio: aspectRatio || "9:16",
    duration: duration || "6s",
    sceneIndex: 0,
    photoId: "smoke-test",
    tempDir,
    ...(model ? { model } : {})
  });
}

/* =================================================================
   Helpers
   ================================================================= */

// v26.1: per-model-family input shapes. fal.ai models do NOT share a
// schema. Verified against fal.ai model API docs June 2026:
//   veo3 family:   prompt, image_url, aspect_ratio, duration "4s|6s|8s",
//                  resolution, generate_audio, safety_tolerance
//   luma ray-2:    prompt, image_url, aspect_ratio, duration "5s|9s",
//                  resolution "540p|720p|1080p", loop
//   kling o3/v2:   prompt, image_url, duration "5|10" (no 's'),
//                  aspect_ratio, cfg_scale
//   seedance:      prompt, image_url, duration "5|10", resolution
// Unknown families get the minimal universal pair + aspect/duration in
// the most common shape, which is also the safest default.
function buildModelInput(model, { prompt, imageUrl, aspectRatio, durationEnum, resolution, generateAudio, safetyTolerance }) {
  const m = String(model || "").toLowerCase();
  const seconds = parseInt(durationEnum, 10) || 6;

  if (m.includes("luma")) {
    return {
      prompt,
      image_url: imageUrl,
      aspect_ratio: aspectRatio,
      duration: seconds <= 5 ? "5s" : "9s",
      resolution
    };
  }
  if (m.includes("kling")) {
    return {
      prompt,
      image_url: imageUrl,
      aspect_ratio: aspectRatio,
      duration: seconds <= 5 ? "5" : "10"
    };
  }
  if (m.includes("seedance")) {
    return {
      prompt,
      image_url: imageUrl,
      duration: seconds <= 5 ? "5" : "10",
      resolution
    };
  }
  // veo3 family + default
  return {
    prompt,
    image_url: imageUrl,
    aspect_ratio: aspectRatio,
    duration: durationEnum,
    resolution,
    generate_audio: generateAudio,
    safety_tolerance: safetyTolerance
  };
}

// Convert a numeric or string seconds value to fal.ai's enum.
// fal.ai Veo 3 Fast only supports "4s" | "6s" | "8s". Pick the
// next-largest bucket so we never undershoot what the manifest asked for.
function normalizeDuration(raw) {
  if (typeof raw === "string" && /^\d+s$/.test(raw)) {
    const n = parseInt(raw, 10);
    return secondsToEnum(n);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DURATION;
  return secondsToEnum(n);
}

function secondsToEnum(n) {
  if (n <= 4) return "4s";
  if (n <= 6) return "6s";
  return "8s";
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

// Stream-download a public URL into a local file using built-in fetch.
async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
}
