# Higgsfield Ad Assets — Backup Manifest

Catalog of all Higgsfield Marketing Studio generations. **Local backups** live in
`marketing/higgsfield-ads/` (gitignored — kept on disk, not committed, so they don't stall
pushes). **Canonical cloud copies** remain in the Higgsfield account library. CDN URLs
below are the originals (may expire over time — the local files are the durable copy).

Last backed up: June 19, 2026.

## EstateMotion (the SaaS — current brand)

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
