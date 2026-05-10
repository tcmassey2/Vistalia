# EstateMotion music library

Background music tracks for the four style packs. The render worker reads
them automatically — drop the files here with the right filenames and
they're picked up on the next render. No code change needed.

## Required filenames

The worker looks for these exact names. MP3 or M4A both work.

| File | Used when style is | Mood | Length |
|---|---|---|---|
| `luxury.mp3` | Cinematic Luxury (default) | Slow, editorial, premium | 2-3 min loopable |
| `social.mp3` | Modern Social | Upbeat, modern, scroll-stopping | 1-2 min |
| `mls.mp3` | MLS Clean | Neutral, ambient, instrumental | 2-3 min |
| `investor.mp3` | Investor Tour | Confident, minimal, business | 2-3 min |

## Curated recommendations from Pixabay (CC0, no attribution required)

All tracks below are royalty-free for commercial use. No attribution needed.
Open each link, click **Download**, save with the filename above, drop into
this folder, commit, push.

### luxury.mp3 — slow, editorial, premium feel

Best fit for $1M+ listings, luxury condos, custom builds. The brand voice
is "you've arrived." Soft piano + ambient strings.

Search Pixabay for these and pick the one that fits your ear:

- **"cinematic piano"** — pixabay.com/music/search/cinematic%20piano
- **"emotional cinematic"** — pixabay.com/music/search/emotional%20cinematic
- **"luxury background"** — pixabay.com/music/search/luxury%20background

Recommended specific tracks (search by name):
- "Lifelike" by EatTheCake
- "Cinematic Documentary" by Lexin_Music
- "Inspiring Cinematic Ambient" by Lexin_Music

### social.mp3 — fast, modern, Reels-ready

Best fit for first-time-buyer listings, urban condos, anything posted on
Instagram Reels or TikTok. Punchy, percussive, modern.

Search Pixabay for:

- **"upbeat real estate"** — pixabay.com/music/search/upbeat%20real%20estate
- **"lo fi hip hop"** — pixabay.com/music/search/lo%20fi%20hip%20hop
- **"trendy upbeat"** — pixabay.com/music/search/trendy%20upbeat

Recommended specific tracks:
- "Once In Paris" by Pumpupthemind
- "Lo-Fi Beat" by SergeQuadrado
- "Whip" by Coma-Media

### mls.mp3 — neutral, broker-compliant, factual

For straight-up MLS-style walkthroughs. Doesn't compete with narration.
Restrained, almost ambient.

Search Pixabay for:

- **"corporate background"** — pixabay.com/music/search/corporate%20background
- **"minimal ambient"** — pixabay.com/music/search/minimal%20ambient
- **"professional background"** — pixabay.com/music/search/professional%20background

Recommended specific tracks:
- "Corporate Inspiring" by AudioCoffee
- "Minimal Documentary" by Music_Unlimited
- "Soft Background" by SergeQuadrado

### investor.mp3 — confident, direct, deal-flow

For wholesale / investor / commercial listings. Confident pacing,
business-friendly, no schmaltz.

Search Pixabay for:

- **"business background"** — pixabay.com/music/search/business%20background
- **"confident corporate"** — pixabay.com/music/search/confident%20corporate
- **"motivational business"** — pixabay.com/music/search/motivational%20business

Recommended specific tracks:
- "Inspiring Corporate" by Music_Unlimited
- "Modern Business" by Lexin_Music
- "Powerful Inspiring" by Pumpupthemind

## Workflow per track

1. Open the Pixabay link
2. Hit **Download** (no signup required for CC0 tracks)
3. Rename the downloaded file to the required filename (e.g. `luxury.mp3`)
4. Drop it into this `/render-worker/music/` folder
5. `git add render-worker/music/luxury.mp3 && git commit -m "Add luxury music track" && git push`
6. Render auto-deploys; next render uses it

## Why bundle these in the repo instead of streaming from a URL?

- **Reliability**: a bundled file can never 404 mid-render the way an external URL can.
- **Speed**: ffmpeg reads the file off disk, no download step inside the render.
- **Offline**: works even if Pixabay/SoundCloud has an outage.
- **Cost**: no CDN egress charges.

The MP3 files for all 4 styles total roughly 8-12MB. Negligible repo size.

## Music selection rules

The `pickMusicUrl` function in `runway-job.mjs` picks the slot based on
the manifest's `selectedStyle` (or `musicMood` legacy field):

- "Cinematic Luxury" / unrecognized → `luxury.mp3`
- "Modern Social" / "viral" / "upbeat" → `social.mp3`
- "MLS Clean" / "ambient" → `mls.mp3`
- "Investor Tour" / "minimal" → `investor.mp3`

You can preview which slot a render will use by checking `manifest.musicMood`
in the worker logs.
