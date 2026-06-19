# EstateMotion — Edit Studio + per-scene re-render (implementation plan)

Goal (Troy, June 19): after a render completes, open a separate **Edit Studio**
page. If a scene came out wrong, re-render just that scene; after 2 failed
re-render attempts, offer a **Ken Burns** fallback for that scene. The Veo prompt
on a re-render should be **much less aggressive** than the first pass.

## What already exists (the head start)
- **Per-scene clips are already persisted.** `runway-job.mjs` calls
  `uploadPerSceneClips(...)` — each scene clip is uploaded to the same Supabase
  folder as the master "for regenerate-scene support… single-scene regen is the
  production-grade fix." So the source clips for a finished render are already in
  storage with predictable URLs.
- **Ken Burns fallback already exists** in the worker (`guardDecision.useKenBurns`
  + a Ken-Burns-style clip generator from the same photo). We can reuse it per-scene.
- **Constrained / less-aggressive prompt mode already exists** (`CONSTRAINED_PROMPTS`,
  `generateVeoSceneClip(..., { constrained })`). The "softer re-render prompt" is
  largely this path, tuned down further.
- **Routing is a simple screen state machine** (`screen` in the store:
  auth/dashboard/project/brokerage/settings) — adding `editStudio` is trivial.

## The gaps to fill
1. **Surface per-scene clip URLs to the frontend.** Today the render result returns
   `sceneClips` with only `{photoId, durationSec, runwayTaskId}` — *no clip URL*.
   The URLs live in `scenesMeta` (uploadPerSceneClips) which only goes to the audit
   log. Fix: include each scene's `clipUrl`, `photoId`, `room`, `prompt`, and a
   stable `sceneIndex` in the render result, and persist them on the render record
   so the Edit Studio can list and preview each scene.
2. **A single-scene re-render path.** New backend endpoint + worker job type that:
   regenerates ONE scene clip (softer prompt), swaps it into the stored clip set,
   re-stitches the final video (+ re-applies narration/music), and re-uploads —
   without re-rendering the other scenes (cheap + fast).
3. **Per-scene attempt tracking** (so we can offer Ken Burns after 2 Veo attempts).
4. **The Edit Studio page** (new screen).

## Proposed build

### Backend — `api/regenerate-scene.js`
- Auth + rate limit (same pattern as clone-voice).
- Body: `{ jobId, sceneIndex, mode }` where `mode ∈ {"veo_soft","ken_burns"}`.
- Credit policy: **see decision below.**
- Forwards to the Render worker (same `RENDER_WEBHOOK_SECRET`) as a new job type
  `regenerate-scene`, returns a job id the frontend polls (reuse pollRender shape).

### Worker — single-scene regen
- Load the existing render's clip set + manifest from storage (clips are already there).
- `mode = veo_soft`: regenerate that one scene with a **softened prompt** (see below).
- `mode = ken_burns`: skip Veo entirely, generate the Ken Burns clip from the photo.
- Re-run `stitchClipsAndOverlays` + narration/music over the swapped clip set →
  new master + variants, re-upload, return new URLs.
- Increment + return that scene's `veoAttempts`.

### The softer re-render prompt
First-pass prompts push cinematic motion (which is what over-cooks a scene). On
re-render, drop to a **calm, locked-down** prompt: minimal camera move (slow push
or static), no people/animals/text generation, "stay faithful to the photo, do not
invent or alter architecture, furniture, or fixtures." This is the existing
`constrained` prompt, trimmed further — explicitly *less motion, more fidelity*.
Each retry gets progressively calmer; attempt 2 ≈ near-static.

### Ken Burns fallback rule
- Show a **"Use Ken Burns instead"** button on a scene the moment it has **2 Veo
  attempts** (recommended: offer it, don't auto-apply — the agent decides). Ken
  Burns can't hallucinate (it only pans/zooms the real photo), so it's the
  guaranteed-safe escape hatch.

### Frontend — Edit Studio page (`screen === "editStudio"`)
- Reached from the finished-render reveal via an **"Edit / fix scenes →"** button.
- Grid of scene cards (one per photo): thumbnail/clip preview, room label, status,
  and actions: **Re-render (softer)**, **Use Ken Burns** (appears after 2 attempts),
  attempt counter. Re-render shows inline progress; on success the card's clip and
  the master video swap in place.
- "Back to project" + "Download final" actions.

## Decisions (CONFIRMED, June 19)
1. **Re-renders are ALWAYS FREE** (no credit charge). Add a per-scene attempt
   rate-limit instead, to cap runaway Veo spend without charging the user.
2. **Ken Burns AUTO-APPLIES** after the 2nd failed Veo re-render attempt — no extra
   click. The scene silently falls back to the guaranteed-safe Ken Burns clip.

## STATUS
- **P1 DONE** (commit pending): per-scene metadata (`scenes[]` with durable clipUrl,
  photoUrl, room, prompt, storagePath) now surfaces on the render result → flows
  through `/api/render` status → `pollRender` → `RenderJobStatus.scenes`. Type
  `SceneClipMeta` added.
- **P1 REMAINING for P2 to work:** the **manifest is not persisted** to storage by
  jobId (confirmed — only local runs write manifest.json). The regen worker needs it
  to re-stitch. P2 must upload `${ownerId}/runway/${jobId}/manifest.json` alongside
  the per-scene clips.
- **P2/P3/P4 NEXT** — the worker single-scene regen + re-stitch is the one piece that
  MUST be validated with a live test render before trusting it on the production path
  (this project has been burned by untested render-worker changes). Built carefully,
  not rushed.

## Phasing (so it ships safely)
- **P1:** surface per-scene clip URLs on the render record (small, unblocks everything).
- **P2:** `regenerate-scene` endpoint + worker single-scene regen (veo_soft) + re-stitch.
- **P3:** Edit Studio page wired to P2.
- **P4:** Ken Burns mode + attempt tracking + the progressive softening.

Each phase is independently testable. P2 is the riskiest (touches the production
worker + re-stitch) and is where we go slow.
