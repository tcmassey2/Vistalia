# Reel-E vs EstateMotion — Competitive & Financial Analysis

June 18, 2026. Goal: study what's already working for Reel-E (18,000+ agents, paying)
and decide what to borrow, what to attack, and how to price. The thesis Troy set:
"see what's working for others and put our spin on it."

---

## 1. The one-sentence version

Reel-E sells **cheap, MLS-safe, music-only camera-motion-on-photos by subscription**
to volume agents. EstateMotion sells **hyperreal generative Veo motion in the agent's
own voice, reviewed scene-by-scene, pay-per-video**. They've proven the market exists.
We don't beat them on price — we beat them on *what the video is* and *whose voice
narrates it*, and we charge a premium for it.

---

## 2. What Reel-E actually is (the audit)

**Technology.** Reel-E does *not* generate new video. It detects depth in each still
photo and flies a virtual camera through it — orbits, push-ins, pull-outs — then cuts
the moves to music downbeats. This is the same category as EstateMotion's old "depth /
2.5D parallax" engine, executed very well. It is **never** generative: it only ever
shows the real photo from new angles.

**That is their biggest strength and their ceiling at the same time:**
- Strength: it is *MLS-compliant by construction*. It cannot invent a window, melt a
  staircase, or hallucinate a second pool. The laundry-room / pool failures that forced
  our review-every-scene gate literally cannot happen to them.
- Ceiling: it is "slideshow-plus." Buyers can tell nothing in the room is actually
  moving. There's no water rippling, no curtain drift, no light changing — because no
  new pixels are ever created.

**What they include per "listing" (one upload):**
- 4 video formats: 16:9 + 9:16, branded + unbranded
- Licensed music, auto-synced to pacing
- Listing website
- Photo edits / virtual staging (10–20 per listing depending on tier)
- 1080p (4K only on Pro)
- ~2-minute render

**What they do NOT have (verified across pricing, homepage, and feature pages):**
- **No voiceover. No narration. No cloned voice.** Nowhere on the site. Their videos
  are music-only. This is the gap the title companies are texting Troy about.
- No true generative motion (per above).

**Pricing (their public tiers, billed annually):**

| Plan | Price/mo | Listings/mo | Listings/yr | Effective $/listing | Quality |
|------|----------|-------------|-------------|---------------------|---------|
| Essential | $44 ($59 monthly) | 3 | 36 | **$14.67** | 1080p |
| Growth (most popular) | $97 ($129 monthly) | 10 | 120 | **$9.70** | 1080p |
| Pro | $449 ($599 monthly) | 50 | 600 | **$8.98** | 4K |
| Enterprise | custom | custom | — | — | white-label, API |

Their own marketing frames it as **"$9–15 per listing"** vs $500–1,200 for a
videographer. Unused listings roll over (Growth up to 20, Pro up to 100). 7-day free
trial. No contract.

**Their go-to-market, which is the part worth copying:**
- A deep SEO landing-page farm: `/ai-real-estate-video`, `/real-estate-video-maker`,
  `/listing-video-maker`, `/photo-to-video-real-estate`, `/property-video-creator`,
  `/for-realtors`, `/for-architects`, `/multifamily` — each targeting a keyword cluster.
- An authority hook: **"Built by the team behind Selling Sunset and Million Dollar
  Listing LA."** That single line does enormous trust work.
- Hard social proof: named agents, brokerages, cities, specific outcomes ("sold in 9
  days," "days on market cut in half," "won the listing").
- The stat they lead with: **listings with video get 403% more inquiries.**

---

## 3. Head-to-head

| | Reel-E | EstateMotion |
|---|---|---|
| Core motion | Camera flown through a still photo (depth/parallax) | **Veo 3.1 generative** — real motion in the scene |
| Realism ceiling | "Slideshow-plus" | Hyperreal; looks filmed |
| MLS safety | Safe by construction | Safe via **review-every-scene gate** (engineered) |
| **Voice** | **None — music only** | **Pro narrator OR the agent's own cloned voice** |
| Formats per order | 4 (incl. branded/unbranded) | Currently 1 primary (gap — see §6) |
| Listing website | Included | Not offered (gap) |
| Photo editing / staging | Included | Not offered (gap) |
| Pricing model | Subscription | Pay-per-video |
| Effective price | ~$9–15 / listing | $65–100 / video |
| Render time | ~2 min | Longer (generative) |
| Authority | Selling Sunset team | None yet (gap) |
| Proof | 18,000 agents, named testimonials | Pre-launch |

**Read this honestly:** Reel-E wins on price, speed, bundle breadth, and proof.
EstateMotion wins on exactly two axes — **motion realism** and **voice** — plus the
*compliance story* around the realism. Those two axes are enough, but only if we charge
like a premium product and don't pretend to compete on their turf.

---

## 4. Financial analysis — unit economics

**EstateMotion COGS per video (Veo 3.1 Fast on fal.ai):**
- Veo generation, audio off, 1080p: **$0.10 / generated second.**
  - 30s video ≈ 5 scenes × 6s = 30s → **$3.00**
  - 60s video ≈ 10 scenes × 6s = 60s → **$6.00**
- ElevenLabs narration (turbo v2.5): ~**$0.05–0.15** per video
- Render-worker compute + storage: ~**$0.30–0.60**
- Allowance for 1–2 scene regenerations: ~**$0.60–1.20**

**All-in COGS: ~$4–5 for a 30s video, ~$7–8 for a 60s video.**

**Gross margin at our price points:**

| Our price | Product | COGS | Gross margin |
|-----------|---------|------|--------------|
| $100 single (30s) | 1 video | ~$4.50 | **~95%** |
| $100 single (60s) | 1 video | ~$7.50 | **~93%** |
| $75/video (pack of 5 = $375) | 5 videos | ~$4.50 | **~94%** |
| $65/video (pack of 10 = $650) | 10 videos | ~$4.50 | **~93%** |

**The margin is not the problem. The margin is excellent at every tier.** Even at our
floor of $65/video we keep ~93%. We could cut price aggressively and still print money
on a per-unit basis.

**Why Reel-E can charge $10 and we structurally can't match it:** their COGS per
listing is near-zero — depth-warp rendering is cheap compute, no per-second generative
model bill. Our Veo bill is real money per second. So a price war *down to $10* would
compress our excellent margin against their near-infinite one. **We must not race them
to the bottom.** Our cost structure is a premium cost structure; our pricing has to be a
premium price.

---

## 5. Financial analysis — the LTV problem (this is the real one)

Per-unit margin is healthy. The strategic risk is **lifetime value**, and this is where
Reel-E's model quietly beats ours.

- **Reel-E Growth agent:** $97/mo. If they retain 6 months → **$582 LTV.** 9 months →
  $873. The subscription compounds whether or not they make a video that month.
- **EstateMotion single-video buyer:** $100 once. If they buy once and never return →
  **$100 LTV.** Our LTV is entirely dependent on *repeat purchase per new listing*.

Troy's plan is to funnel revenue into Meta ad spend. With a $100/day budget that math
only works if **LTV comfortably exceeds CAC**. If a paid agent buys one $100 video and
churns, and blended CAC is, say, $60–120 per paying customer, we're underwater or flat.
Reel-E's recurring $97/mo makes their CAC payback trivial; one retained agent funds
months of acquisition.

**Conclusion: pay-per-video is the right *launch* motion (low friction, fast cash, no
commitment objection), but it is a weak *scaling* motion unless we engineer repeat
purchase or add a recurring option.** The packs (5 for $375, 10 for $650) are the bridge
— they pull LTV forward and lock the agent into using us for their next several listings.
Push the packs hard; the single is the trial.

---

## 6. What to borrow from Reel-E ("our spin")

In rough priority order:

1. **Multiple formats per order.** Reel-E's "4 videos from one upload" is a real value
   driver and an easy win for us — we already render a master; auto-export 9:16, 1:1, and
   a branded/unbranded pair from the same render. Make "every format included" a headline.
   This closes their biggest *tangible* bundle advantage cheaply.

2. **Lead with the voice — it's the wedge they can't answer.** Reel-E is silent. Our
   homepage hero should be a video *talking in the agent's own voice*. The title-company
   texts prove the demand. Headline candidate: *"The only listing video that sounds like
   you."* This is the single clearest reason to pick us over the incumbent.

3. **Authority hook.** They have "Selling Sunset." We need our own credibility line —
   "Built on Google's Veo 3.1, the same generative engine behind [X]," or a founder/
   production credibility statement, or early named-agent results the moment we have them.

4. **SEO landing-page farm.** Their `/for-realtors`, `/photo-to-video`, etc. cluster is
   doing real lead-gen work. We should clone the structure with our angle (voice +
   generative). Cheap, compounding, and it's clearly working for them at 18,000 agents.

5. **Free trial.** 7-day free trial removes friction. Consider a single free *watermarked*
   video, or first-video-half-off, to get the agent to the "holy cow it's my voice" moment.

6. **Listing website + photo editing as future add-ons**, not launch scope. They bundle
   these. We don't need them to launch, but they're the obvious upsell ladder later and
   worth noting so we're not surprised when prospects ask "do you also do a listing site?"

7. **Steal their proof format.** Named agent, brokerage, city, specific outcome ("won the
   listing," "sold in 9 days"). Collect these from our first 10 users deliberately.

---

## 7. What to attack (their weaknesses)

- **Silence.** Hammer it. "Music-only" vs "in your own voice" is our cleanest contrast.
- **"Slideshow-plus."** Show a side-by-side: their photo-with-a-camera-move next to our
  Veo clip where the water actually moves and light actually shifts. Let the eye decide.
- **Subscription lock-in fatigue.** Some agents resent monthly bills for a tool they use
  3x a month. "Pay only when you list" is a real positioning against a $44–449/mo commit.

---

## 8. Recommended positioning & pricing

**Position:** EstateMotion is the **premium, voice-first** listing video — generative
realism, narrated in the agent's own voice, every scene MLS-reviewed. Not the cheapest;
the one that wins the listing presentation.

**Pricing at launch — keep pay-per-video, lead with packs:**
- $100 single = the trial / impulse buy.
- **5-pack at $375 ($75/ea)** = the hero offer; this is what we promote.
- 10-pack at $650 ($65/ea) = the power-agent / team option.
- Every order ships **all formats** (per §6.1) so the bundle reads as generous despite
  the higher unit price.

**Within ~60 days of launch, test a subscription tier** purely to fix the LTV/CAC math
for ad scaling — e.g. "$149/mo, 3 videos/mo, your voice included, formats included." This
directly mirrors Reel-E's Essential ($44, 3 listings) but at a premium that our voice +
generative quality justifies, and it converts one-time buyers into compounding LTV that
makes $100/day Meta spend sustainable.

**Do not** drop our unit price toward their $10. Our COGS forbids it and our product
doesn't need it. We win the agents who care that the video looks real and sounds like
them — and those agents happily pay 5–10x for that.

---

## 9. Bottom line for the ad plan

- Per-video margins (~93–95%) mean the product can fund ad spend *if agents come back*.
- The make-or-break number is **repeat rate / LTV**, not margin. Promote packs to force
  it; plan a subscription tier to lock it.
- Our ad creative should lead with the **own-voice** hook and a **side-by-side realism**
  shot — the two things Reel-E, at 18,000 agents and $9/listing, simply cannot show.

---

### Sources
- [Reel-E Pricing](https://www.reel-e.ai/pricing)
- [Reel-E — AI Real Estate Video From Photos](https://www.reel-e.ai/ai-real-estate-video)
- [fal.ai — Veo 3.1 Fast (Image to Video) pricing](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video)
