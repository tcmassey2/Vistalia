# Render pipeline audit — 2026-07-01 (pre-smoke-test, final pre-launch pass)

Scope: everything from edit-plan to delivered MP4 — prompts, plan math,
fal mapping, generation buckets, upscale/grade, stitch, narration, regen,
queue. Verified by 456-config numeric simulation (19 tracks × 4 styles ×
2 durations × 3 photo counts), a live two-level-stitch integration test,
and a regression harness against the production snapper source.

## Bugs found & fixed (all would have shipped)

1. **Beat-grid float bug — random scenes silently DOUBLED**
   (`api/create-edit-plan.js` snapDurationsToBeat). Float epsilon
   (2.9719999999999995 < 2.972) tripped the MIN branch, whose ceil() of
   7.000000000000001 jumped a whole extra unit. On tracks whose snap unit
   divides evenly (e.g. leberch-piano), HALF the scenes doubled: pacing
   broken, 60s target rendered ~80s, doubled scenes billed 8s buckets
   (2× COGS). EPS guards on every comparison. Regression: killer config now
   50.68s, zero doubles.

2. **Batched-stitch seams broke beat-sync AND lengthened the master**
   (`render-worker/src/stitch.mjs`). Batches (needed above 6 clips) were
   hard-concatenated — no crossfade at seams — while every clip carries
   +0.5s specifically for its join to consume. v30's 5-scene renders always
   took the single-pass path; v31's 9-17 scene plans batch EVERY render:
   cuts after each seam landed +0.5s off-grid and the master ran +0.5s/seam
   long. Fix: second-level xfade across batch outputs (3-5 inputs, same
   memory envelope). Integration test: 11 clips/3 batches → master within
   47ms of exact.

3. **Narration drifted (k-1)×0.5s late per scene** (`voice-mixer.mjs`).
   The mixer's timeline was the raw SUM of clip durations, ignoring that
   each crossfade join consumes 0.5s. ~2s worst-case at 5 scenes (masked
   historically by short lines + lead-ins); at 9-17 scenes late lines get
   chopped by their own scene-window caps. Fix: mixer now receives
   `crossfadeOverlapSec` and builds the VISIBLE timeline (d − overlap per
   scene) — exact for every scene incl. the last (its tail is absorbed by
   the outro crossfade).

4. **Regen narration never had the v26.9 sync fix**
   (`regenerate-job.mjs`). It passed no actual clip durations — post-v31
   the fallback (manifest snapped durations) diverges from the padded clips
   on disk. Now passes real durations + overlap, matching full renders.

5. **Stuck-job reaper could double-render healthy long jobs**
   (migration 25 + `server.mjs`). requeue_stuck was claimed_at-based: any
   job over 20 minutes was requeued WHILE RUNNING → second worker → double
   fal spend + row write races. v31's 17-scene 60s renders brush that
   window. Fix: workers heartbeat on every status write;
   reaper keys off heartbeat staleness. Deploy-order safe (patch retries
   without heartbeat_at until migration 25 is applied). Overall hard
   timeout raised 18→25 min accordingly.

6. **Overrun guard** (`create-edit-plan.js`): if a snapped plan exceeds the
   requested duration by >20%, durations rescale toward target and re-snap
   once (still on-grid). Post-EPS this is belt-and-suspenders.

## Verified sound (no changes)

- **fal mapping**: veo branch force-720p for 4s/6s (1080p only at 8s — can't
  422); v31 buckets always cover trims (456/456 configs).
- **Prompts**: Motion Director system prompt v31-consistent (3-3.5s scenes,
  4-6s heroes); VEO_MOTION/STYLE prompts + fidelity suffix + foliage lock +
  risky-term filter intact; narration word budgets match scene lengths.
- **Beat math**: every cut on-grid in all 456 configs (two-level stitch
  algebra proven equal to single-pass: boundary_j = Σ snapped≤j).
- **Grade/upscale**: pre-scale denoise → lanczos → tuned unsharp chain
  executes clean (ffmpeg dry-run, 720p→1080×1920).
- **Costs (post-fix)**: 30s = $5.40–8.10 (9 scenes) · 60s = $6.00–15.30
  (10-17 scenes, typical ~$10-12). Worst cases are slow-track luxury mixes.
- Refund-on-any-failure, temp sweeper, 720p rollback env (earlier audit).

## Smoke-test knobs (in priority order, if the phone test flags something)

- **Soft/grainy** → unsharp in COLOR_GRADE (runway-job.mjs): 0.28 luma now;
  raise to ~0.35 if soft, drop toward 0.15 if crispy.
- **Motion feels static** → VEO_MOTION_PROMPTS travel % ("about 6%" was
  tuned for 6s clips; ~4.5% effective at 4s buckets). Raise cautiously —
  more travel = more morph risk.
- **Cuts feel fast (luxury)** → STYLE_TARGET_CADENCE luxury 2.6 → 3.0.

## Deploy order

1. Push (worker + api deploy together — the stitch/mixer/plan fixes are
   one coherent set).
2. Run migrations 24 + 25 in Supabase.
3. Then smoke test: Sedona photos, all 4 styles + hero, on a phone.
