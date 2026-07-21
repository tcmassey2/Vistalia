# EstateMotion Production Audit — v26 Sweep

June 9, 2026. Findings from a full read of api/, render-worker/, and webapp/. Ordered by severity. Items marked [FIXED v26.0] are addressed in the hardening commits accompanying this doc; the rest are queued.

## P0 — Credit-burn and auth holes

**1. Six unauthenticated cost-bearing API endpoints.** `create-edit-plan` (OpenAI Vision, the most expensive call in the product), `synthesize-narration` (ElevenLabs), `clone-voice` (ElevenLabs IVC — also an impersonation-abuse vector), `classify-image` (OpenAI), `lookup-property` (RentCast) had no auth and no rate limit. Anyone with the URL could drain API balances. [FIXED v26.0] — all five now require a valid Supabase JWT (soft-pass when Supabase env is absent, preserving mock/dev mode) plus per-user rate limits. `voices.js` is a static catalog, left public intentionally.

**2. Render worker auth is fail-open.** `authorized()` in `server.mjs` returns `true` when `RENDER_WORKER_SECRET`/`RENDER_WEBHOOK_SECRET` is unset — silent. If the env var were ever missing or misnamed on Render, anyone could submit Runway renders directly. [FIXED v26.0] — boot now logs a prominent warning when no secret is set, and `/version` reports `authConfigured` so a missing secret is visible at a glance. **Troy: verify `RENDER_WEBHOOK_SECRET` is actually set on the Render worker — the context handoff says `WORKER_AUTH_TOKEN`, but the code reads `RENDER_WORKER_SECRET || RENDER_WEBHOOK_SECRET`. If Render only has `WORKER_AUTH_TOKEN`, worker auth is currently OFF.**

**3. `/test/veo` is unauthenticated.** "Gated by knowing the worker URL" is not a gate — the URL appears in client-visible network traffic. Once FAL_KEY is set, anyone could burn fal.ai balance at ~$1/clip. [FIXED v26.0] — now behind the same bearer secret; `test-veo.mjs` sends it from a `WORKER_SECRET` env var.

## P1 — Reliability and payment integrity

**4. Stripe webhook lacks replay protection and idempotency.** Signature verification didn't check the timestamp (replay window = forever) and no event-ID dedupe (Stripe retries can double-apply subscription changes; mostly idempotent PATCHes today, but `videos_used_this_month: 0` reset on `subscription.updated` makes a replayed event a quota-reset exploit). [FIXED v26.0] — 5-minute timestamp tolerance + in-memory event-ID dedupe. Durable dedupe (a `stripe_events` table) queued for the next Supabase migration; in-memory is sufficient for single-region Vercel today.

**5. Worker serves rendered mp4s by reading whole files into memory.** `serveRenderAsset` does `fs.readFile` on files that can exceed 100 MB, on a 4 GB box that also runs ffmpeg. Concurrent downloads + a render = OOM risk. [FIXED v26.0] — streams via `fs.createReadStream`.

**6. Worker `jobs`/`jobAssets` Maps grow forever.** Every render/regen/smoke-test leaves an entry until restart. Slow leak; also keeps temp-file paths alive past usefulness. [FIXED v26.0] — periodic prune of terminal jobs older than 2 h, cap 500 entries.

**7. Job IDs are guessable** (`slug(title)-Date.now()`), and `GET /render/status/:jobId` + `/render/assets/` are unauthenticated. Low practical risk (IDs expire from memory) but enumeration could leak finished videos. Queued: random suffix on job IDs — cheap fix, lands with Phase 2 dispatcher work to avoid churn.

## P2 — Hygiene

**8. CORS is `Access-Control-Allow-Origin: *` on every endpoint** (api/ and worker). Bearer-token auth means CSRF is not in play, but wildcard CORS plus unauthenticated endpoints compounded #1. Queued: `ALLOWED_ORIGINS` env on Vercel once the production domain list is fixed. Not changed yet — don't want to break Vercel preview deploys mid-bake-off.

**9. Tier guard fails open** when the `get_user_tier_state` RPC errors (`render.js`). Deliberate availability-over-enforcement tradeoff; acceptable, but it should be a metric, not just a console.warn. Queued with observability work.

**10. Rate limiter is per-instance in-memory.** Documented and acceptable at launch scale; Upstash/Redis when Vercel concurrency grows.

**11. Stale tier copy in `render.js`** — engine-gate error message still says "Cinematic AI ($149) or Cinematic AI 4K ($299)". Goes away in Phase 3 repricing; left alone to avoid double-touching.

## Webapp

State on inspection was better than the first grep suggested: DashboardScreen already has skeleton loading, error, migration-hint, and a polished empty state; modals close on Escape; ErrorBoundary wraps the app root. Fixed in v26.0: `role="dialog"`/`aria-modal` on LibraryDetailModal + PricingModal, `role="status" aria-live="polite"` on the render-progress phase panel.

Queued:

- Focus management in modals (trap + return-focus-on-close) — semantics landed, focus wiring didn't; needs a small useFocusTrap hook.
- `ProjectScreen.tsx` is 3,100 lines — split before the Phase 3 UI strip makes it worse. Suggest extracting RenderProgress, SceneList, UploadGrid. Do it as part of Phase 3 since that work touches the same regions.
- Stale tier copy ("Quick Reel" / "$149") throughout PricingModal and engine labels — Phase 3 territory, untouched.

## Explicitly NOT touched (reserved for v25 Phase 2)

Engine dispatch (`dispatchRender`), `runway-job.mjs`, `render-job.mjs`, Hallucination Guard, regenerate orchestration, stitch/voice-mixer pipelines. Hardening these now would be demolished by the Veo swap.
