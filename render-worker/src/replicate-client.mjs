// EstateMotion — Replicate API client (Path B depth engine).
//
// Thin wrapper around Replicate's REST API for the two ML models we
// depend on:
//   1. Depth estimation — depth-anything-v2 (large variant)
//      Takes a photo URL, returns a depth-map URL.
//   2. Image inpainting — LaMa-cleaner (lucataco/lama-cleaner)
//      Takes a photo + mask, returns a filled photo URL.
//
// Why these models specifically:
//   - DepthAnything V2 is the current SOTA open-source depth model,
//     handles indoor reflections + glossy surfaces better than MiDaS.
//   - LaMa is deterministic and trained for inpainting (not generation),
//     so it fills disocclusion gaps without hallucinating new objects.
//     Critical for real estate MLS compliance.
//
// Replicate auth: REPLICATE_API_TOKEN env var. Existing worker code
// already expects this (cinematic 4K photo upscale uses it).
//
// Retries: standard exponential backoff on 429 / 5xx. Polls predictions
// every 1.5s with a hard cap of 90s per call.

import { readFile } from "node:fs/promises";

const REPLICATE_BASE = "https://api.replicate.com/v1";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90 * 1000;

// Model version pins — replicate caches by version sha, so pinning means
// our renders are reproducible. Bump these intentionally when upgrading.
//
// NOTE: these are placeholders pinned from public model pages as of
// build time. Confirm before going live — `npm run smoke:depth` will
// fail loudly if any model slug is wrong.
const MODELS = {
  // chenxwh/depth-anything-v2: official depth-anything-v2 large checkpoint
  // packaged for Replicate. Outputs a single-channel depth PNG.
  depthAnythingV2: "chenxwh/depth-anything-v2",
  // lucataco/lama-cleaner: LaMa inpainting wrapped for Replicate. Takes
  // image + mask (white = inpaint this), returns filled image.
  lamaInpaint: "lucataco/lama-cleaner"
};

function authHeader() {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN env var not set");
  return { Authorization: `Token ${token}`, "Content-Type": "application/json" };
}

/* ============================================================
   Generic prediction runner
   ============================================================ */
// Cache for slug → latest version SHA lookups. Replicate's POST
// /predictions endpoint requires a version SHA, not a slug, so we
// resolve the slug to its current latest version once per process
// and reuse. Cache TTL is the process lifetime — restarts pick up
// model updates.
const versionCache = new Map();

async function resolveLatestVersion(modelSlug) {
  if (versionCache.has(modelSlug)) return versionCache.get(modelSlug);
  const meta = await fetchJsonWithRetry(
    `${REPLICATE_BASE}/models/${modelSlug}`,
    { headers: authHeader() },
    { label: `replicate:resolve:${modelSlug}`, maxAttempts: 3 }
  );
  const versionId = meta?.latest_version?.id;
  if (!versionId) {
    throw new Error(
      `Replicate model '${modelSlug}' has no latest_version. ` +
      `Check that the slug is correct AND the model has at least one published version. ` +
      `Verify at https://replicate.com/${modelSlug}`
    );
  }
  versionCache.set(modelSlug, versionId);
  return versionId;
}

async function runPrediction({ model, input, label }) {
  // Resolve slug -> latest version SHA. Required by Replicate's
  // /v1/predictions endpoint; passing the bare slug returns 422
  // 'Invalid version or not permitted'.
  const versionId = await resolveLatestVersion(model);

  const start = await fetchJsonWithRetry(
    `${REPLICATE_BASE}/predictions`,
    {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        version: versionId,
        input
      })
    },
    { label: `${label}:submit`, maxAttempts: 4 }
  );

  if (!start?.urls?.get) {
    throw new Error(`${label}: Replicate did not return a prediction URL`);
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await fetchJsonWithRetry(start.urls.get, { headers: authHeader() }, { label: `${label}:poll`, maxAttempts: 3 });
    if (poll.status === "succeeded") return poll.output;
    if (poll.status === "failed" || poll.status === "canceled") {
      throw new Error(`${label}: prediction ${poll.status} — ${poll.error || "no error message"}`);
    }
  }
  throw new Error(`${label}: prediction timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

/* ============================================================
   Depth estimation
   ============================================================ */
// Returns a URL to the depth-map PNG (grayscale, 0=near, 255=far).
//
// chenxwh/depth-anything-v2 returns:
//   { color_depth: "<url>", grey_depth: "<url>" }
// where grey_depth is the single-channel depth PNG our renderer needs
// (color_depth is a viridis-colorized debug view, not usable for mesh
// vertex displacement because each pixel is RGB not depth).
//
// Other depth models on Replicate return different shapes:
//   - LiheYoung/depth-anything: bare string URL
//   - cjwbw/midas: { depth_map: "<url>" } or array
// So we accept all the common shapes and prefer grey_depth when present.
export async function estimateDepth({ imageUrl }) {
  if (!imageUrl) throw new Error("estimateDepth: imageUrl required");
  const output = await runPrediction({
    model: MODELS.depthAnythingV2,
    input: {
      image: imageUrl,
      // depth-anything-v2 accepts model_size: 'Small'|'Base'|'Large'.
      // Large is best quality, ~2s on Replicate's L40s, costs ~$0.003.
      model_size: "Large"
    },
    label: "depth-anything-v2"
  });

  if (typeof output === "string") return output;
  // chenxwh/depth-anything-v2 — grayscale is grey_depth (US spelling
  // also accepted as gray_depth, just in case the model version renames).
  if (output?.grey_depth) return output.grey_depth;
  if (output?.gray_depth) return output.gray_depth;
  // Fallback to color_depth ONLY if grey isn't present. Note: the depth
  // renderer expects a single-channel PNG; color_depth is RGB and will
  // produce a less accurate mesh, but it's better than failing.
  if (output?.color_depth) {
    console.warn("[depth] grey_depth missing in Replicate output — falling back to color_depth. Mesh accuracy may degrade.");
    return output.color_depth;
  }
  if (output?.depth_map) return output.depth_map;
  if (Array.isArray(output) && output[0]) return output[0];
  throw new Error(`estimateDepth: unexpected output shape: ${JSON.stringify(output).slice(0, 200)}`);
}

/* ============================================================
   Inpainting
   ============================================================ */
// imageUrl: HTTPS URL OR data:image/png;base64,... data URL of the frame.
// maskUrl:  same — PNG where white pixels = inpaint here (disocclusion holes).
// Returns: URL to the filled image.
//
// Data URL note: Replicate accepts base64-inlined inputs. For the depth
// engine's per-frame inpaint pass we feed data URLs so we don't have to
// shuffle every frame through Supabase storage just to make it HTTPS-
// reachable. Per-frame PNGs are ~50-200 KB → ~70-270 KB base64 →
// comfortably under Replicate's 25 MB request limit.
export async function inpaintImage({ imageUrl, maskUrl }) {
  if (!imageUrl || !maskUrl) throw new Error("inpaintImage: imageUrl + maskUrl required");
  const output = await runPrediction({
    model: MODELS.lamaInpaint,
    input: {
      image: imageUrl,
      mask: maskUrl
    },
    label: "lama-inpaint"
  });
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output[0]) return output[0];
  if (output?.url) return output.url;
  throw new Error(`inpaintImage: unexpected output shape: ${JSON.stringify(output).slice(0, 200)}`);
}

/* ============================================================
   Helper: convert a local PNG path to a data: URL string
   ============================================================
   For passing per-frame images to inpaintImage without an
   external storage round-trip. PNG only — caller's responsibility.
*/
export async function fileToDataUrl(localPath, mime = "image/png") {
  const buf = await readFile(localPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/* ============================================================
   Helpers
   ============================================================ */
async function fetchJsonWithRetry(url, options, { label, maxAttempts = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const body = await res.text().catch(() => "");
        lastErr = new Error(`${label}: HTTP ${res.status} ${body.slice(0, 200)}`);
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 240)}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) throw err;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
