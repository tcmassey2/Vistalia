# EstateMotion Render Worker

This package is the Remotion MP4 renderer for EstateMotion. It is intentionally separate from the root static app so Vercel can keep deploying the browser MVP without installing React, Remotion, or Chromium rendering dependencies.

## Local Setup

### Supported local runtime

On a normal development machine, use Node.js 20+ with `npm`:

```bash
cd render-worker
npm ci
npm run check
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
SUPABASE_GENERATED_VIDEOS_BUCKET=generated-videos \
RENDER_WORKER_SECRET=replace-me \
npm run start
```

In the Codex desktop workspace used for this project, `npm` is not on `PATH` and the Codex.app embedded Node cannot load the Remotion/Rspack native binding. Use the bundled workspace Node directly:

```bash
export CODEX_NODE="/Users/troymassey/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
cd render-worker
$CODEX_NODE --check src/render-job.mjs
$CODEX_NODE --check server.mjs
$CODEX_NODE --check render-local.mjs
$CODEX_NODE --check render-openai-plan.mjs
$CODEX_NODE --check verify-async-render.mjs
PORT=8787 $CODEX_NODE server.mjs
```

Health check:

```bash
curl http://localhost:8787/health
```

Worker checks:

```bash
npm run check
npm run render:sample
```

Codex workspace equivalent:

```bash
$CODEX_NODE render-openai-plan.mjs
```

## Async Render Verification

With the worker running locally:

```bash
cd render-worker
export CODEX_NODE="/Users/troymassey/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
RENDER_WORKER_URL=http://localhost:8787 $CODEX_NODE verify-async-render.mjs
```

This creates:

- `out/async-verification/professional-listing-video.manifest.json`
- `out/async-verification/downloaded-professional-listing-video.mp4`
- `out/async-verification/downloaded-thumbnail.png`
- `out/async-verification/verification.json`

The verification submits a real async job and confirms:

- `queued -> rendering -> completed`
- completed response includes `mp4Url`
- MP4 is downloadable
- expected duration is 45-60 seconds
- intro card, property stat card, photo scenes, and branded outro are included
- camera motion and transition metadata are present

Verified locally on May 1, 2026 with:

- duration: `54.955s`
- scenes: `18`
- photo scenes: `16`
- output size: `15 MB`
- MP4 URL: worker-served `/render/assets/:jobId/estate-motion.mp4`

`npm run render:sample` renders six local Marketing OS MP4s into `render-worker/out/marketing-os`:

- Listing Reel
- Seller Lead Magnet
- Investor Deal Breakdown
- Wholesale Opportunity
- Neighborhood Spotlight
- Agent Brand

The sample harness serves generated durable test images over a localhost HTTP server so the renderer exercises production-like image URLs instead of browser-only `blob:` or blocked `file:` URLs.

The static app calls `/api/render`. The Vercel function then forwards the manifest to this worker at `RENDER_WORKER_URL`.

## Docker Deploy

Use Docker when the local machine does not have a working Node/npm runtime:

```bash
cd render-worker
docker build -t estatemotion-render-worker .
docker run --rm -p 8787:8787 \
  -e PORT=8787 \
  -e SUPABASE_URL=https://your-project.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
  -e SUPABASE_GENERATED_VIDEOS_BUCKET=generated-videos \
  -e RENDER_WORKER_SECRET=replace-me \
  estatemotion-render-worker
```

For local verification without Supabase upload, omit the Supabase variables. The worker will return a temporary worker-served `mp4Url` for the rendered file.

## Depth-parallax engine + measured gate (v64)

`tools/parallax.py` (python3 + numpy + opencv-contrib-headless + onnxruntime, Depth Anything V2 small baked into the Docker image at `/app/models/dav2_small.onnx`) renders a scene from the depth of the customer's photo: exact 6–8% dolly, native resolution, every pixel from the photo. `src/parallax-job.mjs` drives it; `src/clip-gate.mjs` + `tools/clip-gate.py` measure every generated clip. Decision record: `~/Documents/EstateMotion/MODEL_BAKEOFF_SEP2026.md` §4b/§8.

```
PARALLAX_MODE=off        # default — v63 behaviour, nothing changes
PARALLAX_MODE=floor      # parallax replaces homography drift as the QC floor
PARALLAX_MODE=interior   # production setting: interiors render on parallax as the PRIMARY (no fal spend);
                         # exteriors/pools/twilights stay generative + measured gate + parallax floor
PARALLAX_MODE=all        # every scene on parallax
MEASURED_GATE=1|0        # force the measured gate on/off (default: on whenever PARALLAX_MODE != off)
GATE_ZOOM_MIN=1.01 GATE_ZOOM_MAX=1.16 GATE_RIGID_MAX=0.15 GATE_LINES_MIN=50 GATE_FLICKER_MAX=3.0
PARALLAX_SUPERSAMPLE=1.5 # crop scale fed to the renderer (1–2)
PARALLAX_MAP_EVERY=3     # warp maps every N frames (lerped); 2 = slower, marginally finer
PARALLAX_LAYERS=32       # depth layers for the z-test
PARALLAX_NEAR_RATIO=4    # assumed far/near depth ratio (relative depth's unknown shift)
PARALLAX_PYTHON=python3  PARALLAX_MODEL_PATH=/app/models/dav2_small.onnx
```

Checks: `npm run parallax:check` (imports + model present), `npm run test:parallax` (routing, choreography, gate thresholds), `python3 tools/clip-gate.py --clip some.mp4`. Everything fails closed: Python or model missing → the generative ladder and the v39 homography floor exactly as before. Cost: ~50–100 s of worker CPU per 5-second interior scene, serialised; interiors are $0 in generation.

## Required Runtime Env

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_GENERATED_VIDEOS_BUCKET`, defaults to `generated-videos`
- `RENDER_WORKER_SECRET`, optional but recommended
- `PORT`, defaults to `8787`

## Frontend / Vercel Env

Set these on the static Vercel project:

```bash
MOCK_RENDERING=false
RENDER_WORKER_URL=https://your-render-worker.example.com
RENDER_WEBHOOK_SECRET=replace-me
```

`RENDER_WORKER_URL` can be either the worker base URL or the full `/render` endpoint.

## Current Rendering Scope

The worker renders one reliable full-property MP4 from the EstateMotion render manifest:

- ordered listing photo scenes
- real estate scene labels
- hook and overlay text
- feature cards
- beat-paced durations
- camera motion plan
- brand end card
- compliance footer
- Marketing OS overlays for seller, investor, wholesale, neighborhood, and agent-brand modes
- MP4 plus thumbnail upload to Supabase Storage

Live rendering requires public/Supabase image URLs. Browser `blob:` URLs from pure local mock uploads cannot be rendered by a remote worker; keep `MOCK_RENDERING=true` for fully local demos.

Safe fallbacks are included for missing agent name, brokerage, neighborhood, headshot/logo, ARV, and rehab estimate. Investor and wholesale overlays label figures as estimates, and seller preview language avoids guaranteed sale-price claims.
