# EstateMotion — Launch Plan (week of June 22)

Anchored: today **Wed Jun 17, 2026**. EIN faxed, ETA **~Tue Jun 23**.
Target paid go-live: **Tue–Wed Jun 23–24.** Principle: the EIN gates only
Stripe (getting paid). Everything else gets finished this week so launch day
is just flipping switches.

## The one dependency
EIN → unlock Stripe → take payments. Nothing else in the stack needs it.
So we build/verify the entire product + funnel now, hold only the paid
switch for the EIN.

---

## TRACK A — this week, EIN-independent (do now)

### A1. Ship the code (Wed Jun 17 / Thu Jun 18)  — owner: Troy pushes, Claude prepped
- [ ] Push all commits via GitHub Desktop (through `e84dcc3`). Vercel + Render auto-deploy.
- [ ] Confirm Vercel build succeeds (the `veo` type fix is in — it will).
- [ ] Confirm worker `/version` shows `2026.06.09-v26.x`, `engines:[remotion,veo]`.

### A2. Apply database migrations (Thu Jun 18) — owner: Troy (Supabase SQL editor)
- [ ] Run migrations **12 → 13 → 14 → 15 in order** (Claude will hand you one
      consolidated paste-ready script). Until these run, credit purchases
      grant nothing and paid renders error.
- [ ] Spot-check: `select tier, available_engines from tier_plans;` shows veo.

### A3. Landing page + tracking live (Thu–Fri) — owner: Troy values, Claude wires
- [ ] Host `marketing/ad-creatives/before-after-real-output.mp4` on Supabase
      Storage; paste the URL + a poster frame into `start.html`.
- [ ] Drop in the real Meta **Pixel ID** (start.html + app).
- [ ] Publish `start.html` at the campaign URL; confirm CTAs deep-link to signup.

### A4. Secrets + safety (Fri) — owner: Troy
- [ ] Rotate the worker secret (new value in Render **and** Vercel, same sitting).
- [ ] fal.ai: set balance auto-recharge + low-balance alert (a live ad with a
      dry fal account is a refund machine).

### A5. Render-path smoke test (Fri) — owner: Claude + Troy
- [ ] One real listing through the app end-to-end: upload → render (Veo) →
      review → finished MP4 in library. Watch a risky room (kitchen/pool).
- [ ] Confirm usage counter ticks and the paywall opens when the free video
      is spent. (Payment itself waits on Stripe — A-track stops here.)

### A6. Ad campaign built but PAUSED (Fri) — owner: Troy
- [ ] Meta: campaign created, ASC, optimize for **Lead (trial signup)**,
      $75/day prospecting + $20/day retargeting + $5 buffer. Creatives loaded
      (the UGC + before/after cuts). **Leave it paused.**
- [ ] Google: search-only set, exact-intent terms, $30/day. Paused.

### A7. Soft launch to your sphere (weekend Jun 20–21) — owner: Troy
- [ ] Post your own listing videos as an agent (not as founder).
- [ ] DM 10–15 warm agents their *own* listing rendered free. This needs no
      Stripe — it's free-trial funnel, starts building signups + testimonials now.

---

## TRACK B — gated on EIN (early next week)

### B1. EIN arrives (~Tue Jun 23) — owner: Troy
- [ ] Save the EIN confirmation. Submit it to Stripe to lift the account lock.
- [ ] **Verify with Stripe in writing** the lock is fully released (not a
      separate risk-review hold). This is the real gating risk — chase it.

### B2. Configure Stripe (same day EIN clears) — owner: Troy
- [ ] Set `default_price` on each of the 3 products (Launch $99 / Pro $249 /
      Studio $499). Credit packs ($100 single, $375 five) need no setup — inline.
- [ ] Confirm webhook endpoint is live + signing secret set on Vercel.

### B3. Full money-path test (same day) — owner: Claude + Troy
- [ ] Real card (you, refundable): buy the $100 single → confirm 1 credit
      granted → render → confirm credit decrements. Then a $375 pack.
- [ ] Trigger a deliberate render failure once → confirm the credit is
      refunded (the v26.7 ledger fix).

### B4. GO LIVE (Tue–Wed Jun 23–24) — owner: Troy
- [ ] Unpause Meta + Google campaigns.
- [ ] Watch the dashboard daily. The one number that matters: **cost per paid
      subscriber.** Under ~$120 = scale. Over ~$250 = pause and fix the funnel.

---

## Critical path (shortest route to revenue)
Push (A1) → migrations (A2) → smoke test (A5) → [EIN] → Stripe config (B2) →
money-path test (B3) → ads live (B4).

Everything else (A3, A4, A6, A7) runs in parallel and should be done by Fri.

## If the EIN slips past Tue
Track A is still fully shippable — run the **free-trial soft launch** (A7) to
keep building signups, and flip paid ads the day Stripe clears. Don't point
paid spend at a funnel that can't yet take payment.
