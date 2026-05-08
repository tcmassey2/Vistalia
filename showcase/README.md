# Showcase video assets

The landing page is currently designed around a single hero preview slot,
not a library of stock drone footage. To activate the hero video on the
homepage:

## Drop in your demo render

1. Render a real listing through EstateMotion that you're proud of.
2. Save the vertical 9:16 (1080×1920) MP4 here as **`preview.mp4`**.
3. Optionally generate a poster image:

   ```bash
   ffmpeg -i preview.mp4 -ss 00:00:01 -vframes 1 -q:v 3 preview-poster.jpg
   ```

4. `git add showcase/preview.mp4 showcase/preview-poster.jpg && git push`.

The homepage's hero slot has `<video src="/showcase/preview.mp4">` waiting
for it. The placeholder content auto-hides as soon as the video element
fires `loadeddata`. No code change needed — drop the file, push, done.

## Why no stock footage anymore

Earlier versions of the landing page leaned on Pexels drone footage as
filler so the page didn't feel empty. That's been removed. The current
design treats the preview slot as a deliberate, intentional placeholder
("Coming this week") so the homepage looks confident even before there's
a real render to show — and the moment one exists, it slots straight in.

## Style cards

The four style cards (Cinematic Luxury, Modern Social, MLS Clean, Investor
Tour) used to autoplay per-style stock videos too. They now use CSS-only
gradient panels — distinct color palettes per style, no asset dependencies.
If we ever want per-style demo reels, the slot is in `index.html` —
swap each `.style-card-art` block for a `<video>` element.
