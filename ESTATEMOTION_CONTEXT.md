# EstateMotion — Context Handoff for Fable 5

Generated June 9, 2026 by Troy. This is the authoritative project context. Last working session was on Cowork with Opus 4.7.

## Who I am

- Troy Massey — founder and solo developer of EstateMotion
- Email: tcmassey@gmail.com
- Mac (Cowork desktop app), zsh, VS Code
- Prefer: terse, decisive responses with prose over lists where possible; concrete file paths and commit hashes; honest tradeoff calls over hedging; you can ask one clarifying question via AskUserQuestion before big work, otherwise just execute
- I push code myself (`git push origin main`); you don't have push access. You can commit locally via the workspace bash tool.

## What EstateMotion is

A real estate SaaS that turns an agent's listing photos into a cinematic 30-second 9:16 vertical video. Agents upload 8-24 photos, pick a style, optionally pick a music track + opt into narration. The render worker stitches an AI-image-to-video pipeline (currently Runway Gen-4 Turbo) plus crossfades, background music, ElevenLabs voiceover, branded outro card, and an agent-headshot watermark. Output is a single 1080p mp4 ready for Reels / TikTok / Shorts. Pre-launch, paid tier model.

## Stack

- Web frontend: Vite + React + TypeScript, deployed on Vercel. Path: `webapp/`
- API layer: Vercel serverless functions in `api/`. Includes auth helpers, library CRUD, OpenAI edit-plan, Stripe checkout, render dispatch, account deletion, etc.
- Render worker: Node 20 + ffmpeg + Remotion, Dockerized on Render.com (Pro 4 GB plan). Path: `render-worker/`
- Database/Auth/Storage: Supabase (Postgres + Auth + Storage). RLS-protected.
- Payments: Stripe (Checkout + Billing Portal + webhooks)
- Email: Resend for transactional + lifecycle
- Captcha: hCaptcha on signup
- 2FA: TOTP via Supabase
- Sentry + Plausible for ops/analytics

## Where we ARE right now (the critical state)

We just committed v25 Phase 1b: `ba52624` (pivot from GCP-direct Veo to fal.ai-routed Veo). Production routing is UNCHANGED — Runway Gen-4 Turbo is still the engine all production renders use. The fal.ai-Veo plumbing exists ONLY as a standalone smoke-test endpoint `POST /test/veo` on the render worker.

Immediate next user action (Troy):

1. Push the latest commits: `cd ~/Documents/EstateMotion && git push origin main`
2. Sign up at `https://fal.ai`, get an API key (starts with `fal_`)
3. Add ONE env var on the Render worker: `FAL_KEY = fal_...`
4. Wait for redeploy (~2 min)
5. Verify at `https://<worker-name>.onrender.com/version` — under the `veo` block, `keyConfigured: true`
6. Run the smoke test:

```bash
WORKER_URL=https://<worker-name>.onrender.com \
  node ~/Documents/EstateMotion/render-worker/test-veo.mjs \
    --image "https://<supabase>/.../kitchen.jpg" \
    --prompt "Slow cinematic dolly toward the kitchen island. Subtle 6% zoom. Preserve all cabinetry, faucet, and appliance hardware exactly as shown." \
    --duration 6s
```

7. Open the resulting clip URL. That clip is the moment-of-truth — if Veo preserves hardware better than Runway, we proceed to Phase 2.

Bake-off bonus: the test runner accepts `--model fal-ai/luma-dream-machine/ray-2/image-to-video` (or Kling, or Seedance) for one-line model swaps. Lets us compare ~4 models on the same image for ~$3 total.

## Why we pivoted (the saga, condensed)

### The problem

Runway Gen-4 Turbo hallucinations on real estate content. Warps cabinetry, fixtures, ceiling fans, blinds, mirrors. Catastrophic enough that one bad scene can lose a listing. Tried 4 rounds of prompt iteration (v22 → v23 → v23.3 → v24); the model has a ceiling we can't prompt-engineer past.

### The failed escape: depth engine

v23-era spike to build a 2.5D parallax engine using Depth Anything v2 + Three.js. Worked locally; died on Render.com because headless WebGL on a Render container hit a cascade of incompatibilities (xvfb, Mesa, WebGL2 methods missing from `gl`). Abandoned after a week. Code preserved in repo, not routed by `server.mjs`. Files: `render-worker/src/depth-job.mjs`, `depth-renderer.mjs`, `replicate-client.mjs`.

### The unsatisfactory middle: Hallucination Guard

v24-era. Per-scene risk scoring: kitchen always falls back to Ken Burns, bathroom/other rooms only at very high risk. v24.5 (commit `b037004`) tuned to "kitchens only" — kept fallback rate ~1 scene per 8-photo listing. The fallback (Ken Burns zoompan) looks amateur compared to AI motion. So we had a quality engine that failed and a safe engine that was ugly.

### The decision

On June 9, decided to swap Runway entirely for a better model AND kill Ken Burns. Researched the i2v field via web search:

- Runway Gen-4.5 — no longer in top 10 since May 2026
- Veo 3.1 (Google) — leaderboard leader, specifically called out for "architectural rendering" use case
- Luma Ray 3.14 — consensus best i2v overall
- Kling 2.6 / 3.0 — strong on physical objects
- Seedance 2.0 Pro Fast — cheapest viable option (~$0.022/sec at 2K)
- Sora 2 — best raw quality but API sunsets Sept 24, 2026 (non-starter)
- Hailuo 02 — quality lags Kling/Veo on detailed scenes (skip)

Picked Veo 3.1 Fast as primary (architectural-rendering specialist + Google reliability + $300 free credit for testing).

### Why fal.ai instead of GCP direct

Tried Vertex AI direct first (v25 Phase 1, commit `0ec9d22`). Got blocked by Google's Secure-by-Default org policy `iam.disableServiceAccountKeyCreation` which forbids SA key downloads on free-tier accounts. Override requires `roles/orgpolicy.policyAdmin` on the ORG, which Troy doesn't have. Rather than fight, pivoted to fal.ai (v25 Phase 1b, commit `ba52624`):

- Single `FAL_KEY` env var instead of 4 GCP env vars
- Accepts Supabase image URLs directly (no GCS upload)
- Returns plain HTTPS mp4 URLs (no GCS auth dance)
- ~20% pricing markup over direct Google API ($0.18/sec instead of $0.15/sec)
- Bonus: lets us A/B test Veo, Luma, Kling, Seedance with one env-var swap

## Locked pricing decisions (asked via AskUserQuestion)

For Phase 3 of the migration (still pending):

- Main tier: rename + reprice from "Cinematic AI $149/mo, 25 renders" → $249/mo, 25 renders. COGS at fal.ai's ~$0.18/sec × 30s × 25 renders ≈ $135/mo, leaves ~46% margin.
- Quick Reel tier: KILL IT. Currently $79/mo Ken Burns. Existing customers get free trial of new tier + email comms + option to upgrade or cancel.
- Failure mode: when Veo fails (timeout / content rejection / quota hit), auto-retry once, then refund the render credit. No partial videos shipped, clean UX, requires `render_credit_refunds` Postgres helper.

## Open work (still pending — Phases 2 + 3)

### Phase 2 (v25.1) — Dispatcher swap

- Add a real "veo" path in `render-worker/server.mjs` dispatchRender
- Use the per-scene `generateVeoClip` primitive from `src/veo-job.mjs` in a stitch loop (parallels what `renderRunwayJob` does today)
- Update stitch + voice-mixer to handle Veo's 6s clips (Runway emits 5s by default)
- Implement auto-retry-once + refund-credit
- Strip the Hallucination Guard codepath — no more KB fallback. Worker engines list becomes just `["veo"]`
- Phase out runway-job from active routing (preserve code on disk like we did with depth)
- Audit log: store provider/model/requestId per scene
- Per-scene regenerate path needs to use Veo not Runway

### Phase 3 (v25.2) — Pricing + UI

- New Stripe price IDs for $249 main tier
- Migration plan for old `quick_reel` users (email + auto-trial of new tier)
- Strip Hallucination Guard / engine toggle from ProjectScreen UI (only one engine now)
- Strip Quick Reel from PricingModal + dashboard
- Strip per-scene "Replace KB" button (only AI regen now)
- Update PlanStatusBanner / OG meta / render-status labels
- Bump PROMPT_VERSION to v25

## Recent commits worth knowing

```
ba52624  v25 Phase 1b: pivot Veo worker from GCP direct to fal.ai
0ec9d22  v25 Phase 1: Veo 3.1 Fast worker module + standalone test (GCP version, superseded)
b037004  v24.5: only-kitchens fallback + library video fit + delete entry
cdc0b2a  v24.4: bulletproof voice trim + UI compliance sweep
3ef8a6c  v24.3: voice stutter + sync + KB threshold + Runway prompt revert
250bb86  HOTFIX: add skipMusic + musicBedLevel to RenderManifest type
7d080cc  v24.2: cinematic Ken Burns easing + voice/music toggles + music volume slider
e90c93f  v24.1: louder voice over music, more scenes per 30s, less aggressive Ken Burns fallback
```

## File layout (key paths)

```
EstateMotion/
├── api/                          (Vercel serverless functions)
│   ├── library.js                (GET/DELETE — v24.5 added delete)
│   ├── render.js                 (proxies POST /render to the worker)
│   ├── regenerate-scene.js
│   ├── create-edit-plan.js       (OpenAI prompt generator, PROMPT_VERSION = v24.5)
│   ├── create-checkout-session.js
│   ├── stripe-webhook.js
│   ├── usage.js
│   ├── delete-account.js
│   └── _lib/ (rate-limit, email, email-templates)
│
├── webapp/                       (Vite + React + TS, deployed on Vercel)
│   └── src/
│       ├── screens/ProjectScreen.tsx       (the main create-a-video flow)
│       ├── screens/DashboardScreen.tsx     (library view)
│       ├── screens/LibraryDetailModal.tsx  (single video modal — v24.5 added delete + fixed video fit)
│       ├── components/PricingModal.tsx     (Quick Reel / Cinematic AI / Cinematic AI Pro tiers)
│       ├── components/PlanStatusBanner.tsx
│       ├── lib/api.ts                      (typed client; deleteLibraryEntry added in v24.5)
│       ├── lib/store.ts                    (Zustand store with persist)
│       └── lib/types.ts                    (RenderManifest, LibraryEntry, etc.)
│
├── render-worker/                (Dockerized Node worker on Render.com Pro 4GB)
│   ├── server.mjs                (http server, dispatchRender(), /version, /test/veo)
│   ├── Dockerfile                (node:20-bookworm-slim + ffmpeg + Chromium libs)
│   ├── package.json              (deps: remotion, supabase-js, @fal-ai/client, react/react-dom)
│   ├── test-veo.mjs              (CLI smoke-test runner for fal.ai)
│   └── src/
│       ├── runway-job.mjs        (PRODUCTION — Runway Gen-4 Turbo pipeline)
│       ├── render-job.mjs        (Ken Burns / Remotion path — being phased out)
│       ├── regenerate-job.mjs    (per-scene regen orchestrator)
│       ├── veo-job.mjs           (NEW v25.1b — fal.ai-routed Veo, smoke-test only)
│       ├── voice-mixer.mjs       (ElevenLabs + ffmpeg amix; v24.4 added bounded apad)
│       ├── stitch.mjs            (ffmpeg stitch pipeline)
│       ├── audit-log.mjs         (writes render_audit_log Supabase rows)
│       └── depth-* + replicate-client.mjs  (abandoned depth engine, unrouted)
│
├── supabase/migrations/          (SQL migrations including brokerage + render_jobs queue)
├── docs/
├── scripts/
├── showcase/                     (landing page)
└── marketing/
```

## Things you should NOT do

- Don't push code. Troy pushes manually. You can `git commit` locally but stop there.
- Don't restore the depth engine. It's intentionally unrouted. Files preserved for future, but it died on Render's headless WebGL and isn't coming back.
- Don't suggest more Runway prompt iterations. We've spent four rounds. The model has a ceiling. We're swapping engines.
- Don't enable a public GitHub repo without asking. Repo `tcmassey2/estatemotion` is currently public — Troy was going to flip it private but it might still be public. Verify before assuming.
- Don't recommend Sora 2 or Hailuo 02. Sora 2 API sunsets Sept 2026; Hailuo quality lags on detailed scenes.

## Things you SHOULD know about Troy's preferences

- Works in long sessions (days, multiple compaction cycles)
- Does real work between sessions — assume the codebase may have drifted; check git status before assuming
- Values honest tradeoff articulation — "Option A gives X but costs Y; Option B is opposite" beats "let me think about this"
- Ask one clarifying question via AskUserQuestion before big architectural moves, not five
- Tell him what NOT to do alongside what to do
- He pushes code; you don't have remote-push access. Always tell him the push command at the end of a commit.
- File creation: use real Edit/Write tools, not chat output. Files on disk.
- Use the TaskList tool — it renders as a widget in Cowork and helps track multi-phase work

## What to start doing immediately

Once Troy has signed up for fal.ai, set `FAL_KEY` in Render, and confirmed `/version` shows `keyConfigured: true`, the next concrete deliverable is running the smoke test on a real failed-render photo from the rental listing that motivated this whole swap. He should report back with the clip URL. If Veo preserves the hardware → proceed to Phase 2 (dispatcher swap). If not → bake-off Luma Ray 3.14 / Kling 2.6 / Seedance 2.0 Pro Fast using the same `--model` flag.

Phases 2 and 3 are scoped in the tasks list (#131 and #132) but not started.

## Env vars that matter (current production state)

On Vercel (api/):

- SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
- OPENAI_API_KEY (for edit-plan generation)
- STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_QUICK_REEL, STRIPE_PRICE_CINEMATIC_AI, STRIPE_PRICE_CINEMATIC_4K
- HCAPTCHA_SECRET
- RESEND_API_KEY
- WORKER_URL (URL of the Render worker), WORKER_AUTH_TOKEN

On Render worker (render-worker/):

- SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_GENERATED_VIDEOS_BUCKET (default "generated-videos")
- RUNWAY_API_KEY (still active — production engine)
- ELEVENLABS_API_KEY (for narration synthesis)
- OPENAI_API_KEY (for edit-plan when worker rebuilds plan)
- REPLICATE_API_TOKEN (was for depth engine, no longer used)
- WORKER_AUTH_TOKEN
- FAL_KEY (NEW — being added now for the Veo migration)
- Optional: FAL_VIDEO_MODEL, FAL_RESOLUTION, FAL_DURATION, FAL_GENERATE_AUDIO, FAL_SAFETY

## How to know the worker is healthy

```
GET https://<worker>.onrender.com/version
```

Returns JSON with `version`, `engines`, `experimentalEngines`, `veo` config block, and `endpoints` list. Current expected values after v25 Phase 1b:

- `version: "2026.06.09-v25.0-phase1b"`
- `engines: ["remotion", "runway"]` (production unchanged)
- `experimentalEngines: ["veo"]`
- `veo.provider: "fal.ai"`
- `veo.model: "fal-ai/veo3/fast/image-to-video"`
- `veo.keyConfigured: true` (once FAL_KEY is set)
