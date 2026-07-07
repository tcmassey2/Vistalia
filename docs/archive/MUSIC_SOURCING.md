# Vistalia — Music Sourcing Plan (18 curated tracks)

_Not legal advice — confirm license terms in writing before shipping (see "Before you ship")._

## ⚠️ Read this first: "royalty-free" is NOT enough for Vistalia

Vistalia is a **UGC-export product** — your customers download videos with music baked in and repost them to their own TikTok/Instagram/MLS. That's the legal trip-wire. Most "royalty-free" creator licenses (Epidemic Sound personal, Artlist, Uppbeat creator tier) license the track to **you** for **your** content. They generally **prohibit sublicensing** — i.e., letting *your users* redistribute the music inside *their* content. Per the industry guidance: _"If users can export, publish, or share content containing music, the platform — not the end user — is the party that needs redistribution rights. Licenses that prohibit sub-licensing are not suitable for products with UGC workflows."_

So the music has to be cleared for the thing your competitors all promise: **"post anywhere, no copyright strikes."** That requires a platform/sublicense-grade license, not a creator license.

## What license Vistalia actually needs — the must-have clauses

Before paying for any library, confirm the license explicitly grants all of these:

- **Software/platform embedding** — names apps / web platforms, not just "videos."
- **Redistribution via user exports** — music can ship inside content your users download and republish.
- **Sublicensing / downstream use** — your end users may use the music in their own posts.
- **Unlimited scale** — no caps on users, installs, plays, or revenue.
- **Perpetual for shipped content** — videos already rendered stay licensed even if you cancel.
- **Commercial use, worldwide, no PRO reporting.**

If any of those are vague or missing, the license fails under review (app stores, enterprise buyers, investor due diligence all check this now).

## Where to license — ranked for your use case

1. **Bensound (commercial / SaaS license)** — *start here.* Affordable subscription, real catalog, and they explicitly address app/SaaS embedding. **Caveat:** confirm their license tier covers *end-user redistribution* (the UGC-export case) — that may require their top/commercial tier or a short custom note, not the basic plan. The 18 tracks below are all Bensound.
2. **Soundstripe (Enterprise/API) or Epidemic Sound (Partner Program/API)** — purpose-built for platforms that embed music into customer content. This is likely what Reel-E/AutoReel use. Pricier / custom quote — the right move once you scale.
3. **CC0 / true public domain** — zero licensing risk and free, but smaller/variable quality and you must verify each track is genuinely CC0. (Pixabay's license allows commercial use but restricts standalone-file redistribution — usually fine for embedding, but confirm the export angle.)

## Curated shortlist — 18 tracks by style (Bensound)

### Cinematic Luxury — warm, premium, piano/strings, slow build
1. **North** — reflective cinematic · https://www.bensound.com/royalty-free-music/track/north-reflective-cinematic
2. **Welcome Home** — epic synth (perfect name for a hero reveal) · https://www.bensound.com/royalty-free-music/track/welcome-home-epic-synth
3. **Lines That Bend** — hopeful cello · https://www.bensound.com/royalty-free-music/track/lines-that-bend-hopeful-cello
4. **Kept Promise** — epic emotional · https://www.bensound.com/royalty-free-music/track/kept-promise-epic-emotional
5. **Arboretum** — glowy, shiny, elegant · https://www.bensound.com/royalty-free-music/track/arboretum-glowy-shiny

### Modern Social — upbeat, modern, scroll-stopping
6. **On Repeat** — shiny, uplifting · https://www.bensound.com/royalty-free-music/track/on-repeat-shiny-uplifting
7. **Orange Clouds** — shiny retro · https://www.bensound.com/royalty-free-music/track/orange-clouds-shiny-retro
8. **Kaleidoscope** — retrowave / chillwave · https://www.bensound.com/royalty-free-music/track/kaleidoscope-retrowave-chillwave
9. **Fly Forward** — jazzhop / lo-fi hip-hop (modern, trendy) · https://www.bensound.com/royalty-free-music/track/fly-forward-jazzhop-lo-fi-hip-hop
10. **By My Side** — joyful, party · https://www.bensound.com/royalty-free-music/track/by-my-side-joyful-party

### MLS Clean — neutral, light, unobtrusive, professional
11. **Alpha** — hopeful ambient · https://www.bensound.com/royalty-free-music/track/alpha-hopeful-ambient
12. **Starlight** — chill, bright · https://www.bensound.com/royalty-free-music/track/starlight-chill-bright
13. **Midnight Thoughts** — hopeful, gentle piano · https://www.bensound.com/royalty-free-music/track/midnight-thoughts-hopeful-gentle-piano
14. **Let It All Begin** — epic chillout · https://www.bensound.com/royalty-free-music/track/let-it-all-begin-epic-chillout

### Investor Tour — confident, steady, corporate
15. **New Frontier** — emotional, hopeful · https://www.bensound.com/royalty-free-music/track/new-frontier-emotional-hopeful
16. **Unbreakable Resolve** — hopeful, epic · https://www.bensound.com/royalty-free-music/track/unbreakable-resolve-hopeful-epic
17. **Shards of Hope** — encouraging soundtrack · https://www.bensound.com/royalty-free-music/track/shards-of-hope-encouraging-soundtrack
18. **Brighter Than Ever** — inspiring, positive · https://www.bensound.com/royalty-free-music/track/brighter-than-ever-inspiring-positive

## Once you've licensed them — what I do

Drop the `.mp3`s in `render-worker/music/` (and `webapp/public/music/`) and I'll: add each to `MUSIC_CATALOG`, and **measure each track's beat grid** so it works automatically with the new beat-timed transitions. Adding all 18 is ~30 min of wiring on my side.

## Before you ship — the one non-negotiable

Get the **redistribution + sublicensing** clause confirmed **in writing** from whichever provider you pick, specifically for "music embedded in videos our customers export and repost to social." This is the single thing that protects you and your users from strikes. I'm not a lawyer — for a business-critical clause like this, a 20-minute review with one is cheap insurance.
