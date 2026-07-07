# EstateMotion — Site-Wide UX/UI Revamp Plan

June 2026. The current UI carried the product through pre-production well —
it's competent, dark, on-brand. But it reads "indie dev tool," and we're now
asking strangers to pay $100 from a cold ad. The UI itself has to justify the
price. This plan scopes a revamp that does that **without blocking launch.**

## Honest audit of where we are

**Strengths to keep:** dark cinematic direction, gold accent (#C7A76C), the
review-and-approve concept, working component states (loading/empty/error on
Dashboard).

**What reads dated / pre-production:**
1. **Brand split.** Marketing site = Fraunces serif, cinematic. App = Inter,
   workspace-dashboard. A user crossing from ad → landing → app feels two
   different products. Premium products feel continuous.
2. **The product's own output isn't the hero.** We sell cinematic video, but
   the video is shown in small frames. The "wow" — a finished listing video —
   should dominate the screens that sell and deliver it.
3. **ProjectScreen is a 3,100-line monolith** of stacked form sections. It
   works but feels like a settings page, not a creative studio. The create
   flow should feel guided and cinematic, not like filling out a tax form.
4. **Inconsistent spacing, density, and component vocabulary** across screens
   (cards, buttons, inputs vary subtly). No single component system.
5. **Motion is minimal/ad-hoc.** A premium creative tool earns trust through
   considered micro-motion (transitions, the render-progress moment, the
   reveal). Right now it's mostly static.
6. **Mobile.** Agents live on phones; several screens are desktop-first with
   mobile as an afterthought.

## Design principles for the revamp

1. **The video is the hero.** Every conversion-critical screen leads with
   real product output at large scale. UI chrome recedes; the work shines.
2. **One brand, edge to edge.** Unify marketing + app into a single design
   system — same type, color, spacing, motion. Cinematic serif for moments,
   clean sans for work.
3. **Cinematic, not corporate.** Dark, filmic, gold-accented, generous
   negative space, restrained motion. It should feel like a film tool, because
   that's what justifies $100.
4. **Guided, not a form.** The create flow becomes a confident step-by-step
   studio, not a scroll of settings.
5. **Trust is a design feature.** MLS-safe / review-every-scene / free-regen
   should be visible, reassuring UI — not buried copy.
6. **Mobile-first.** Design every screen for the phone first.

## Priority order — by funnel impact, not by screen

Revamp where dollars are decided first; leave admin screens for last.

**Tier 1 — conversion surfaces (do first):**
- Landing page (`start.html` campaign LP + `index.html` homepage)
- Auth / signup (first in-app impression)
- The **finished-video reveal** (the wow moment that drives the first purchase)
- The **paywall** (the $100 decision)

**Tier 2 — the core loop:**
- Dashboard / library (where they return)
- ProjectScreen create flow (the studio experience) — also split the monolith

**Tier 3 — admin (last):**
- Settings, Brokerage, 2FA, modals

## Phasing (so it doesn't block the ad launch)

- **Phase 0 — design system first (do before any screen).** Lock tokens,
  type, spacing, component library, motion language. Everything else inherits
  it. Ship as a shared CSS/Tailwind layer used by both marketing and app.
- **Phase 1 — Tier 1 surfaces.** These move the ad-campaign needle; if the
  launch is imminent, the landing page + paywall + reveal are the only
  must-haves before spend.
- **Phase 2 — Tier 2 core loop.** Dashboard + create studio. Bigger lift
  (ProjectScreen refactor); do after launch traffic validates the funnel.
- **Phase 3 — Tier 3 admin.** Polish pass.

**Launch-timing call:** if ads go live next week, do **Phase 0 + Tier 1 only**
before launch (landing, auth, reveal, paywall), and run Phases 2–3 against
live traffic. Don't hold the campaign for a full-site redesign.

## How to execute
A complete design brief is in `UI_REVAMP_PROMPT.md` — usable to drive the
redesign via a design tool (v0 / Lovable / Figma AI), a contract designer, or
in-house build. It specifies the evolved design system, type, color, motion,
and screen-by-screen direction.

## Risk / guardrails
- Don't regress the working money-path or render flow during a visual revamp —
  re-verify checkout + render end-to-end after each phase.
- Keep the deploy green: the app is a live Vite build; land the revamp on a
  branch, not straight on main during launch week.
- Measure: instrument the landing → signup → paid funnel before the revamp so
  you can prove the redesign improved conversion, not just looks.
