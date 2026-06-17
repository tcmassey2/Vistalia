# EstateMotion — Ad Campaign Financial Analysis
### $100/day × 14–21 days. Will it work?

Prepared June 17, 2026. All figures are modeled estimates to be replaced by
your real week-1 numbers — the structure and sensitivities matter more than
any single input.

## First: define "success" (this changes the whole verdict)

Three different bars, increasingly hard:

1. **Funnel validated** — the campaign produces paying customers at a CAC
   below their lifetime value, proving the model is worth scaling. *This is
   the right bar for a 2–3 week test.*
2. **Cash-neutral in-window** — collected revenue ≈ total spend (ads + COGS)
   during the test. Possible but not the point.
3. **In-window profit** — revenue clearly exceeds spend in 14–21 days. Rare
   for any subscription model this fast; don't bet on it.

A $1,400–2,100 test is fundamentally **buying data**. Judge it on whether the
unit economics work, not on a 2-week P&L.

## Cost inputs (established, real)

- Ad spend: **$100/day** → $1,400 (14d) / $2,100 (21d)
- COGS per finished video: **~$6** (Veo 3.1 Fast via fal.ai + ElevenLabs + OpenAI)
- **Every free-trial signup that renders costs you ~$6** — this matters more than it looks (below)
- Pricing: $100 single (93% margin) · $375 5-pack ($75/video) · $99/$249/$499 subs
- Free trial: 1 video, no card

## The funnel (modeled — realtor targeting on Meta)

Benchmarks for licensed-agent B2B targeting: CPM ~$20–35, cost-per-click
~$1.50–3.50, landing-page-view rate and signup rate depend heavily on the
page. The two swing variables are **trial-signup rate** and **trial→paid rate**.

## Three scenarios (14-day, $1,400 ad spend)

| | Pessimistic | Base | Optimistic |
|---|---|---|---|
| Cost per click | $3.50 | $2.20 | $1.50 |
| Landing-page visits | ~400 | ~640 | ~930 |
| Trial signup rate | 10% | 18% | 28% |
| **Trials (free videos)** | **40** | **115** | **260** |
| Free-trial COGS (~$6 ea) | $240 | $690 | $1,560 |
| Trial → paid rate | 3% | 8% | 12% |
| **Paying customers** | **~1** | **~9** | **~31** |
| Blended first purchase | $130 | $145 | $155 |
| Collected revenue (in-window) | ~$160 | ~$1,300 | ~$4,800 |
| Total cost (ad + COGS) | ~$1,650 | ~$2,100 | ~$3,000 |
| **In-window net** | **−$1,490** | **−$800** | **+$1,800** |
| **CAC per customer** | ~$1,400 | ~$155 | ~$45 |
| Est. recurring MRR built | ~$0 | ~$500 | ~$2,200 |

21-day version scales ad spend to $2,100 (~50% more volume of everything) —
same per-unit economics, more data, proportionally larger swing.

## The non-obvious risk: free-trial COGS scales with success

Because the trial gives away a ~$6 video, **your COGS grows with top-funnel
volume, not with revenue.** The worst cash outcome isn't low traffic — it's
*high signups, low conversion*: lots of free videos given away to people who
don't buy. In the optimistic-traffic / weak-conversion corner, free COGS alone
(~$1,560) nearly equals the ad budget.

**True maximum downside over 14 days ≈ $1,400 ad + ~$1,500 free COGS ≈ $2,900**
— not $1,400. Budget for ~$3k of real exposure, not $1.4k.

## Probability assessment (honest)

- **Funnel validated (CAC < LTV, worth scaling): ~50–60%.** The product is now
  genuinely good (Veo, review-and-approve, MLS-safe framing) and the offer
  (free video → $100) is sound. The live unknowns are landing-page conversion
  and trial→paid — both fixable with iteration, but unproven on cold traffic.
- **Cash-neutral or better in-window: ~25–35%.** Needs the base-to-optimistic
  band on trial→paid. The one-off $100 cash helps a lot here vs a pure-sub model.
- **Clear failure (CAC stays > ~$250, not worth scaling): ~30–40%.** Driven by
  weak trial→paid or expensive clicks. Detectable early — see kill-switches.

Net read: **more likely than not to validate the model, unlikely to profit in
the window, with a real (~1 in 3) chance it shows the funnel doesn't convert
at a price worth scaling.** That's a reasonable bet *if* you treat the $1,400–
2,100 as tuition for data and protect the downside.

## What determines which scenario you land in

1. **Trial→paid rate** — the single biggest swing. A great free video that
   leaves them wanting the next one is the whole game.
2. **Landing-page conversion** — doubling it doubles revenue for the same spend.
3. **Click cost** — realtor targeting is pricey; creative quality controls it.

## Recommendation + guardrails

- **Frame it as a data buy.** Success = "we learned the real CAC and trial→paid."
- **Set kill-switches before you spend:**
  - Pause an ad set if cost-per-trial > **$12** after $50 spent.
  - Reassess the whole campaign if trial→paid < **5%** after the first ~60 trials
    — more spend just loses faster; fix the page/product first.
- **Cap free-COGS exposure:** watch the fal.ai balance daily; the free video is
  your biggest hidden cost. (If signups spike with weak conversion, consider
  requiring a card for the trial — kills volume but stops the bleed.)
- **Push packs, not singles** — collected cash funds the next ad dollar; a
  $375 pack is 3.75× the cash of a $100 single per conversion.
- **Judge at day 7, not day 14.** You'll have enough trials by day 7 to see the
  trajectory and decide to scale, fix, or stop.

## Bottom line
A defensible test with a roughly coin-flip-to-favorable chance of validating a
scalable funnel, a low chance of in-window profit, and ~$3k of true downside
exposure. Worth running **if** you can absorb ~$3k with no return and you treat
the output as data that tells you whether to pour more in — not as the launch
that must pay for itself.
