// EstateMotion — V23 quality-feature kill switch.
//
// Set LEGACY_RENDER_MODE=true on the render-worker host to disable every
// v23 "quality upgrade" feature and restore the pre-v23 render behavior.
//
// What this disables when on:
//   - Photo preprocess (Sharp WB normalization + AI upscale + day-to-dusk)
//   - 3D LUT color grade (falls back to legacy math grade)
//   - Address card opener (3.5s prepended sequence)
//   - Transition SFX bus (whooshes/impacts at scene boundaries)
//   - Beat-aware Viral pacing
//   - MLS auto-strict guard upgrade
//   - v23.2 anti-hallucination prompt strengthening (worker uses what
//     came in the manifest from create-edit-plan; doesn't matter for
//     this side, but documented here for completeness)
//
// What STAYS ENABLED when legacy mode is on (these are bug fixes, not
// quality changes — must always run):
//   - Validation gate (ffprobe master before upload)
//   - Stitch heartbeat ping
//   - Voice narrator (the v23 fix that made it actually work)
//   - Per-scene engine tracking in audit log
//   - Render Quality Panel UI (display-only)
//   - 4K + Gen-4.5 hard block (it's an OOM trap regardless)
//   - Hallucination Guard's existing balanced/strict/off levels
//     (whatever the user explicitly set is honored — only the
//     auto-upgrade for MLS style is suppressed)
//
// Why a kill switch instead of a revert: lets Troy A/B compare the two
// modes by flipping ONE env var instead of two reverting two dozen
// commits. Once we know which v23 features actually help vs. hurt,
// we re-enable selectively (or remove them entirely).
//
// Default: LEGACY_RENDER_MODE unset → false → v23 features run.
// Set LEGACY_RENDER_MODE=true on Render.com to flip.

const RAW = String(process.env.LEGACY_RENDER_MODE || "").trim().toLowerCase();
const LEGACY = RAW === "true" || RAW === "1" || RAW === "yes";

if (LEGACY) {
  console.info("[legacy-mode] LEGACY_RENDER_MODE=true — v23 quality features disabled");
}

export function isLegacyRenderMode() {
  return LEGACY;
}

// Convenience: per-feature predicates so callers don't have to know
// the full v23 feature inventory. Each returns true when the feature
// should fire, false when it should be skipped.
export function shouldRunPhotoPreprocess() { return !LEGACY; }
export function shouldApplyV23LUT()         { return !LEGACY; }
export function shouldPrependAddressCard()  { return !LEGACY; }
export function shouldMixTransitionSfx()    { return !LEGACY; }
export function shouldSnapBeats()           { return !LEGACY; }
export function shouldAutoStrictMls()       { return !LEGACY; }
