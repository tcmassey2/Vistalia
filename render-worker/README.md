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

`tools/parallax.py` (python3 + numpy + opencv-contrib-headless + onnxruntime, Depth Anything V2 small and big-LaMa baked into the Docker image under `/app/models/`) renders a scene from the depth of the customer's photo: an exact dolly, truck or arc at native resolution, every pixel from the photo; the strip a lateral move reveals behind foreground objects is inpainted once per scene with LaMa. The crop keeps photo beyond the frame edge so a truck reveals the room, not a zoom. `src/parallax-job.mjs` drives it; `src/clip-gate.mjs` + `tools/clip-gate.py` measure every generated clip. Decision record: `~/Documents/EstateMotion/MODEL_BAKEOFF_SEP2026.md` §4b/§8.

```
PARALLAX_MODE=off        # default — v63 behaviour, nothing changes
PARALLAX_MODE=floor      # parallax replaces homography drift as the QC floor
PARALLAX_MODE=interior   # production setting: interiors render on parallax as the PRIMARY (no fal spend);
                         # exteriors/pools/twilights stay generative + measured gate + parallax floor
PARALLAX_MODE=all        # every scene on parallax
MEASURED_GATE=1|0        # force the measured gate on/off (default: on whenever PARALLAX_MODE != off)
GATE_ZOOM_MIN=1.01 GATE_ZOOM_MAX=1.16 GATE_ZOOM_MAX_EXTERIOR=1.35   # camera-travel budgets (interior / exterior rooms)
GATE_RIGID_MAX=0.04 GATE_LINES_MIN=50 GATE_FLICKER_MAX=1.5           # per-step morph residual, edge survival, exposure pumping
PARALLAX_VELOCITY=1.0    # scales the whole move (v64.2: 3.7%/s push at the v39-floor speed, gain 0.6–2.2 by scene length)
PARALLAX_LATERAL=1.0     # v64.3: scales trucks/arcs (0 = push-only); scene order arc-right, push, truck-left, truck-right, hero-push, arc-left
PARALLAX_MARGIN_X=0.13   # photo kept beyond the frame edge for lateral moves (fraction of frame width); Y 0.05
PARALLAX_LAMA_PATH=/app/models/lama_fp32.onnx   # big-LaMa for the revealed strip; missing → Telea fallback, logged as "plate telea"
PARALLAX_ZOOM_MAX=1.30   # push cap; keep ≤ PARALLAX_SUPERSAMPLE/1.3 so the last frame stays sharper than native
PARALLAX_SUPERSAMPLE=1.75 # crop scale fed to the renderer (1–2.5)
PARALLAX_MAP_EVERY=1     # v64.4: exact maps every frame; >1 lerps between keyframes (the v64.3 4-frame jerk — speed knob only)
PARALLAX_RENDERER=splat  # v64.4 forward z-buffer renderer; "layers" = the v64.3 layered inverse (rollback)
PARALLAX_AA=super        # anti-aliased resample (cubic at source res + area + 0.35 unsharp); "none" = the v64.3 Lanczos (rollback)
PARALLAX_STEP_HIGH=0.10  PARALLAX_STEP_LOW=0.06   # occlusion-edge hysteresis on the depth map (5x5 disparity range)
PARALLAX_LAYERS=32       # depth layers of the legacy layered renderer only
PARALLAX_NEAR_RATIO=3    # assumed far/near depth ratio (relative depth's unknown shift); higher = stronger parallax, more fill
PARALLAX_PYTHON=python3  PARALLAX_MODEL_PATH=/app/models/dav2_base.onnx   # v64.4: Depth Anything V2 BASE (small still works as a drop-in)
```

A generated clip that fails ONLY on camera travel (over-push / pull-back / static) skips the prompt ladder and goes straight to the floor — travel is the engine's property on that photo, not the prompt's (Sep-22 smoke test: 1.23 → 1.48 → 1.35 → 1.17 across four prompts). Morph / edge / flicker failures keep the full ladder. The slideshow guard judges generative scenes only; parallax scenes print their own line (≈0.6–1.2 YDIF is by design: exact camera, no redraw).

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
