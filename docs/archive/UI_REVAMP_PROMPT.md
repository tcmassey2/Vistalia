# EstateMotion — UI Revamp Design Brief / Prompt

A complete, hand-off-ready brief. Usable as a prompt for a design tool
(v0, Lovable, Figma AI), a brief for a contract designer, or an in-house spec.
Paste the relevant section to scope a single screen, or the whole thing for a
full redesign.

---

## 0. The product in one line
EstateMotion turns a real estate agent's listing photos into a cinematic
30-second vertical video in ~3 minutes. They pay per video ($100, or less in
packs). The first video is free.

## 1. Brand & feeling
**Cinematic, premium, filmic — a tool a professional pays for.** Think A24 /
Apple TV product page, not SaaS dashboard. Dark, confident, generous space,
the agent's video footage doing the visual heavy lifting. Warmth from a single
gold accent. Calm, not busy. Every screen should make a $100 price feel obvious.

Tone of voice: direct, confident, plain-spoken to a busy agent. No hype, no
jargon. "Your first video is free. Three minutes." not "Revolutionize your
real estate marketing with AI."

## 2. Design system (evolve the current one — keep what works)

**Color (dark, filmic):**
- Background: near-black, layered. `#0B0B0D` base → `#131317` raised → `#1A1A20` surface.
- Ink: `#F4F2EC` primary, `#C2C2BC` soft, `#88888E` muted, `#56565C` dim.
- Accent: gold `#C7A76C` (primary), `#DBBE7E` light, `#9C773B` deep. Use
  sparingly — for CTAs, key highlights, the "live" pulse. Never flood it.
- Edges: hairline borders `#26262C`, strong `#3A3A42`. 1px, low-contrast.
- Status: success `#5BBE9B`, danger `#E26B6B` — desaturated, filmic.

**Typography (unify marketing + app):**
- Display / moments: **Fraunces** (serif) — headlines, the reveal, hero
  numbers. This is the cinematic signature; bring it into the app too.
- Body / UI / work: **Inter** — everything functional.
- Mono: **JetBrains Mono** — labels, eyebrows, metadata, timestamps (used as
  small uppercase tracked-out eyebrows, e.g. "AI CINEMATIC · 9:16").
- Generous scale and line-height; let headlines breathe. Tight letter-spacing
  on display (-0.02em).

**Space & layout:**
- Generous. 8px base grid; sections breathe with 64–96px vertical rhythm on
  marketing, 24–32px in-app.
- Max content width ~1080px; the video reveal can go edge-to-edge.
- Rounded corners: 16–24px on cards/modals, 12px on buttons/inputs. Soft, premium.

**Motion (this is where premium is earned):**
- Easing `cubic-bezier(0.16, 1, 0.3, 1)`, 200–400ms. Nothing snappy/abrupt.
- Page/section entrances: subtle fade + 8px rise.
- The render-progress moment and the finished-video reveal get bespoke,
  considered motion (see screens below). Everything else is restrained.
- Respect `prefers-reduced-motion`.

**Components (build one library, use everywhere):**
- Buttons: primary (gold gradient, dark text), secondary (hairline ghost),
  sizes sm/md/lg. One consistent press/hover micro-motion.
- Cards: surface bg, hairline border, 16–24px radius, hover lift on interactive.
- Inputs: surface-input bg, hairline border, gold focus ring, generous height (44px+).
- Modals: dialog role, focus trap, backdrop blur, entrance motion.
- Badges/pills, toasts, progress bar, empty/loading/error states — all unified.

## 3. Screen-by-screen direction

### Landing page (homepage + campaign LP) — Tier 1
- Hero: oversized Fraunces headline + a **large, autoplaying real listing video**
  (the actual product output) as the centerpiece — not a mockup. One CTA:
  "Get your first video free." Mono eyebrow above.
- Before/after: a scrubber or hard cut from static MLS photo → cinematic video.
  This is the highest-converting module — make it the visual anchor.
- Pricing: the pay-per-video ladder ($100 / $375 / $650) as three clean cards,
  5-pack featured. "No subscription" stated plainly.
- Trust band: MLS-safe · review every scene · 3 minutes · first one free.
- Honest hallucination FAQ (review + free regen) as a trust feature.

### Auth / signup — Tier 1
- Minimal, cinematic, single-column, video or filmic still behind. The signup
  should feel like entering a studio, not a form. hCaptcha unobtrusive.
- One promise repeated: "Your first video is free."

### Finished-video reveal — Tier 1 (the wow moment)
- When a render completes, the finished vertical video takes over the screen,
  large, autoplaying, beautifully framed (phone-style 9:16 frame with soft
  glow). Fraunces headline: "Your video's ready." Considered reveal motion.
- Below: download (all formats), regenerate-a-scene, and — for trial users —
  the paywall nudge to make the next one. This screen sells the second purchase.

### Paywall — Tier 1 (the $100 decision)
- Three pack cards (single / 5-pack featured / 10-pack), pay-per-video, credits
  never expire. Calm, confident, not pushy. Reassure: free regen, MLS-safe.
- It should feel like a natural next step after the reveal, not a wall.

### Dashboard / library — Tier 2
- The library of finished videos is the hero: a clean grid of large video
  thumbnails (the work), not a data table. Hover = preview. Prominent
  "New video" CTA. Credit balance visible.
- Strong empty state (already decent) → make it cinematic.

### Create flow (ProjectScreen) — Tier 2 (also split the 3,100-line monolith)
- Reframe from "form" to "guided studio": a confident stepped flow —
  (1) photos, (2) style, (3) details/branding, (4) review & generate.
- Photo upload: large, tactile drag-grid with reorder. Style picker: visual
  cards showing the look, not radio buttons. Generate: one bold moment.
- Render progress: cinematic — big percentage in Fraunces, phase text with
  `aria-live`, a filmic progress bar, calm. (This already exists; elevate it.)
- The single Veo engine + free length toggle; no engine/safety controls.

### Settings / Brokerage / modals — Tier 3
- Clean, calm, consistent with the system. Lower visual priority; just make
  them coherent with the new components. Settings shows credit balance + buy.

## 4. Responsive & accessibility (non-negotiable)
- **Mobile-first** — agents are on phones. Every screen designed for ~390px
  first, scaled up. Tap targets 44px+.
- WCAG AA contrast. Dialog roles + focus traps on modals. `aria-live` on
  render progress. Visible focus states. `prefers-reduced-motion` honored.
- Real loading / empty / error states for every async surface.

## 5. Explicit do / don't
**Do:** let real listing videos carry the visuals · one gold accent, used
sparingly · generous negative space · Fraunces for moments, Inter for work ·
restrained, considered motion · mobile-first · state the honest trust story.

**Don't:** stock photography of "happy realtors" · multiple accent colors ·
dense dashboard chrome · gradients-everywhere · hype copy · subscription
language (we're pay-per-video) · any "Quick Reel / Runway / Cinematic AI tier"
legacy naming · autoplaying audio.

## 6. Deliverables expected from this brief
1. A locked design system (tokens, type, components) as a shared Tailwind/CSS layer.
2. High-fidelity designs for Tier-1 screens first (landing, auth, reveal, paywall).
3. Then Tier 2 (dashboard, create studio), then Tier 3.
4. Mobile + desktop for each.

## 7. Technical constraints (for an implementer)
- App is Vite + React + TypeScript + Tailwind; marketing is static HTML/CSS.
  The shared design system must work for both.
- Keep the money-path (Stripe checkout, credit packs) and render flow intact —
  this is a visual/UX revamp, not a logic change. Re-verify both after build.
- Land on a branch; don't redesign on main during launch week.
