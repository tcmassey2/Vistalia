// Vistalia — voice slug → ElevenLabs voice ID resolver (render-worker side).
//
// THE BUG THIS FIXES: the UI stores EITHER a preset slug (from the Settings
// voice picker, e.g. "luxury-warm") OR a raw cloned ElevenLabs voice_id (from
// the "use your own voice" flow) in the SAME `brandKit.voiceId` field.
// ElevenLabs text-to-speech only accepts a raw voice ID. Before this file
// existed, the mixer passed the slug through unchanged, so every preset voice
// produced `/text-to-speech/luxury-warm` → invalid → all narration failed →
// the video shipped silent. Cloned voices (already raw IDs) happened to work.
//
// Resolution rules:
//   - empty / "":          style default (if known) else Rachel
//   - known preset slug:   the mapped premade ElevenLabs ID
//   - anything else:       assumed to already be a raw cloned voice_id → passthrough
//
// The IDs below are canonical ElevenLabs premade voices and are each
// overridable via env (EVOICE_*) so a mapping can be corrected without a code
// change. The api/ side keeps a mirror copy at api/_lib/voice-resolver.js —
// keep the two in sync (the Vercel runtime can't import from this package).

const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel

export const VOICE_SLUG_TO_ID = {
  "luxury-warm":     process.env.EVOICE_LUXURY_WARM     || "EXAVITQu4vr4xnSDxMaL", // Sarah — warm female
  "luxury-male":     process.env.EVOICE_LUXURY_MALE     || "pNInz6obpgDQGcFmaJgB", // Adam — deep male
  "luxury-british":  process.env.EVOICE_LUXURY_BRITISH  || "XB0fDUnXU5powFXDhCwa", // Charlotte — British female
  "viral-energetic": process.env.EVOICE_VIRAL_ENERGETIC || "XrExE9yKIg1WjnnlVkGX", // Matilda — bright female
  "viral-confident": process.env.EVOICE_VIRAL_CONFIDENT || "AZnzlk1XvdvUeBnXmlld", // Domi — strong female
  "investor-deep":   process.env.EVOICE_INVESTOR_DEEP   || "29vD33N1CtxCmqQRPOHJ", // Drew — measured male
  "mls-neutral":     process.env.EVOICE_MLS_NEUTRAL     || "21m00Tcm4TlvDq8ikWAM"  // Rachel — neutral female
};

const STYLE_DEFAULT_SLUG = {
  luxury: "luxury-warm",
  viral: "viral-energetic",
  mls: "mls-neutral",
  investor: "investor-deep"
};

// True only for the fixed set of preset slugs (never matches a cloned voice ID).
export function isPresetSlug(value) {
  const v = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(VOICE_SLUG_TO_ID, v);
}

// Translate whatever the UI stored into a usable ElevenLabs voice ID.
export function resolveVoiceId(value, style) {
  const v = String(value || "").trim();
  if (!v) {
    const slug = STYLE_DEFAULT_SLUG[String(style || "").toLowerCase()];
    return (slug && VOICE_SLUG_TO_ID[slug]) || DEFAULT_VOICE_ID;
  }
  if (VOICE_SLUG_TO_ID[v]) return VOICE_SLUG_TO_ID[v]; // preset slug → premade ID
  return v; // already a raw cloned ElevenLabs voice_id
}
