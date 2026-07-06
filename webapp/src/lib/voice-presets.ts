// Vistalia — voice preset slugs + clone derivation (client side).
//
// v34.7: branding.voiceId holds EITHER a preset slug OR a raw ElevenLabs
// cloned voice_id, and two different UIs (Settings VoiceSection, Project
// VoiceCloneCard) both write it. Before this file, each had its own copy
// of the slug list and its own idea of what "has a clone" means — and the
// Settings picker didn't know clones existed at all, so picking a preset
// silently destroyed the clone linkage and the Preview button became a
// silent no-op ("the voice clone is not playing back my voice").
//
// branding.clonedVoiceId (new, persisted) remembers the clone permanently;
// voiceId remains "whichever voice narrates the next render".

import type { AgentBranding } from "./types";

export const PRESET_VOICE_SLUGS = new Set([
  "luxury-warm", "luxury-male", "luxury-british",
  "viral-energetic", "viral-confident", "investor-deep", "mls-neutral"
]);

export function isPresetVoiceSlug(value: string | undefined | null): boolean {
  return !!value && PRESET_VOICE_SLUGS.has(value);
}

/** The user's cloned ElevenLabs voice id, or "" if they have none.
 *  Falls back to inferring from voiceId for brand kits saved before the
 *  clonedVoiceId field existed (any non-preset, non-empty voiceId is a
 *  raw ElevenLabs id — that's a clone). */
export function cloneVoiceIdOf(branding: AgentBranding): string {
  if (branding.clonedVoiceId) return branding.clonedVoiceId;
  const v = branding.voiceId || "";
  return v && !PRESET_VOICE_SLUGS.has(v) ? v : "";
}

export function cloneVoiceLabelOf(branding: AgentBranding): string {
  if (branding.clonedVoiceId && branding.clonedVoiceLabel) return branding.clonedVoiceLabel;
  const inferred = cloneVoiceIdOf(branding);
  return inferred ? (branding.voiceLabel || "Your voice") : "";
}
