# Vistalia — UGC Ad Targeting Strategy

June 21, 2026. How the UGC ad batches map to the ~3,000,000 licensed real-estate agents
in the US. The point: most of that market is NOT the polished 30-something top producer.
Different faces + different angles let us cover distinct, real segments — and showing
several "different real agents" also reads as authentic UGC and feeds the ad algorithm
varied creative.

## Who the 3M actually are (the targeting reality)
- **Mostly women, median age ~55.** The demographic core is an experienced woman in her
  50s — under-served by competitors' young-and-glossy creative.
- **Most aren't top producers.** A large share do only a handful of deals a year; many are
  part-time. Price sensitivity and "is this worth it" are real.
- **Huge, constant inflow of new licensees** fighting a credibility gap — they need to look
  established immediately.
- **Almost all are solo,** doing their own marketing, with no team and no video skills.
- **The listing appointment is the obsession.** Winning listings is where agents spend
  money and attention; "show up looking pro" beats every feature pitch.

## Spokespersons (reusable identities — see HIGGSFIELD_ADS_MANIFEST.md)
| Persona | Reads as | Best for segment |
|---|---|---|
| Brunette woman, 30s–40s (`7708a15b`) | Established mid-career agent | The broad middle; aspiration |
| Young man, late 20s (`97468690`) | Hungry new agent | New licensees, men, younger |
| Silver-haired woman, mid 50s (`943f81fd`) | Seasoned veteran | **The demographic core** + tech-intimidated |

## Batch 1 — value/ease/price (in `marketing/assembled/`)
Targets the budget-conscious, time-strapped, "I'm not a videographer" middle.
- `vistalia-ugc-car-confessional` — "almost paid $1,200… made this free" → **price/free**.
- `vistalia-ugc-referral` — "clients keep asking who films my listings" → **social proof / FOMO**.
- `vistalia-ugc-no-subscription` — "$100 a video, nothing to cancel" → **subscription-haters**.
- `vistalia-ugc-coffee-speedrun` — "a full video before my coffee gets cold" → **speed/ease**.

## Batch 2 — segment-targeted (in `marketing/assembled/`)
Each ad is aimed at a distinct, high-value slice of the 3M.
- `vistalia-ugc-win-the-listing` (woman 30s–40s) — "I bring the video TO the listing
  appointment; won my last four on the spot." → **the universal high-intent obsession:
  winning listings.** Highest-converting angle; lead with it.
- `vistalia-ugc-roi` (woman 30s–40s) — "one commission pays for these for ten years; why is
  anyone still paying a videographer?" → **budget / part-time / ROI-justifiers.**
- `vistalia-ugc-new-agent` (young man) — "licensed three months ago; my listings look like a
  twenty-year pro made them." → **new licensees + younger + male reach.** Level-the-field.
- `vistalia-ugc-not-techy` (woman 50s) — "I'm 56 and the least techy person in my office; made
  this in three minutes, no editing." → **the demographic core + the #1 objection (too
  complicated).** Demographically on-target and competitor-ignored.

## How to run it
1. Lead paid spend with **win-the-listing** and **not-techy** — highest intent + biggest
   under-served segment. Add **new-agent** for cheap top-of-funnel reach.
2. Match the creative to the audience set: target new-license/education interests with the
   new-agent ad; broad 45–65 agent audiences with not-techy; listing-focused lookalikes with
   win-the-listing.
3. Run every finished ad through Higgsfield `virality_predictor`; kill below-median, scale
   winners. Then make 2–3 fresh variants of each winner (new hook line, same persona).
4. Next personas to add when scaling: a Latina agent and a Black agent (the 3M is diverse;
   matched faces lift relatability and reach).
