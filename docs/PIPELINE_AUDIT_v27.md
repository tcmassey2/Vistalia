# EstateMotion — Render Pipeline & Mode Audit (v27)

June 19, 2026. Trigger: a $100 render hallucinated a videographer-on-a-tripod into
an empty room after switching to Modern Social / MLS Clean. At $100/video, zero
tolerance for this class of defect. This audit traces every prompt that reaches Veo,
every mode, and the guard/fallback logic, and fixes the systemic gaps.

## How a prompt reaches Veo (the actual data path)
`create-edit-plan.js` → for each scene `buildVeoPrompt()` assembles:
`motionClause + "Subject: <room>." + visibleClause + styleClause + roomClause`,
stored as `scene.veoPrompt`. The worker (`generateVeoSceneClip`) then either uses
`scene.veoPrompt` (cinematic path) OR, for risky scenes, **overrides** it with
`buildConstrainedVeoPrompt()`, and appends `VEO_FIDELITY_SUFFIX`. The guard
(`decideUseKenBurns`) decides cinematic vs constrained.

## Findings

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| 1 | 🔴 Critical | All Veo prompts | Camera-equipment + filming nouns ("Locked **tripod** shot", "Tripod-stable", "dolly", "slider", "documentary footage", "social-media reel") rendered **literally** by the Jan-2026 Veo 3.1 update (improved prompt adherence + human rendering) → a real videographer/tripod in the room. | ✅ Fixed `b6bdb96` |
| 2 | 🔴 Critical | Guard | **Ceiling fans in living rooms/bedrooms never hit the safe path.** Balanced threshold for non-kitchen rooms is risk ≥ 90; a living-room fan scores ~35–55 → went down the cinematic path where fans spin/morph. | ✅ Fixed (this pass) |
| 3 | 🟠 High | Prompt assembly | `visibleFeatures` (LLM-written, e.g. "ceiling fan", "chandelier", "sign") injected **positively** into the Veo prompt. It's image-to-video — Veo already sees the photo — so naming an animatable/text object invites it to animate or mangle it. | ✅ Fixed (this pass) |
| 4 | 🟡 Medium | Room constraints | `RUNWAY_ROOM_CONSTRAINTS` (injected into Veo prompts) use **negations naming failure-objects** ("NO new ceiling fans", "NO fan blades", "no microwave doors on the refrigerator"). Negations are unreliable on generative models and can *summon* the named object ("don't think of an elephant"). | ⚠️ Recommend test |
| 5 | 🟡 Medium | Fidelity suffix | `VEO_FIDELITY_SUFFIX` relies on the negation "No people". With the §1 triggers gone it should hold, but a positive "the space is empty and unoccupied" is more robust on a literal model. | ⚠️ Recommend |
| 6 | 🟢 Low | Narration | Per-scene lines hard-trimmed with no fades → abrupt cuts between scenes. | ✅ Fixed `9f8b7bf` |
| 7 | 🟢 Pass | Robustness | Retry-once-constrained → typed abort + **credit refund**; per-scene clip persistence; narration fail-soft (ships music-only, never errors); engine dispatch (runway→veo) with `VEO_PRODUCTION=false` rollback. Sound. | ✅ Verified |

## Per-mode review (what now reaches Veo)
- **Cinematic Luxury** — *the reference; was always clean.* "Editorial luxury real-estate **film**. Warm golden-hour light… 35mm lens feel." No shoot/equipment nouns. Untouched.
- **Modern Social** — was "social-media **reel**" (triggered a person filming). Rewritten to "Bright, contemporary real-estate **film**…". ✅
- **MLS Clean** — was "**documentary footage**" (triggered a crew). Rewritten to "Clean, accurate real-estate **film**…". ✅
- **Investor Tour** — was "walkthrough **documentation**… camera work". Rewritten to "Factual, neutral real-estate **film**…". ✅
- All four share the same (now noun-free) motion + constrained prompts.

## Fixes applied this pass
1. **Rotational objects force the safe path** (`decideUseKenBurns`): any scene whose features/prompt name a fan, ceiling fan, blade, pendant, chandelier, etc. is routed to the **constrained "nothing moves" prompt** (Veo) / Ken Burns (legacy) regardless of risk score, on `balanced` and `strict`. Closes the fan gap.
2. **`visibleFeatures` sanitized** (`buildVeoPrompt`): drops fan/chandelier/pendant/sign/text/clock/TV terms before naming elements to Veo. Keeps safe spatial anchors (sofa, windows, island).

Both are text/logic-light, additive, and strictly *safer* (more scenes get the locked prompt). Cinematic Luxury wording untouched. No change to render mechanics, stitching, upload, or credits.

## Recommend (test before changing — don't touch blindly)
- **#4 Room-constraint negations:** A/B a render with `RUNWAY_ROOM_CONSTRAINTS` trimmed to positive anchoring only ("keep every fixture exactly as photographed; nothing moves") vs the current negation-heavy text. The constrained path already protects the worst scenes, so the cinematic room-constraint negations are the most likely remaining backfire source.
- **#5 Fidelity suffix:** consider appending "The space is empty and unoccupied; no camera, crew, or equipment is present." (positive + explicit) — but verify it doesn't itself summon a camera via the negation. Test on 2–3 renders.

## Required smoke test (before agents touch it)
Run one render per mode, each including a **ceiling-fan room** and a **kitchen**:
1. Cinematic Luxury · 2. Modern Social · 3. MLS Clean · 4. Investor Tour.
Confirm per render: (a) **no people / tripods / crew** in any frame; (b) ceiling-fan
scene is static/locked (not spinning, not morphed); (c) kitchen appliances intact;
(d) narration smooth across scene cuts; (e) chosen voice (preset or clone) is heard.
Any failure → fix the scene in **Edit Studio** (re-render / auto Ken Burns) and note
the mode for a prompt follow-up.
