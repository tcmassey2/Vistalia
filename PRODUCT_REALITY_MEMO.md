# EstateMotion — Product Reality Memo

**Author:** Claude (working honestly, not selling)
**Date:** May 17, 2026
**For:** Troy
**Length:** ~1 page, read time ~5 min

---

## What we're actually shipping right now

EstateMotion is a Runway-first pipeline. A user uploads 24 listing photos, an OpenAI Vision model curates and orders them, GPT writes an edit plan with per-scene narration and camera motion, Runway Gen-4 Turbo or Gen-4.5 turns each photo into a ~3-5s clip, we stitch them with hard cuts (crossfades OOM the worker), ElevenLabs reads the narration, music ducks under voice, ffmpeg color-grades and ships.

When it works, it's a 60-second cinematic listing video for ~$0.80 of compute. When it doesn't, it ships hard-cut shaky drift that looks worse than the photos it started from.

We have shipped 92 task-list items. The product has gotten worse, not better, since the v23 quality push. That's not because the work was sloppy — it's because we're fighting a fundamental limitation of the underlying models.

## What Runway Gen-4 can and cannot do on real estate photos

**Can do well:** tight crops on textured surfaces (carpet, wood, fabric, stone), exterior architecture with minimal moving content, twilight conversions when the photo is already strong, slow push-ins on a single hero object.

**Cannot do reliably:** kitchens (appliances morph mid-clip, fans appear on ceilings, microwaves grow handles), bathrooms (mirrors liquefy, fixtures distort), wide interior shots with strong horizon lines (ceiling lines bow), anything with text or signage (hallucinated typography), windows with outdoor views (glass becomes water). On stills, it almost always introduces a low-frequency shake or sideways drift — that's the model's prior pulling toward motion that doesn't belong.

We have a Hallucination Guard that risk-scores per room. On "strict" it falls back to Ken Burns for about 40% of typical listings. On "balanced" about 15%. The fallback is silent — users see a finished video and don't know which scenes were AI-rendered vs camera-moved. When 12 of 24 scenes fell back, the render legitimately *does* look mostly like Ken Burns.

There is no prompt that fixes the kitchen problem. There is no setting that fixes the shake. These are inherent to the model on this content type.

## What ElevenLabs can and cannot do

**Can:** synthesize 3-8s per line, multiple voices, style/emotion controls, multilingual. Per-line costs are negligible.

**Cannot reliably:** sustain 24 parallel synth calls without occasional 502s, hit consistent pacing on long sentences with sparse punctuation, sound natural on numerical content like prices and square footage without aggressive SSML tuning.

The "voice only works for the first 5 seconds" bug you're hitting is one of three things: the edit plan only put `narrationLine` on scene 1, one parallel synth is failing and killing the whole step, or the master video duration mismatches the narration track and `-shortest` is chopping it. That one is a real bug, fixable, but I can't diagnose without a failed render's logs.

## Where competitors actually win

The competition isn't AI-cinematic video tools. We're all stuck on the same hallucination problem. The competition that *ships* is split two ways.

**Reliable slideshow tools** (Aryeo, Spiro, BombBomb): traditional photo slideshows with music, voiceover, brand overlay. Boring but consistent. Real estate agents already use them. They charge $20-50/month. They don't crash, don't hallucinate, don't disappoint.

**Human-edited video services** (BoxBrownie, VHT Studios, Vyzer): a human editor cuts the video using stock footage, the agent's photos, music, voiceover. 24-48hr turnaround, $150-300 per video. They win on quality because a human filters out the bad frames. We can't compete on quality, only on speed and price.

The "AI cinematic" category (us, Listing AI, a handful of Restb.ai derivatives) is uniformly mediocre right now because the models aren't there yet.

## Three honest paths

**Path A — Reposition as "Polished Listing Video, 30 Seconds"**
Default the pipeline to Ken Burns with great pacing, smooth crossfades, working narration, color grade, brand overlay. Move Runway to an opt-in "Try AI motion" button per scene. Compete with Aryeo on quality of motion design and speed. Lose the AI marketing angle. Wins: ships today, predictable output, lower compute cost, real differentiation on speed and brand kit. Loses: not "AI."

**Path B — "Smart Cinematic" with honest disclosure**
Auto-route per scene based on room type and risk: exteriors, twilights, low-risk interiors get Runway; kitchens, baths, wides get polished Ken Burns. Surface engine-used per scene in the UI. Add a "12 scenes AI-rendered, 12 scenes camera motion" line on the player. Honest, fast, uses each engine where it actually works. Wins: best per-scene output, no surprises. Loses: more pipeline complexity, slightly slower renders.

**Path C — Pivot to "Tools, Not Final Render"**
Stop being a renderer. Become photo preprocessor + edit plan generator + Premiere / CapCut / Final Cut project file exporter. Agents upload, we output a `.prproj` or `.fcpxml` they can hand to their editor or post directly. Optionally, render a draft for quick listings. Wins: leverages AI for what it's actually good at (planning, photo enhancement, voiceover script), gives agents control, no shake/hallucination problem. Loses: bigger product shift, requires partnerships or tutorial content.

## My recommendation

**Ship Path A this week.** It's the only path that produces a video Troy doesn't hate without depending on Runway getting better.

**Build Path B over the next month.** Once Path A is the reliable default and you're not embarrassed by what users see, layer per-scene smart routing back in. This is where the AI story comes back, but honestly.

**Park Path C unless A and B don't get traction in 60 days.** It's a bigger bet and you've already built infrastructure for video output.

The pattern I keep hitting is: every quality feature I add to make Runway look better introduces a bug, and every revert I do to fix the bug strips the polish. The way out of that loop is to stop trying to make Runway carry the product and let it be a feature instead of the foundation.

---

**What I need from you to start executing:**
- Pick one of A / B / C, or tell me what's missing from this read.
- If A: I'll make Ken Burns motion cinematic (slower zoom, smooth easing, no shake), bring back memory-safe crossfades, fix the voice bug, ship as default. Runway becomes per-scene opt-in.
- If B: I'll start with A's polish work, then add the auto-router and disclosure UI on top.
- If C: I'll write a separate spec document and an outreach plan to one or two NLE partner candidates.

No more code changes until you point.
