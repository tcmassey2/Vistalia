# EstateMotion — Standout Ad Prompts (concept-driven)

The trap we just hit: a cinematic home tour *is* what the product outputs, so as an ad it
looks like every other listing in the feed — invisible. A scroll-stopping ad has to do
something the product itself never shows: the **transformation**, a **feed-aware contrast**,
or a **surreal concept**. The home is the payoff, never the whole ad.

Rules baked into every prompt below: hook lands in the first 1.5s; one clear idea; 9:16
vertical; ends on the EstateMotion logo + "first video free." Engine notes — use **Kling
or Veo** (`kling3_0_turbo` / `kling3_0` / veo) for cinematic concept spots; they render the
prompt literally with no forced presenter. **Avoid `marketing_studio_video`** for these —
it injects a UGC talking head.

> Highest-impact path: the **image-to-video** versions (★). Feed a real, slightly flat MLS
> listing photo as the *start frame* and let the model bring it to life on camera — that
> single move both stops the scroll AND demonstrates the product in one shot.

---

## 1. Transformation reveals — the hero genre (show the photo BECOME the video)

### ★ A1. "The photo wakes up"
*Why it stops the scroll:* opens on a boring static photo (looks like a mistake/dead post),
then it visibly comes alive — pattern interrupt + instant product demo.
**Model:** Kling/Veo **image-to-video**, start frame = a real flat MLS living-room photo.
**Prompt:** "Start on a completely still, flat real-estate listing photo of a living room. Hold for a beat as if it's a static image. Then a gentle ripple passes across the frame and the scene comes alive — sheer curtains begin to drift, warm sunlight shifts across the floor, dust motes float, and the camera slowly begins a smooth cinematic dolly forward into the room as if the photograph became a window. Warm filmic Kodak grade, shallow depth of field, anamorphic, no people. The transition from 'photo' to 'living film' should feel magical but real."

### A2. "Stack to estate"
*Why:* surreal assembly — photos physically build the home. Unmistakably an ad, not a tour.
**Model:** Kling/Veo text-to-video.
**Prompt:** "A neat stack of printed real-estate listing photos sits on a sunlit marble counter. A soft gust lifts them into the air; the photos swirl and assemble in midair into a glowing three-dimensional model of a luxury home. The camera flies through the assembled home — living room, kitchen, pool — as warm golden light pours through it, then the home gently collapses back into a single phone lying on the counter showing a finished cinematic video. Warm cinematic film grade, gold particles, anamorphic, no people, no hands."

### ★ A3. "Before / after wipe"
*Why:* the clearest possible value prop in 5 seconds.
**Model:** Kling **image-to-video**, start frame = the flat listing photo.
**Prompt:** "Vertical split that starts as one flat, dull, slightly underexposed MLS listing photo of a luxury living room. A clean vertical light-wipe sweeps left to right; everything behind the wipe transforms into the same room as rich cinematic motion video — warmer color, drifting curtains, gliding camera, glowing light. Left side 'before' stays a frozen photo; right side 'after' is alive. Filmic, elegant, no people."

---

## 2. Feed-aware pattern interrupts (be self-aware about the scroll)

### B1. "Mute vs. sound on"
*Why:* forces the unmute — a real Meta engagement signal — and nails the Reel-E contrast.
**Model:** Kling/Veo text-to-video (add the icon + VO in post if the model won't).
**Prompt:** "A cinematic luxury home tour plays but is visibly, awkwardly silent — a large grey muted-speaker icon sits in the corner and the color looks slightly flat and lifeless. At the 3-second mark a finger taps the screen; the muted icon switches to sound-on, the image instantly blooms into warm saturated color, light comes alive, and the camera glides forward with new energy. Text feel: 'Everyone else's listing videos are on mute.' Cinematic, vertical, no people in frame except the tapping fingertip at the edge."

### B2. "The thumb that stopped"
*Why:* literally dramatizes scrolling past competitors and stopping on you.
**Model:** Kling/Veo text-to-video.
**Prompt:** "POV of a phone feed scrolling fast past dull, static real-estate slideshow posts — flick, flick, flick — each one grey and forgettable. The scroll suddenly slows and stops on one post: a stunning cinematic luxury home tour gliding in warm golden light that fills the whole screen. The thumb lifts away. Hold on the beautiful living, breathing home. Vertical 9:16, realistic phone-feed framing, the only human element is a thumb at the bottom edge."

---

## 3. Surreal / visual-metaphor (the 'wait, what' scroll-stopper)

### C1. "Dive into the phone"
*Why:* AI-native impossible shot; turns 'tap to view' into a portal.
**Model:** Kling/Veo text-to-video.
**Prompt:** "Extreme close-up on a smartphone lying on a marble counter showing a small real-estate listing thumbnail. The camera rushes forward and dives INTO the phone screen, breaking through into the listing itself — now a full, life-sized cinematic luxury home that the camera flies through in one continuous sweep: foyer, living room, pool at golden hour. The shot pulls back out through the screen, landing on the phone again now showing a finished polished video. Seamless, dreamlike, warm filmic grade, no people, no hands."

### C2. "For-sale sign portal"
*Why:* surprise scale shift from a mundane object.
**Model:** Kling/Veo text-to-video.
**Prompt:** "Dusk. Extreme close-up on a classic 'FOR SALE' real-estate yard sign planted in a green lawn. The camera pushes slowly toward the sign and passes through it; on the other side the ordinary yard opens into a sweeping cinematic reveal of a glowing luxury estate at golden hour, camera craning up and over the property. Warm anamorphic film look, lens flare, deep negative space, no people."

---

## 4. Cost & voice concepts (sell the wedge, not the house)

### D1. "Invoice to gold dust"
*Why:* concept-led cost contrast; bold, not boring b-roll.
**Model:** Kling/Veo text-to-video.
**Prompt:** "A printed invoice on a marble kitchen counter reads 'VIDEOGRAPHER — $1,200' in clean type. Warm light creeps across it; the paper dissolves from the edges into fine glowing gold dust that lifts and swirls outward, and as it scatters the kitchen around it blooms into a warm cinematic moving scene — light shifting, the camera gliding forward. End on clean negative space for a logo. Premium, filmic, no people, no hands."

### D2. "The voice that fills the room"
*Why:* visualizes the own-voice wedge instead of just stating it.
**Model:** Kling/Veo text-to-video (drop the real VO + waveform in post).
**Prompt:** "A quiet, beautiful empty luxury living room at golden hour, completely still and silent. A soft glowing sound-wave ripple enters from the edge of frame and moves through the space; everywhere it passes, the room warms and comes alive — curtains stir, light blooms, the camera begins to glide as if guided by the voice. The home feels narrated to life. Warm cinematic grade, elegant, no people, no text."

---

## How to run these
- Cinematic ones: `kling3_0_turbo` (fast, ~22 credits) or `kling3_0` / veo for top quality.
- The ★ image-to-video ones: pass a real flat listing photo as the **start frame** — that's
  what makes the transformation read as *your product*, and it's the strongest set.
- These render **silent**; add the VO line + a music bed + the logo end-card in post (we can
  reuse the own-voice / "first video free" lines).
- Test plan: pick 2–3, run them, then run the winners through Higgsfield's `virality_predictor`
  before putting spend behind them.

## My top 3 to produce first
1. **A1 "The photo wakes up"** (★ image-to-video) — best demo + scroll-stopper in one.
2. **B1 "Mute vs. sound on"** — forces engagement, kills the silent-reel competitor.
3. **C1 "Dive into the phone"** — the most thumb-stopping, unmistakably an ad.
