# Seedance 2.0 Ad Prompts — problem-first, founder-free

Built for Seedance 2.0's actual capabilities (Feb 2026): 4–15s clips,
1080p, 9:16 native, multimodal references (up to 9 images + 3 videos +
3 audio via @-tags), native audio incl. dialogue, beat-aware sync.
Run on Dreamina or CapCut. One 15s generation = the whole ad body —
no clip stitching like the Higgsfield workflow.

House rules (learned the hard way):
- Market the PROBLEM, not the features. The product appears only as
  the thing the characters want.
- No founder, no fake-founder presenter. Characters acting a story: fine.
- NO readable screen UI in-gen — models garble interface text (the
  Higgsfield "Seller Is Watching" turn clip died this way). Phones and
  tablets appear at oblique angles with glare; motion readable, text not.
- No burned-in text in the generation. Captions + Vistalia end card get
  added in OUR pipeline afterward (brand-consistent, word-synced).
- 2s hook. Vertical framing head-to-waist. Kitchen-table realism, not ad
  gloss — Seedance 2.0's physics realism is the whole reason to use it.

## Upload set (before prompting)

| Tag | File | Role |
|---|---|---|
| @Video1 | showcase/example-luxury.mp4 (first 8s) | "the good video" the characters react to — real Vistalia output guides what plays on the tablet |
| @Video2 | showcase/style-mls.mp4 | the boring slideshow reference — generic pan drift for the phone in the hook |
| @Audio1 | audio ripped from marketing/ads/vistalia-ad-hero-15s.mp4 (`ffmpeg -i vistalia-ad-hero-15s.mp4 -vn -c:a aac hero-track.m4a`) | score reference for the swell at the turn |

Images optional; if character consistency drifts across re-rolls, add a
clean portrait as @Image1 and tag her "the seller."

---

## CONCEPT A — "That's it?" (master prompt, 15s, 9:16, 1080p)

> Vertical 9:16, photorealistic, warm domestic realism, shallow depth of
> field, single continuous evening scene in a lived-in kitchen. Natural
> tungsten light, faint dishwasher hum ambience.
>
> 0–2s: Close on a woman in her 60s at the kitchen table at night,
> reading glasses, holding her phone at an oblique angle — screen shows
> a real-estate photo slideshow drifting with slow pans, motion guided by
> @Video2, glare across the glass so no text is readable. Her face:
> polite disappointment. Slow push-in.
>
> 2–6s: She lowers the phone to the table and slides it across to her
> husband. She says, quietly, hurt: "That's it? That's our house?" He
> looks at the phone, says nothing. The slideshow keeps drifting between
> them. Ambient clock tick.
>
> 6–11s: He turns his tablet around to face her — on it, a listing video
> plays: cinematic, moving light, warm dusk exterior, motion and look
> guided by @Video1, held at a slight angle with screen glare, no
> readable text. Camera orbits gently around her as she leans in; her
> expression turns from hurt to lit-up. Score rises here, guided by
> @Audio1 — quiet piano into a warm swell, beat-synced to the lean-in.
>
> 11–15s: Over her shoulder: she picks her phone back up, opens a
> message thread (screen oblique, unreadable), thumbs hovering, and
> starts typing fast. Hold on the determined typing hands. Score
> resolves on one sustained note. No on-screen text, no logos anywhere.

Post: our end card ("Sellers choose the agent with the better video" →
vistalia.ai) + luxury-skin captions on the dialogue line, via the
existing ffmpeg end-card/caption pipeline. The dialogue line doubles as
the ad's primary text: *"That's it? That's our house?" — your seller,
tonight.*

Why this one first: the character speaks the problem in the seller's own
words — the exact fear (seller disappointment, losing the next listing)
the UGC ad monetizes at $3/lead, from a new angle Meta hasn't fatigued.

---

## CONCEPT B — "9:04 PM" (15s alternate)

> Vertical 9:16, photorealistic. A home office at night, one desk lamp.
> An exhausted agent (40s, blazer over a t-shirt) drags photos around a
> laptop editing timeline — screen oblique, glare, unreadable. On the
> couch behind her, a kid asleep under a blanket. 0–2s: push-in on her
> rubbing her eyes. 2–7s: her phone lights the desk; she glances — a
> rival agent's listing video autoplays muted, cinematic motion guided by
> @Video1, held at an angle. 7–12s: she looks from the phone to her
> timeline and back. She closes the laptop lid halfway, slowly. 12–15s:
> close on her face deciding something; she picks up the phone. Quiet
> score, guided by @Audio1, single swell at the laptop-close. No readable
> text, no logos.

Post text: *She's editing. Her competitor already posted. — vistalia.ai*

## CONCEPT C — "Three Days Dark" (15s alternate)

> Vertical 9:16, photorealistic. 0–3s: dusk, a FOR SALE sign in front of
> a beautiful home, wind in the trees, no people — a listing sitting
> dark. Speakerphone voicemail audio, natural male voice: "Hey, got your
> message — earliest I can shoot is Thursday." 3–8s: series of matched
> dusk-to-night time passes on the same sign, physics-real light change,
> guided gentle push-in each pass. 8–15s: inside the dark house, a phone
> on the kitchen counter lights up alone: a listing video playing,
> motion guided by @Video1, oblique angle, its glow filling the empty
> room. Score from @Audio1 builds from silence. No readable text.

Post text: *Your listing shouldn't wait for Thursday. — video tonight,
from the photos you already have.*

---

Notes: Dreamina/CapCut exports carry C2PA provenance metadata (fine for
Meta; it's invisible). Check the plan tier for visible watermarks before
cutting the final. Seedance 2.5 (early July) does 30s single-gens if we
ever want hook+story+end-card in one pass — 2.0's 15s + our own post
pipeline keeps the brand elements ours, so start here.
