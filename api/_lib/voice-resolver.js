// Vistalia — voice slug → ElevenLabs voice ID resolver (API side).
//
// MIRROR of render-worker/src/voices.mjs. Two copies exist because the Vercel
// API runtime can't import from the render-worker package. Keep them in sync.
//
// The UI stores EITHER a preset slug ("luxury-warm") OR a raw cloned ElevenLabs
// voice_id in brandKit.voiceId. ElevenLabs only accepts raw IDs, so we must
// translate slugs before any text-to-speech call (the "test your voice"
// preview hits this path).

const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel

export const VOICE_SLUG_TO_ID = {
  "luxury-warm":     process.env.EVOICE_LUXURY_WARM     || "EXAVITQu4vr4xnSDxMaL", // Sarah
  "luxury-male":     process.env.EVOICE_LUXURY_MALE     || "pNInz6obpgDQGcFmaJgB", // Adam
  "luxury-british":  process.env.EVOICE_LUXURY_BRITISH  || "XB0fDUnXU5powFXDhCwa", // Charlotte
  "viral-energetic": process.env.EVOICE_VIRAL_ENERGETIC || "XrExE9yKIg1WjnnlVkGX", // Matilda
  "viral-confident": process.env.EVOICE_VIRAL_CONFIDENT || "AZnzlk1XvdvUeBnXmlld", // Domi
  "investor-deep":   process.env.EVOICE_INVESTOR_DEEP   || "29vD33N1CtxCmqQRPOHJ", // Drew
  "mls-neutral":     process.env.EVOICE_MLS_NEUTRAL     || "21m00Tcm4TlvDq8ikWAM"  // Rachel
};

export function isPresetSlug(value) {
  const v = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(VOICE_SLUG_TO_ID, v);
}

export function resolveVoiceId(value) {
  const v = String(value || "").trim();
  if (!v) return DEFAULT_VOICE_ID;
  if (VOICE_SLUG_TO_ID[v]) return VOICE_SLUG_TO_ID[v]; // preset slug → premade ID
  return v; // already a raw cloned voice_id
}
