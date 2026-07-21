# EstateMotion — Launch Readiness Audit

June 2026. Full-site sweep against the v26 reality (Veo 3.1 production engine, launch pricing, one-off credit packs). Ordered by severity. The backend is in good shape; **the gaps are almost all in user-facing surfaces that still describe the retired v25 product.**

## What's solid (verified)

- Render pipeline: Veo 3.1 Fast live in production (`engines: [remotion, veo]`, `veoProduction: true`), constrained-prompt guard on risky rooms, retry-once + typed abort.
- Payments backend: subscriptions (launch/pro/studio) + one-off credits (single/pack5) wired; webhook grants credits idempotently; render gate consumes quota then credits.
- Security: auth + rate limits on cost endpoints, webhook replay/idempotency, worker auth.
- Legal: privacy.html + terms.html exist.
- Conversion landing page (start.html) built for the ad campaign.

## P0 — Blocks launch (customer sees the wrong product)

**1. In-app create screen (`ProjectScreen.tsx`) still runs the entire v25 model.** A user who signs up from the ad lands here and sees:
- An **EngineToggle** ("Quick Reel" vs "Cinematic AI") — there's only one engine now (Veo). The toggle is meaningless and confusing.
- A **"Render Safety" / hallucination-protection picker** — repurposed away in v26; shouldn't be a user control.
- Hardcoded copy referencing **Runway, Ken Burns, $79/$149/$299, Quick Reel, Cinematic AI 4K**.
This is the single biggest blocker — the product the ad sells and the product the user opens don't match. Needs: strip EngineToggle + safety picker, remove tier/engine copy, present a single "Generate cinematic video" flow. (~Deferred Phase 3 UI strip; this is where it lands.)

**2. Homepage (`index.html`) shows retired pricing.** $79 Quick Reel in the pricing section, structured-data `Offer` markup at $79 (Google will index it), the "$850 → $79" proof stat, and FAQ copy referencing Quick Reel/Cinematic AI render times. Anyone who visits the root domain — including from organic, referrals, or an ad that points there instead of start.html — sees prices that no longer exist. Needs the v26 lineup ($99/$249/$499 + per-video) and the structured data updated.

**3. In-app paywall after the free video doesn't exist.** This is the revenue mechanism and it's not wired. After a trial user spends their 1 free render, nothing presents the $100 single / $375 pack offer inside the app. `ProjectScreen` line ~2235 handles `upgradeRequired` but routes to the (subscription-only) PricingModal. Needs: a paywall that offers single/pack5 (the cash path) prominently, subscriptions secondary — mirroring start.html.

**4. `api/usage.js` doesn't return `render_credits`.** The app can't show a credit balance, and a credit-only user (trial spent, bought a pack) may be shown as out-of-quota even though they can render. Needs to pass through `render_credits` and the credit-aware `can_render` from the updated `get_user_tier_state`.

## P1 — Operational, must do before traffic (no code, your hands)

5. **Apply migrations 12, 13, 14 in Supabase** (SQL Editor). Until 14 runs, credit purchases grant nothing and the gate has no `render_credits` column → every paid render 500s.
6. **Stripe:** confirm each subscription product has a `default_price` set (checkout reads it). One-off packs need no setup (inline pricing).
7. **start.html placeholders:** real `PIXEL_ID`, hosted video URL + poster (host `marketing/ad-creatives/before-after-real-output.mp4` on Supabase Storage), and confirm the `estatemotion.ai/app/?ref=ad&offer=...` route lands on signup.
8. **Rotate the worker secret** (Render + Vercel, same value) — it was pasted in chat.
9. **Meta Pixel + CAPI** server-side Purchase event from the webhook (currently client-side Lead only) — without it Meta optimizes blind.
10. **fal.ai balance auto-recharge + alert** — a viral ad with a dry fal account is a refund machine.

## P2 — Post-launch, not blockers

- Auto-detection of bad scenes (frame-vs-source compare) — the durable answer to hallucination; v2.
- Overage billing for subscriptions (needs Stripe metered billing).
- Brokerage/photographer resale flow (manual for now).
- ProjectScreen is 3,100 lines — split when touched for the P0 strip.

## Recommended sequence to live

1. Migrations 12/13/14 applied (P1 #5) — unblocks everything else.
2. P0 #4 usage.js (small) + P0 #3 in-app paywall — so the free→paid moment works.
3. P0 #1 ProjectScreen strip + P0 #2 homepage pricing — so the product is coherent.
4. P1 operational (pixel, video host, secret, fal alert).
5. Soft test: one real signup → free render → buy a pack → confirm credit decrements. Then open the ad spend.

The honest read: you're ~2–3 focused build sessions from launch-ready, and all of it is making the storefront match the engine — the engine itself is done.
