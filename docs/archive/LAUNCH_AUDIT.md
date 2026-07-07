# Launch audit — 2026-07-01

Full-repo pass ahead of launch: every api/ route, render worker + queue, billing
lifecycle, migrations/RLS, webapp, static marketing site, config. Everything
fixable was fixed in this commit; the rest is an explicit verify list below.

## Critical — fixed

1. **Anonymous Veo renders** (`api/render.js`). The no-JWT path only blocked
   engine `"runway"` — written before the engine rename, so unauthenticated
   POSTs with `"veo"` (production engine) or `"depth"` rendered real fal.ai
   money with no account. Now: anonymous = remotion only.
2. **`curate-photos` had no auth** — anyone with the URL could burn OpenAI
   Vision spend (rate limit was per-IP, in-memory). Now requires a signed-in
   user, matching classify-image. (Webapp already sent the JWT — no UX change.)
3. **Self-serve quota reset** (`api/stripe-webhook.js`). Every
   `subscription.updated` unconditionally reset `videos_used_this_month: 0` —
   and Stripe fires that on cancel-at-period-end toggles, plan changes, and
   event replays. A subscriber could refill quota by toggling cancellation in
   the billing portal. Now: usage resets only when `current_period_start`
   actually advances (renewals still reset correctly).
4. **SS-4 (EIN application, carries SSN) was tracked in git.** Untracked +
   `.gitignore` now blocks `SS-4*` and stray root PDFs (docs/ PDFs still
   allowed). File remains on disk. NOTE: it still exists in old git history —
   fine while the repo is private; run `git filter-repo` before ever sharing.
5. **Checkout SyntaxError** (fixed in the q7 commit, listed for completeness):
   duplicate `const envName` in `resolvePriceForTier` 500'd every checkout.

## High — fixed

6. **Refund gap** (`render-worker/server.mjs`). Credits were refunded ONLY on
   `VEO_SCENE_FAILED` — stitch, voice-mix, upload, and 18-min-timeout failures
   charged the user with no refund. Now every failure refunds via the
   ledger-driven RPC (reverses exactly what the job consumed; idempotent;
   no-ops for anonymous renders). Known edge: a hard-timeout refund followed by
   the zombie render completing = free video. Rare + cheap; monitor logs.
7. **Worker disk leak** (`render-worker/src/runway-job.mjs`). Each job wrote
   100-500MB under /tmp and nothing ever deleted it — the worker disk filled
   until renders failed. Now: temp dir removed on successful upload, plus a
   2h stale-dir sweeper on every job start that reaps crashed/failed/zombie
   job dirs (covers `estatemotion-*` and `veo-smoke-*`).
8. **Marketing site still sold q6 prices.** index.html, start.html, both SEO
   pages, reel-e-alternative, compare page: $49→$69, $99→$149, "2 months
   free"→"up to 45%". Annual $490/$990 and payg $39 untouched (correct).

## Medium — fixed

9. **Security headers** (vercel.json): added `X-Frame-Options: SAMEORIGIN`,
   HSTS, and `Permissions-Policy` (camera/geo/payment blocked; microphone left
   open — voice cloning records via getUserMedia). CSP deferred: needs an
   inline-script inventory on the landing page, not a pre-launch rush job.

## Verified clean

Webhook signature check (HMAC + timingSafeEqual) · credit grants DB-idempotent
per session · delete-account (JWT + email confirmation + cascade) ·
export-account, library, organization, regenerate-scene all JWT-scoped ·
admin-cost-summary gated by ADMIN_USER_IDS · cron gated by CRON_SECRET ·
worker /test/veo gated by worker secret · RLS enabled on every table in
migrations · no secrets in repo · no TODO/FIXME debt · tsc + node --check green.

## Verify before launch (can't be fixed from the repo)

- [ ] **RENDER_WORKER_SECRET set on Render** — worker auth FAILS OPEN without
      it. Check `<worker-url>/version` reports `authConfigured: true`.
- [ ] STRIPE_WEBHOOK_SECRET set on Vercel (webhook 503s without it — good).
- [ ] q7 Stripe steps (docs/PRICING_Q7.md): new $69/$149 monthly prices,
      env vars incl. both YEARLY ids, archive old prices, redeploy.
- [ ] Run migrations 24 in Supabase SQL editor.
- [ ] **brand_kits RLS** — table predates the migration files; confirm RLS +
      owner policy in Supabase dashboard (it holds names/headshots/brokerage).
- [ ] ADMIN_USER_IDS set (else admin-cost-summary is admin-less, returns 403
      for everyone — safe but useless).
- [ ] End-to-end test purchase: Pro monthly, Pro annual, payg, one $12 overage.
- [ ] v31 phone smoke test across 4 styles (grain knob: unsharp 0.28 in
      runway-job.mjs COLOR_GRADE).
- [ ] Turnstile on signup verified in prod.
- [ ] FAL_MAX_CONCURRENCY sized to fal plan ÷ worker instances.

## Accepted for launch (revisit later)

- In-memory rate limiter + webhook dedupe (per-instance). Credit grants are
  DB-idempotent and the usage-reset replay is now period-gated, so the sharp
  edges are gone; move to Upstash/`stripe_events` table when there's traffic.
- Email still on @estatemotion.ai pending Google Workspace on vistalia.ai.
- `og-image.jpg` + landing footer still reference estatemotion.ai mailto —
  works today, migrate with the Workspace move.
- Old business docs in repo root (pricing xlsx, deck, memos) — messy, private,
  harmless. Move to a drive folder when convenient.
