# EstateMotion — Music Refresh Shopping List

**Source:** [Pixabay Music](https://pixabay.com/music/) — all tracks CC0, no attribution required, no account needed for download.

**Target dir:** `render-worker/music/`

**How the picker chooses:** `pickMusicUrl()` in `render-worker/src/runway-job.mjs` resolves by style:
`luxury → luxury.mp3`, `viral → viral.mp3` (also accepts `social.mp3`), `mls → mls.mp3`, `investor → investor.mp3`, fallback → `default.mp3`. Filenames must match exactly.

**What to look for in every pick:**
- 60–120 seconds (most listing videos run 30–90 sec; longer is fine, will be trimmed by `-shortest`)
- Loops or fades cleanly (the final ffmpeg pass uses `-shortest`, so an awkward last 5 seconds gets cut anyway — but no abrupt percussion endings)
- No vocals (narration goes on top)
- Mastered moderately loud — the pipeline already attenuates music to ~−9 dB

---

## 1. Luxury — `luxury.mp3`

**Vibe:** Slow cinematic build, piano-led, refined, restrained. Picture a $4M Scottsdale modern at golden hour.

**Search:** [pixabay.com/music/search/cinematic-ambient/](https://pixabay.com/music/search/cinematic-ambient/)

**Look for tags:** `cinematic`, `ambient`, `piano`, `emotional`, `luxury`

**Specific track types that work:** slow piano + ambient pad, sparse strings, no drums or drums very late, BPM 60–90.

**Avoid:** anything with a hard drop, hip-hop beats, vocals, marketing-jingle vibe.

---

## 2. Viral — `viral.mp3` (and also save a copy as `social.mp3`)

**Vibe:** Energetic, modern, beat-driven. TikTok / Instagram Reels pacing. Should make a millennial buyer stop scrolling.

**Search:** [pixabay.com/music/search/upbeat-hip-hop/](https://pixabay.com/music/search/upbeat-hip-hop/) or [pixabay.com/music/search/trap-beat/](https://pixabay.com/music/search/trap-beat/)

**Look for tags:** `hip-hop`, `trap`, `upbeat`, `electronic`, `energy`

**Specific track types that work:** trap-style 808s with melodic top line, lo-fi hip-hop with subtle energy, EDM build under 100 BPM with light drop, BPM 90–130.

**Avoid:** aggressive distortion, anything with rap vocals, songs that feel like background-only ambient with no rhythm.

**⚠️ Save twice:** rename your downloaded file to BOTH `viral.mp3` AND `social.mp3` (the picker treats them as aliases for legacy renders).

---

## 3. MLS Clean — `mls.mp3`

**Vibe:** Neutral, professional, unobtrusive. The track should not draw attention to itself. Think the music behind a Charles Schwab ad — present but invisible.

**Search:** [pixabay.com/music/search/corporate-background/](https://pixabay.com/music/search/corporate-background/) or [pixabay.com/music/search/uplifting-corporate/](https://pixabay.com/music/search/uplifting-corporate/)

**Look for tags:** `corporate`, `background`, `light`, `acoustic`, `inspiring`

**Specific track types that work:** light acoustic guitar + soft pad, minimal piano with brushed drums, uplifting corporate-pop instrumental, BPM 80–110.

**Avoid:** anything emotional or "cinematic" — MLS-compliant listings want the music to disappear. Skip any track that "tells a story."

---

## 4. Investor — `investor.mp3`

**Vibe:** Confident, moderate tempo, slightly corporate but not boring. The investor audience is sophisticated — narrator will be reading numbers. Music should support, not compete.

**Search:** [pixabay.com/music/search/corporate-motivational/](https://pixabay.com/music/search/corporate-motivational/) or [pixabay.com/music/search/inspirational-corporate/](https://pixabay.com/music/search/inspirational-corporate/)

**Look for tags:** `corporate`, `motivation`, `business`, `inspiring`, `success`

**Specific track types that work:** mid-tempo with confident piano + light percussion, modern minimalist with subtle build, BPM 90–120.

**Avoid:** anything that feels like a startup pitch reel. Skip overdriven synth leads. No "epic trailer" drops.

---

## 5. Default — `default.mp3`

**Vibe:** Most versatile fallback. Should work for *any* listing type. When in doubt, the picker reaches here.

**Search:** [pixabay.com/music/search/cinematic/](https://pixabay.com/music/search/cinematic/)

**Look for tags:** `cinematic`, `epic`, `ambient`, `inspiring`

**Specific track types that work:** the most universally cinematic-feeling track from your luxury search but slightly more anonymous — something that wouldn't feel weird under any photo. BPM 70–110.

**Avoid:** anything too specific to one genre (so no aggressive trap, no acoustic-folk, no orchestral score). This is the "safe bet."

---

## Drop-in checklist

After downloading all 5 files (saving viral.mp3 twice as `viral.mp3` + `social.mp3` = 6 files total):

```bash
cd ~/Documents/EstateMotion/render-worker/music
ls -la
# expect: luxury.mp3, viral.mp3, social.mp3, mls.mp3, investor.mp3, default.mp3
# (the existing files will be overwritten by your new ones)

# Optional: sanity-check duration + bitrate
for f in *.mp3; do
  echo "$f: $(ffprobe -v error -show_entries format=duration,bit_rate -of default=nw=1 "$f" | tr '\n' ' ')"
done
```

Tell me when the files are in place and I'll commit them with a clear message + push to origin (or you can push yourself):

```bash
cd ~/Documents/EstateMotion
git add render-worker/music/
git commit -m "Music refresh: replace bundled tracks with new Pixabay CC0 picks"
git push origin main
```

Render will redeploy with the new music. First test render with any style should now sound noticeably different.

---

## If a search shows nothing strong

Pixabay's catalog rotates. If none of the top results feel right for a given style, broaden the search:

- Luxury → try `ambient piano` or `cinematic emotional`
- Viral → try `tiktok beat` or `urban instrumental`
- MLS → try `light background` or `acoustic chill`
- Investor → try `business background` or `confident inspiring`
- Default → try `epic cinematic` or `inspirational background`

You can also filter by length (1:00–2:00) and mood directly on the Pixabay search page.
