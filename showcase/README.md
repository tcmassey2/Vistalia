# Showcase video assets

The landing page expects MP4 files at the paths below. Until they're present,
the page falls back to gold-gradient placeholders that look intentional rather
than broken.

## Your current source assignments (Pexels, all CC0)

| Filename | Source | Pexels page | Slot |
| --- | --- | --- | --- |
| `hero-reel.mp4` | Logan Voss | [Aerial view of Scottsdale mountains at sunrise (30910241)](https://www.pexels.com/video/aerial-view-of-scottsdale-mountains-at-sunrise-30910241/) | Hero showcase (16:10 cinematic) |
| `style-luxury.mp4` | Logan Voss | [Aerial Scottsdale serene mountain neighborhoods (34983649)](https://www.pexels.com/video/aerial-view-of-scottsdale-s-serene-mountain-neighborhoods-34983649/) | Style card: Cinematic Luxury |
| `style-social.mp4` | Advancer Drones | [Aerial view of a building with a pool (19698409)](https://www.pexels.com/video/an-aerial-view-of-a-building-with-a-pool-19698409/) | Style card: Modern Social |
| `style-mls.mp4` | Advancer Drones | [Cardone Capital (19698410)](https://www.pexels.com/video/cardone-capital-19698410/) | Style card: MLS Clean |
| `style-investor.mp4` | Advancer Drones | [Arizona State football stadium (20072762)](https://www.pexels.com/video/arizona-state-football-stadium-20072762/) | Style card: Investor Tour *(placeholder — swap for an actual investment-property aerial when you find one)* |
| `hero-poster.jpg` | (any) | First frame of `hero-reel.mp4` | Poster shown while hero video loads |

## Download steps (per file)

1. Open the Pexels page from the table above
2. Click **Free Download** (top right of the video player)
3. Choose **HD 1920×1080** for fast load. (4K available; bigger files = slower page.)
4. Save the file
5. Rename to the exact filename in the table (e.g. `hero-reel.mp4`)
6. Move it to `/Users/troymassey/Documents/EstateMotion/showcase/`

When all six are in place:

```bash
cd ~/Documents/EstateMotion
git add showcase/
git commit -m "Add Pexels showcase video assets"
git push
```

## Generating the hero poster (optional but recommended)

A poster image shows while the hero video downloads. To generate one from the
hero reel:

```bash
brew install ffmpeg            # one-time, if not installed
cd ~/Documents/EstateMotion/showcase
ffmpeg -i hero-reel.mp4 -ss 00:00:01 -vframes 1 -q:v 3 hero-poster.jpg
```

That extracts a frame from 1 second in. Skip if you don't want to bother — the
fallback gradient still looks polished.

## Future swaps

The two slot assignments most likely to need replacement:
- **`style-investor.mp4`** — ASU stadium isn't a listing. Swap when you find an actual
  investment-property aerial (multifamily, commercial, etc.).
- **`hero-reel.mp4`** — once you have a real EstateMotion render that looks
  great, replace this with that. The aerial Scottsdale shot is a placeholder
  for "what the product helps agents make," not a render of the product itself.
