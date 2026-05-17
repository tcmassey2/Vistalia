# Depth Engine (Path B)

This is EstateMotion's depth-based 2.5D parallax video engine — the planned replacement for the Runway img2video pipeline. Architecture rationale + multi-week build plan live in `/DEPTH_PIPELINE_BUILD_PLAN.md` at the repo root.

## Why this exists

Runway Gen-4 generates new pixels per frame. On listing photos it morphs object shapes (cabinets change, fans appear, fridges grow handles) and adds shake when prompted to produce restrained motion. The depth engine sidesteps both problems: original pixels are reprojected through a virtual 3D camera, so identity is preserved by construction and the camera move is exact geometry instead of generation. Only disocclusion gaps (areas revealed behind foreground) are filled by an inpainting model — a much narrower task than full-frame generation.

## Files in this engine

```
depth-renderer.mjs   — headless WebGL renderer. Photo + depth + camera path → MP4.
depth-job.mjs        — orchestrator. Same interface as runway-job.mjs.
replicate-client.mjs — depth estimation (DepthAnything V2) + inpainting (LaMa) wrappers.
scripts/smoke-gl.mjs — validates the `gl` npm package installs + runs on the host.
```

## Phase 1 (current)

- Photo → Replicate depth-anything-v2 → depth map
- depth-renderer builds a vertex-displaced plane mesh, animates a PerspectiveCamera along a preset path, pipes raw RGBA frames into ffmpeg
- Output: per-scene MP4 clips, ready for the existing stitcher
- **Not yet:** disocclusion masking + inpainting. Phase 1 ships with stretched edges at object boundaries (the polygons between foreground and background depth get stretched into long triangles). On most real estate photos this is subtle. We assess against Runway before deciding if Phase 2 is necessary.

## Phase 2 (next)

- After rendering each frame, compute a disocclusion mask: pixels with no source data (revealed behind foreground)
- Send frame + mask to Replicate LaMa inpainter
- Restitch clip from cleaned frames

## Phase 3 (later)

- Per-room camera presets (kitchen → slow push to island, primary bedroom → wide pan, exterior → slow pull-back)
- Per-style intensity (Luxury = slower/smaller, Social = faster/bigger, MLS = minimal, Investor = neutral)
- Optional video-aware inpainter (ProPainter) for the highest-tier renders

## Safety gate

The depth engine ships behind `ENABLE_DEPTH_ENGINE=true`. Until that env var is set on the worker, `renderDepthJob` throws a clear "not yet wired" error. This lets the code deploy without affecting any live render path. Toggle the env to spike-test in production without changing the engine routing for everyone else.

## Smoke tests

```bash
# Validate gl installs + runs on this host. Should print a row of green ✓.
npm run smoke:gl

# Validate the full depth-renderer pipeline against a fixed photo + depth pair.
# Outputs render-worker/scratch/depth-smoke.mp4.
npm run smoke:depth
```

If `smoke:gl` fails on Render.com, the depth engine cannot ship in this form — pivot to a Python sidecar using Open3D.

## Cost model (per 24-scene render)

Phase 1 (depth + WebGL render only):
- 24 × DepthAnything V2 Large ≈ $0.07
- Local WebGL render: free
- Total per render: ~$0.10

Phase 2 (+ inpainting):
- 24 × ~120 frames × LaMa inpaint @ $0.00015/img ≈ $0.43
- Total per render: ~$0.50

Compare to current Runway: ~$9.60 per render. Depth engine is roughly 10–20× cheaper at equal output length.

## When NOT to use the depth engine

Wide exteriors with no clear foreground subject produce near-flat depth maps. Parallax through a flat scene looks like a basic Ken Burns regardless. For those scenes, route to the existing Ken Burns engine (the worker's `remotion` path) rather than wasting depth + inpaint compute.

A simple heuristic — depth variance below threshold T → Ken Burns — should land in Phase 3.
