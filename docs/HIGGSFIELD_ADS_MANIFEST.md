# Higgsfield Ad Assets — Backup Manifest

Catalog of all Higgsfield Marketing Studio generations. **Local backups** live in
`marketing/higgsfield-ads/` (gitignored — kept on disk, not committed, so they don't stall
pushes). **Canonical cloud copies** remain in the Higgsfield account library. CDN URLs
below are the originals (may expire over time — the local files are the durable copy).

Last backed up: June 21, 2026.

## Vistalia — LAUNCH BATCH (Kling 3.0 Turbo, June 21) — faceless 9:16 1080p reveals
Production launch set (brand is now **Vistalia**). Faceless Scottsdale desert-modern
reveals; hooks/text/VO/end-cards assembled in post. Ad mapping: `marketing/VISTALIA_LAUNCH_ADS.md`.

| File | Concept / use | Model | Job ID |
|---|---|---|---|
| `vistalia-reveal-hero-mansion-flip_391da4d6.mp4` | C1 hero — dusk exterior → double-height foyer sweep | kling3_0_turbo | 391da4d6-aa03-4897-8cda-704d50cfc7a8 |
| `vistalia-reveal-interior-walkthrough_056450eb.mp4` | A1 own-voice — kitchen → great-room glide | kling3_0_turbo | 056450eb-fa89-4a8d-9edd-7c6ece2ec70c |
| `vistalia-reveal-room-blooms_4a08e6cf.mp4` | B1 silent-vs-sound — room comes alive | kling3_0_turbo | 4a08e6cf-9f55-4624-91db-dd73b0c7d267 |
| `vistalia-standout-photo-wakes-up_7548b2bb.mp4` | D1 — flat photo ripples into motion | kling3_0_turbo | 7548b2bb-e6ce-4496-a7d3-b81a2240c5f6 |
| `vistalia-standout-dive-into-phone_cc9bdbfc.mp4` | C2 scroll-stopper — camera dives into phone | kling3_0_turbo | cc9bdbfc-11ef-4e92-811a-258fafb52337 |
| `vistalia-standout-bedroom-bloom_f60a30c7.mp4` | B2 sound-on test — flat → alive bloom | kling3_0_turbo | f60a30c7-da9a-4ba9-8500-2a144b1ecb0b |
| `vistalia-fresh-vista-reveal_4bc613d6.mp4` | A2 / anthem — glass opens to desert vista (brand-name beat) | kling3_0_turbo | 4bc613d6-2ff6-45ab-bde0-80e4080b2ff6 |
| `vistalia-fresh-twilight-pool_73bee506.mp4` | D2 / anthem — twilight infinity pool | kling3_0_turbo | 73bee506-b42f-4256-9780-e6c9a641275d |
| `vistalia-endcard-bed_a6e9dd0d.mp4` | End-card backdrop — negative space for the V logo | kling3_0_turbo | a6e9dd0d-5c63-4439-be9c-f007ee8cbd68 |

*All 9: faceless, no text/logos baked in (added in post). Rendered via plain Kling
text-to-video — NOT marketing_studio_video, which forces a presenter.*

## Vistalia — UGC TALKING-HEAD BATCH (June 21) — consistent AI spokesperson
Production hybrid UGC ads. **Spokesperson identity (reuse for all future UGC):** base
portrait job `7708a15b-e647-4a46-925b-7a456e69de7b` (`vistalia-spokesperson-base_7708a15b.png`)
— warm female agent, late 30s, cream blazer. Generated via **soul_2**, then used as the
`image` reference to place her in each setting; animated with **kling3_0** (sound on) so she
speaks the hook. Finished ads = UGC hook → matched reveal → V end card, captions + ducked
music. Voice is the AI persona's, NOT Troy's (founder stays off-camera).

| Finished ad (in `marketing/assembled/`) | Hook clip | Reveal used | Hook job ID |
|---|---|---|---|
| `vistalia-ugc-car-confessional.mp4` | `vistalia-ugc-hook-car_a784f177.mp4` | hero mansion flip | a784f177-f83c-4f1d-b4e3-3cdc57290740 |
| `vistalia-ugc-referral.mp4` | `vistalia-ugc-hook-referral_fc5e3e58.mp4` | interior walkthrough | fc5e3e58-e42b-4fe8-949e-8f0defb384a5 |
| `vistalia-ugc-no-subscription.mp4` | `vistalia-ugc-hook-nosub_2c8db6d6.mp4` | photo-wakes-up | 2c8db6d6-dc1f-4339-b663-930f3186e7b0 |
| `vistalia-ugc-coffee-speedrun.mp4` | `vistalia-ugc-hook-coffee_d134bdd8.mp4` | dive-into-phone | d134bdd8-642e-4d87-854b-9e36e78b2265 |

*Audio: ElevenLabs music beds via sonilo_music (12s `8ed5f06b`, 16s `6e6cfb91`). Dive-in
solo ad (`vistalia-ad-dive-in.mp4`) uses pro-narrator VO `df3f7919` (Sloane).*

## Vistalia — UGC BATCH 2 (June 21) — segment-targeted, 2 new spokespersons
Targeting strategy: `marketing/VISTALIA_AD_TARGETING.md`. Seamless audio (music ducked under
voice, swells the instant she/he stops, synced to the cut). New music bed `75f18f0a` (16s).
**New reusable spokespersons:** young male agent `97468690`
(`vistalia-spokesperson-male_97468690.png`); seasoned 50s female `943f81fd`
(`vistalia-spokesperson-senior_943f81fd.png`).

| Finished ad (`marketing/assembled/`) | Persona | Segment | Hook job ID |
|---|---|---|---|
| `vistalia-ugc-win-the-listing.mp4` | woman 30s–40s | win-the-listing (high intent) | 545b0f22-57d8-475f-85de-bbfce2b7b5ac |
| `vistalia-ugc-roi.mp4` | woman 30s–40s | ROI / budget / part-time | d10904e6-b7e6-4324-89fe-91ccc778e43d |
| `vistalia-ugc-new-agent.mp4` | young man | new licensees / younger / male | 5b851fd6-587f-4ebe-8d16-04d5cd5dc1c3 |
| `vistalia-ugc-not-techy.mp4` | woman 50s | demographic core / anti-objection | 1f91da4a-fe80-4379-801d-b8239f5914a7 |

*(First new-agent take `6ea73882` had a 1.4s dead pause — re-rendered as `5b851fd6`.)*

## Vistalia — FINAL LAUNCH BATCH (June 21) — diversity, objection-killers, hero
**New reusable spokespersons:** Latina woman `7372631e`
(`vistalia-spokesperson-latina_7372631e.png`); Black man `f6c93d70`
(`vistalia-spokesperson-blackmale_f6c93d70.png`).

| Finished ad (`marketing/assembled/`) | Persona | Purpose | Hook job ID |
|---|---|---|---|
| `vistalia-ugc-mls-safe.mp4` | Latina woman | objection-killer: MLS-safe / you approve every scene | 7b0ed11d-0edb-4f2d-81aa-c872f0d6a558 |
| `vistalia-ugc-not-fake.mp4` | Black man | objection-killer: "I thought it'd look fake — it doesn't" | 783f35da-ebf4-4f8c-bb6f-cdda38805db1 |
| `vistalia-launch-hero.mp4` | faceless | launch-moment hero: "Introducing Vistalia → first one free" | (assembled from reveals 391da4d6 / 4bc613d6 / 73bee506) |

*Full persona roster now: white woman 30s–40s, white man late-20s, white woman 50s, Latina
woman 30s, Black man 30s. Spans the female-majority + age + ethnic spread of the 3M.
Targeting rationale: `marketing/VISTALIA_AD_TARGETING.md`.*

## EstateMotion (the SaaS — prior brand name)

| File | What it is | Mode | Date | Job ID |
|---|---|---|---|---|
| `estatemotion-ugc-agent_67694250.mp4` | New ad — agent testimonial holding phone showing EstateMotion, "narrated in YOUR voice, first video free." Faceless was requested; engine rendered it as UGC with an on-camera presenter. | UGC (9:16) | Jun 19 2026 | 67694250-2c63-4e00-adab-05138ffb91ba |
| `estatemotion-editorial-tvspot_051fc7e7.mp4` | Editorial Architectural Digest spot, no people — twilight home → foyer → kitchen, laptop showing the EstateMotion site. Videographer-cost-vs-EstateMotion VO. Faceless. | TV Spot (16:9) | May 16 2026 | 051fc7e7-7d63-40a4-9ec7-c40fafcc6b79 |
| `estatemotion-ownvoice_f59d0141.mp4` | Own-voice spot attempt. Requested faceless; engine overrode to UGC presenter (webproduct flow forces a talking head). | UGC (9:16) | Jun 19 2026 | f59d0141-ff2a-4ac0-a790-6b837fb4ebb4 |
| `estatemotion-photos-to-video_3c9b4c08.mp4` | Photos-to-video spot attempt. Requested faceless; engine overrode to UGC presenter at a kitchen island. | UGC (9:16) | Jun 19 2026 | 3c9b4c08-3cfb-4f37-961f-48b6c9026085 |

## EstateMotion — faceless cinematic (Kling, June 19) — people-free

| File | What it is | Model | Job ID |
|---|---|---|---|
| `estatemotion-faceless-cinematic-desert_bca9314b.mp4` | Golden-hour desert-home exterior → living room → marble kitchen. Clean faceless b-roll. | kling3_0_turbo | bca9314b-e17c-4552-a665-e1c290731849 |
| `estatemotion-faceless-cinematic-twilight_d7945bce.mp4` | Twilight living room, drifting curtains, pool reflections, blue-hour push. Faceless b-roll. | kling3_0_turbo | d7945bce-6f4e-4788-ad1b-6c960c8edf99 |

## EstateMotion — STANDOUT concept ads (Kling, June 19) — the scroll-stoppers

| File | Concept | Model | Job ID |
|---|---|---|---|
| `estatemotion-standout-photo-wakes-up_b1f46c6d.mp4` | A1 — flat listing photo ripples and *comes alive* into cinematic motion (the product, demoed). | kling3_0_turbo | b1f46c6d-2e62-4fcd-a9be-f92c543d389d |
| `estatemotion-standout-dive-into-phone_806c31fd.mp4` | C1 — camera dives *into* a phone's listing thumbnail, flies through the home, pulls back out. | kling3_0_turbo | 806c31fd-a619-40be-8b43-47b822b73383 |
| `estatemotion-standout-mute-vs-soundon_7b5b96dd.mp4` | B1 — silent/flat tour, a tap flips sound-on and the room blooms to life. Forces the unmute. | kling3_0_turbo | 7b5b96dd-559c-4f4d-8202-025cf0a69ed2 |

*Note: standout + faceless Kling clips render silent by design — add the VO line, music bed,
and logo end-card in post. The two `marketing_studio_video` "presenter" variants
(`estatemotion-ugc-ownvoice-presenter`, `estatemotion-ugc-photos2video-presenter`) came out
as UGC talking-heads (that model always does); kept as presenter A/B options.*

## Troy Massey Realty (earlier brand batch)

| File | What it is | Mode | Date | Job ID |
|---|---|---|---|---|
| `troymassey-tvspot-keycard_c11fc2d5.mp4` | Cinematic TV spot — key card "draws" a Phoenix luxury home, agent in doorway. | TV Spot (16:9) | May 17 2026 | c11fc2d5-1a08-4cc2-8c54-6ea41a640596 |
| `troymassey-ugc-3things_03735edd.mp4` | UGC "3 things luxury buyers tell me" foyer vlog. | UGC (16:9) | May 17 2026 | 03735edd-06fa-42fb-98fe-ff390de944c2 |
| `troymassey-ugc-fruitbowls_947d180f.mp4` | UGC car rant — "three staged fruit bowls." | UGC (16:9) | May 17 2026 | 947d180f-424b-4e08-860a-82a3fb79bcbe |
| `troymassey-ugc-couch_7bd27229.mp4` | UGC couch/coffee candid — "that's a them problem." | UGC (16:9) | May 17 2026 | 7bd27229-5196-4aac-96e6-4a831b493cd3 |
| `troymassey-ugc-walkin_53f8f013.mp4` | UGC walk-in reveal — "wait until you see this kitchen." | UGC (16:9) | May 17 2026 | 53f8f013-b7c9-4368-b54b-fde8372c3fad |
| `troymassey-ugc-hottake-car_e1e4502c.mp4` | UGC car hot-take — "I'm not that agent." | UGC (16:9) | May 17 2026 | e1e4502c-3315-434d-be6a-a2e6da86a8cb |

## Editorial stills (image)

| File | What it is | Date | Job ID |
|---|---|---|---|
| `elevated-home-interior_a4f7590d.png` | "ELEVATED HOME" interior great-room editorial ad (2K). | May 19 2026 | a4f7590d-45e7-4e05-8041-8ace37c75ec0 |
| `elevated-home-dusk_3899a27b.png` | "ELEVATED HOME" blue-hour estate editorial ad (2K). | May 19 2026 | 3899a27b-efbe-4a0e-8653-72c80acebc66 |

## Pending
- A **second EstateMotion render** was still processing at backup time. Once it finishes,
  re-run the backup to pull it into `marketing/higgsfield-ads/` and add a row here.

## How to restore / re-pull
The Higgsfield library is the source of truth. To re-download, use
`show_marketing_studio_generations` to get fresh CDN URLs (the dated `rawUrl` fields), then
save into `marketing/higgsfield-ads/`.
