# EstateMotion — Depth-Based Video Pipeline Build Plan

**Author:** Claude
**Date:** May 17, 2026
**Replaces:** Runway Gen-4 Turbo / Gen-4.5 as the primary "Cinematic AI" engine
**Status:** Proposal — no code shipped until Troy signs off

---

## Why we're doing this

Runway Gen-4 was the wrong tool for real estate. Generative image-to-video models hallucinate object shape across frames (the kitchen island grew a handle, the fan appeared on the ceiling, the fridge has a different cabinet now), and they fight back against motion requests by producing low-frequency shake and drift when prompted to "barely move." We've spent ~92 task list items and three months papering over this with anti-hallucination clauses, motion prompts, fallback engines, and risk scoring. The problem is the architecture.

A depth-based 2.5D parallax pipeline solves the right problem for real estate. The original pixels stay put — they're literally reprojected through a 3D camera model — so object identity is mathematically preserved. The camera move is geometric, so "push 8 feet forward" produces exactly that motion with no shake. The only place a generative model touches the frame is the disocclusion gaps (the holes that appear when the camera reveals areas hidden behind foreground objects), which is a much narrower task than generating an entire video from scratch.

This is the same approach Reel-e.ai is almost certainly using under the hood. Apple Live Photos, Google Pixel Cinematic Photos, and Adobe's 3D Photo feature all use variants of it. The technique is well-documented (Niklaus 2020), the components are open source, and we don't need anyone's proprietary model.

---

## Architecture

The pipeline per scene is six steps. Steps marked **(ML)** are AI/GPU work; steps marked **(CPU)** are deterministic math we own end-to-end.

1. **Photo intake (CPU).** Already in place — Supabase storage, durable URL.
2. **Depth estimation (ML).** Run the photo through DepthAnything V2 Large. Output: a same-resolution depth map (one float per pixel, normalized 0–1, smaller value = closer to camera).
3. **3D scene reconstruction (CPU).** Convert depth map to a triangle mesh. Each pixel becomes a vertex placed at its 3D position (x, y from screen coords, z from depth). Original photo is the texture.
4. **Virtual camera path (CPU).** Pick a camera move based on scene `cameraMotion` (push_in, lateral_pan, orbit, pull_out, tilt_up, detail_sweep). Animate the virtual camera through the 3D scene over N frames at 24fps. This is the part where "orbit 30° around the kitchen island" becomes a real, exact camera move.
5. **Frame render (CPU).** Render each frame from the virtual camera's POV. Disocclusion gaps appear where foreground used to occlude background — these are flagged as inpainting masks.
6. **Disocclusion inpainting (ML).** Feed each frame + its mask to a video-aware inpainting model. The model fills the gaps coherently across time. Output: the final clean clip.

The stitcher, voice narration, music, brand kit, crossfades, validation gates — all of that downstream infrastructure stays exactly as-is. We're swapping out the per-clip generation step. Everything from `stitchClipsAndOverlays` onward is unchanged.

---

## Two implementation paths

There's a fast path that ships a functional v1 in a week using existing Replicate models, and a robust path that takes three weeks and gives us cost control + brand-defensible quality.

### Path A: Replicate-only (v1 in ~7 days)

Use existing Replicate models for the whole pipeline. We orchestrate them in the existing worker.

- **Depth + 3D + inpainting in one call:** there are real-estate-style 2.5D parallax models on Replicate that bundle steps 2–6. `cjwbw/3d-photo-inpainting` (the original Niklaus reference implementation) takes a photo plus camera motion params and returns an MP4. We'd POST per-scene, await, download, and that's the clip.
- Per-scene cost: roughly $0.04–0.08 (depth + 3D + inpainting, ~30s GPU time on Replicate's L40s). For a 24-scene render, ~$1.00–$2.00 in inference cost. Comparable to what we pay Runway today ($0.08/sec × 5s × 24 = $9.60), so actually cheaper.
- Per-scene latency: 30–60 seconds parallelized 4-at-a-time, so a full render is ~5–10 minutes — same ballpark as Runway.

Risks: we're tied to a third-party's hosting and pricing for the core engine, the bundled Replicate models support a limited set of camera motions (mostly push/pull/pan, no true orbit), and the inpainting quality on large moves is what it is. If `cjwbw/3d-photo-inpainting` is degraded or removed, we have to rewrite.

Use Path A to validate the approach end-to-end before investing in Path B.

### Path B: Hybrid Node + Replicate (v1 in ~3 weeks)

Own the geometric pipeline (steps 3–5) in our Node worker. Replicate handles only the ML-heavy parts (depth and inpainting).

- **Depth:** Replicate `chenxwh/depth-anything-v2` (or the official LiheYoung version). ~$0.003 per image, 1–2 seconds. Worker downloads the depth PNG.
- **3D scene + camera + render:** all in Node, using a headless WebGL setup. The `gl` npm package gives us OpenGL ES 2 in Node; `three.js` runs on top of it. We build the depth-displaced mesh, animate a `PerspectiveCamera` along a Bezier path matching the requested camera motion, render N frames, and write each as a PNG. Disocclusion masks are computed by comparing rendered depth to the input depth — pixels with no source data are the mask.
- **Inpainting:** Replicate `lucataco/lama-cleaner` (image inpainting) per frame, or `lucataco/stable-video-diffusion-inpainting` if we can find a temporally-coherent variant. Per-scene cost ~$0.01–0.04. Frames go in, clean frames come back, ffmpeg stitches to MP4.
- Per-scene total cost: ~$0.02–0.06. For a 24-scene render, ~$0.50–$1.50. Significantly cheaper than Runway today.
- Per-scene latency: 15–40s parallelized 4-at-a-time, full render ~3–7 minutes — faster than Runway.

The Node geometry code is straightforward (~300 lines): load depth, build a `PlaneBufferGeometry` with vertex displacement, texture-map the photo, animate camera along a Catmull-Rom curve, render with `THREE.WebGLRenderer({ canvas, context: glContext })`. Three.js examples already exist for nearly every camera-rig pattern we need.

Path B is what we should land on long-term. Path A is the proof point.

---

## Recommended sequence

**Week 1 — Path A spike (proof of concept).**
- Spin up `cjwbw/3d-photo-inpainting` against five real listing photos (one per room type: exterior, kitchen, bedroom, bathroom, living). Try the supported camera motions (push, pull, pan, zoom). Save outputs.
- Compare side-by-side against the same five photos through current Runway pipeline. Subjective quality call.
- If quality is acceptable, proceed. If not, immediately try Path B's hand-rolled approach on the same five photos to compare.
- Deliverable: 5 photos × 2 engines = 10 sample clips for Troy to watch.

**Week 2 — Path A integration if quality holds.**
- Add a new `engine: "depth"` option alongside `runway` and `remotion` (Ken Burns).
- New module `render-worker/src/depth-job.mjs`. Same interface as `runway-job.mjs`: takes manifest, returns finalMp4 + thumbnail. All the stitching, voice, music, brand kit code is reused as-is.
- Worker, per scene: POST to Replicate's `cjwbw/3d-photo-inpainting`, poll for completion, download the clip. Same retry / rate-limit infrastructure as Runway.
- Engine toggle in `ProjectScreen` — three options: "Quick Reel (Ken Burns)", "Cinematic Depth (beta)", "Cinematic Runway (legacy)". Depth is the new default.

**Week 3 — Path B if Replicate quality is insufficient.**
- Vendor in `gl` and `three` packages on the worker. (`gl` requires a small native build; need to verify it installs cleanly on Render.com's Linux container — Render's build environment supports `node-gyp` so it should.)
- Build `render-worker/src/depth-renderer.mjs`: depth → mesh → camera path → frames. ~300 lines.
- Test the renderer in isolation against a fixed photo + depth pair. Verify the camera move is exactly what we asked for, no shake.
- Add inpainting pass via Replicate `lucataco/lama-cleaner` per frame.
- Stitch frames with existing ffmpeg helpers.
- A/B test against Path A output. Lock in whichever is better.

**Week 4 — Polish and rollout.**
- Per-room camera move profiles (kitchens get a slow push-in to the island, primary bedrooms get a slow pan, exteriors get a slow pull-out, etc.).
- Camera move tuning per style pack (Luxury = slower, more dramatic; Social = faster, more aggressive; MLS = very subtle; Investor = neutral).
- Fallback chain: if depth pipeline fails on any scene, fall through to Ken Burns for that scene. Runway stays available behind a paid premium toggle for users who specifically want generative motion.
- Move "depth" from beta default to GA default.

---

## Cost economics

Comparing per-render costs at a typical 24-scene listing video:

| Engine                   | Per-render compute | Per-render latency | Quality risk     |
|--------------------------|--------------------|--------------------|------------------|
| Current Runway Gen-4     | ~$9.60             | 8–14 min           | Hallucination + shake |
| Depth (Path A, Replicate) | $1.00–$2.00       | 5–10 min           | Inpainting artifacts on large moves |
| Depth (Path B, hybrid)   | $0.50–$1.50        | 3–7 min            | Vertex-displacement edge cases |
| Ken Burns (fallback)     | $0.00              | <1 min             | Boring but bulletproof |

We save 75–85% on compute per render *and* ship in less time. Margin per render improves substantially at every price tier.

---

## What could go wrong (honest risk list)

1. **Glossy and reflective surfaces wreck depth estimation.** Real estate has a lot of these: granite, marble, glass railings, mirrors, hardwood with high polish. DepthAnything V2 handles most of them well, but mirrors are a known weak point — the depth model may estimate the reflection as distance behind the mirror, which produces wrong parallax. Mitigation: detect reflective surfaces via a pretrained segmentation model and clamp their depth to surrounding surface depth.

2. **Large camera moves expose disocclusion holes that inpainting can't fill convincingly.** A 30° orbit around a kitchen island reveals 30°-worth of previously-hidden geometry. Inpainting models can hallucinate the missing back side of the island, but it may look wrong. Mitigation: cap camera move magnitude per scene to what the inpainter handles well (5–15° for orbits, 10–20% zoom for pushes). This is still dramatically more motion than what users currently see from Runway.

3. **Wide exteriors with no clear foreground subject don't benefit from parallax.** A shot of a house from the street with no near foreground produces near-flat depth, so the camera move looks like a simple Ken Burns regardless. Mitigation: route those scenes to the existing Ken Burns engine and don't try to force a parallax move. Easy heuristic — measure depth variance, if it's below a threshold use Ken Burns.

4. **Replicate models can be deprecated or rate-limited.** Path A's `cjwbw/3d-photo-inpainting` is community-uploaded and could disappear. Mitigation: Path B is the long-term answer; Path A is the proof point. Don't build the brand on Path A.

5. **The `gl` npm package on Render.com.** Headless WebGL in Node requires native compilation. Render's container has the build tools, but the binary may not be straightforward to install and we may hit GL driver issues. Mitigation: validate before committing to Path B — spend a half-day spike on `npm install gl` against the Render Node image early in Week 2.

6. **Customers expecting "AI cinematic" may feel cheated by "depth-based parallax."** This is a marketing problem, not a technical one. The motion will be more reliable and more dramatic than what they currently get. We can describe it as "Cinematic Depth — every camera move geometrically precise, never morphs or hallucinates." Most agents will not care what's under the hood; they care that the result looks professional.

---

## What we keep

Most of EstateMotion stays exactly as it is. The change is scoped to the per-scene clip generator. Specifically these stay untouched:

- Edit plan generator (`api/create-edit-plan.js`) — still produces scenes, narrationLines, camera motion choices. We may adjust the motion vocabulary slightly to match what depth supports.
- Stitcher (`stitchWithCrossfades`, `stitchWithSimpleConcat`) — works on clips regardless of source.
- Voice narration (`voice-mixer.mjs`) — unchanged.
- Music selector and mix (`pickMusicUrl`, music-catalog) — unchanged.
- Brand kit overlay (corner headshot, outro card) — unchanged.
- Webapp UI mostly unchanged — engine toggle gets a new option, photo upload + drag-reorder + render flow are identical.

The depth engine slots in as a peer of `runway-job.mjs` and `render-job.mjs`. Same input interface (manifest + scenes), same output interface (mp4 + thumbnail), same progress callbacks.

---

## Decision needed from you

**A.** Path A spike this week (Replicate-only, fastest proof of concept), then decide on Path B based on the spike's quality.

**B.** Skip the spike, commit to Path B directly (3-week build, more upfront investment, better long-term).

**C.** Park this — keep refining Runway. Not recommended given the last 92 task items, but the choice is yours.

**D.** Hybrid call you haven't seen yet.

If you pick A or B, I'll start Monday with the listed week-one deliverables. If you pick A, I'll have side-by-side sample clips by end of week for you to judge. If you pick B, I'll have the geometric renderer running against a fixed photo + depth pair by end of week and we'll know whether `gl` plays nicely with Render.com.

Either way, Runway stays in the codebase as a third engine option for the foreseeable future. We don't have to delete it — we just stop defaulting to it.
