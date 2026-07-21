# EstateMotion — 2-Week Meta Campaign Revenue Plan

Spend: $100/day × 14 days = **$1,400**. Targeting: licensed realtors, geo + interest stacked.
Goal: maximum revenue per ad dollar. Principle: product + marketing are the assets; the rest is cost.

## The honest funnel math (so we optimize the right thing)

Realtor targeting on Meta runs ~$20–35 CPM, ~1–2% CTR → roughly **700–1,000 landing-page visits** over 2 weeks.

| Stage | Weak | Target | Strong | Lever |
|---|---|---|---|---|
| LP visits | 800 | 900 | 1,000 | ad creative + CPM |
| Trial signup % | 10% | 20% | 30% | **landing page** |
| Trials | 80 | 180 | 300 | — |
| Trial → paid % | 5% | 10% | 15% | **product + follow-up** |
| Paid subs | 4 | 18 | 45 | — |
| First-month rev (blended ~$160) | $640 | $2,880 | $7,200 | pricing mix |

Takeaway: the ad budget is fixed. **Every meaningful revenue swing comes from the two bolded rows — landing page conversion and trial→paid close — not from the ads.** A campaign at this budget realistically lands month 1 near breakeven-to-modest-profit; the real money is the recurring base it builds + months 2–3 retention. Optimize for building that base, not for a month-1 windfall.

## Priority order (highest revenue-per-effort first)

### 1. Conversion tracking — DO THIS BEFORE SPENDING A DOLLAR
Without it, Meta optimizes blind and you can't kill losers. Non-negotiable.
- Meta Pixel + Conversions API (server-side) on the site.
- Fire events: `Lead` (trial signup), `StartTrial` (first render), `Purchase` (checkout).
- Optimize the campaign for **trial signup (Lead)**, NOT purchase — $1,400 won't generate enough purchases to train the algorithm, but it will generate enough signups.

### 2. Landing page — the #1 revenue lever
A dedicated campaign LP, not the homepage. Must have:
- **Above the fold:** a real before/after product video (the `before-after-real-output.mp4` we cut) + one headline + one CTA: "Get your first listing video free."
- Message-match the ad exactly (same hook, same visual).
- Social proof, transparent pricing ($99/$249/$499), the MLS-safe/free-regen trust line.
- One CTA only. No nav, no distractions. Mobile-first (realtors scroll on phones).

### 3. The offer: free first video, no credit card
Converts the most signups and lets them *experience* the product (best predictor of paying). Protect COGS:
- Exactly 1 free render (already enforced server-side: trial cap = 1).
- COGS ceiling: ~$6/trial × 180 ≈ $1,000. Set a fal.ai balance alert; if signups spike, the cap protects you but watch it.
- Gate the 2nd render + download-without-watermark behind the paywall.

### 4. Follow-up close — where half the revenue actually lands
Most realtors won't buy on day 1. This sequence is near-free and high-ROAS:
- Email automation (Resend): trial-started-no-purchase → 4-touch sequence over 7 days (their finished video + "render your next listing" + a 48-hr discount).
- **Retargeting ad set** (~$20/day of the $100): target trial-started-not-paid + LP-visited-not-signed-up. Highest ROAS spend in the whole campaign.

### 5. Creative: volume + ruthless kill criteria
- Launch 5–6 variants day 1 (the UGC blonde hook, the real before/after cut, the swipe concept). Vary hook + property type only.
- Kill any ad above ~$8 cost-per-trial after 3 days / $25 spent. Scale winners.
- Refresh creative weekly — realtor audiences are small, fatigue is fast.

## Budget split (of $100/day)
- $75/day prospecting (Lead-optimized, broad realtor targeting)
- $20/day retargeting (trial-started + LP-visited)
- $5/day buffer / testing new hooks

## What I build, in order (gated on your go)
1. Meta Pixel + CAPI events wired into the site + render/checkout flow.
2. Dedicated conversion landing page (real product video above fold, one CTA, pricing, mobile-first).
3. Resend follow-up email sequence (trial → paid).
4. A small analytics view so you see signups/conversions live without digging in Meta.

## Hard truths
- $1,400 alone will not produce $10k. It produces a *subscriber base* whose LTV compounds. Judge it on cost-per-trial and trial→paid %, not month-1 profit.
- If trial→paid is under 5% after the first ~80 trials, **pause spend and fix the landing page / product experience** — more spend just loses money faster.
- Track one number daily: **cost per paid subscriber**. Under ~$120 = scale. Over ~$250 = stop and fix the funnel.
