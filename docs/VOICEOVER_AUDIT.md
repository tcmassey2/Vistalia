# EstateMotion — Voiceover Reliability Audit

June 2026. Trigger: real market demand (title companies selling "listing videos
in your own voice"). The voiceover has historically felt unreliable — "voice
only works for the first 5 seconds." This audit found the root cause and
hardened the path.

## Root cause of "voice stops after 5 seconds" (FIXED)

The narration mixer positions each line by computing scene start times from
`scene.duration`. The Veo render path was tagging scenes with **Ken-Burns-era
durations (~2.8s)** in the plan while the **actual Veo clips are 6s** (the
v26.9 scene-count bug). Result: the mixer built a narration timeline ~half the
length of the real video, cramming every line into the first ~14s of a 30s
video and leaving the rest silent. That *is* the "voice stops early" bug.

Fixed two ways:
1. **v26.9 render sweep** — Veo scenes now correctly tagged 6s, so plan
   duration matches the rendered clip.
2. **Actual-clip-duration hardening (this pass)** — the mixer now receives the
   *real* rendered duration per scene (keyed by photoId) and times narration
   off that, not the plan's stated value. Even if the two ever drift again,
   narration stays in sync. This is the durable fix.

## What was already solid (verified, no change needed)
- **Per-scene narration:** the edit plan writes a narration line on *every*
  scene (not just scene 1 — an old failure mode). `includeNarration` defaults on.
- **Fail-soft synthesis:** ElevenLabs calls run 4-parallel with per-line
  try/catch — one failed line no longer kills the whole step. If all fail, the
  video ships music-only rather than erroring.
- **Cloned voice flow:** a user's cloned voice (`brandKit.voiceId`) threads
  from the clone step → manifest → mixer correctly; falls back to a default
  voice if none set.
- **Music ducking + bounded scheduling:** music ducks under voice; narration
  is hard-capped to its scene window (can't bleed into the next scene); no
  narration over the outro card.

## Operational checks (verify on the Render worker — not code)
1. **`ELEVENLABS_API_KEY` must be set on the worker.** If it's missing,
   narration silently no-ops and every render ships music-only — which would
   read as "voice never works." This is the #1 thing to confirm.
2. **ElevenLabs plan tier.** Instant Voice Clone (the "your own voice"
   feature) requires the **Creator ($22/mo)** tier or higher. On Free/Starter,
   cloning fails. `GET /api/clone-voice?diagnose=1` reports the account tier
   and whether IVC is available.

## Recommended next (not blocking)
- **Surface the reason when narration no-ops.** Today it silently ships
  music-only with `narrationApplied:false` + a reason string the user never
  sees. Show it in the UI so "no voice" is explained, not mysterious.
- **Voice model:** currently `eleven_turbo_v2_5` (fast, reliable, good). For
  premium cloned-voice quality you could A/B `eleven_multilingual_v2`, but
  turbo is the right default for reliability + speed.
- **A "preview your voice on this listing" button** before full render — lets
  the agent confirm the clone sounds right, which is the trust moment that
  sells the feature the title companies are pitching.
