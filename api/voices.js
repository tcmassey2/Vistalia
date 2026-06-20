// Vistalia — voices catalog endpoint (v23).
//
// Returns the public list of selectable narrator voices for the Settings UI.
// We DO NOT expose the underlying ElevenLabs voice IDs in this response —
// those are server-side concerns. The UI sends back a `slug` (e.g.
// "luxury-warm") which the worker resolves through render-worker/src/voices.mjs.
//
// Cached for 1h via Vary headers — voices are static config.
//
// This file mirrors the catalog defined in render-worker/src/voices.mjs.
// We keep two copies (one under api/, one under render-worker/) because the
// Vercel API runtime can't easily import from the render-worker package
// (different node_modules). Whenever you add/change a voice in voices.mjs,
// update the array below to match. The slug is the contract between the
// two; everything else here is display-only.

const PUBLIC_VOICES = [
  {
    slug: "luxury-warm",
    label: "Sarah — warm, refined",
    description: "Polished female narrator. Rachel's tonal cousin. Best for high-end residential.",
    gender: "female",
    accent: "American",
    bestFor: ["luxury", "investor", "mls"]
  },
  {
    slug: "luxury-male",
    label: "Adam — deep, considered",
    description: "Deep male voice. Sounds like an architectural-tour narrator.",
    gender: "male",
    accent: "American",
    bestFor: ["luxury", "investor"]
  },
  {
    slug: "luxury-british",
    label: "Charlotte — warm British",
    description: "Refined British female. Works for international/luxury listings.",
    gender: "female",
    accent: "British",
    bestFor: ["luxury"]
  },
  {
    slug: "viral-energetic",
    label: "Bella — bright, friendly",
    description: "Younger female, energetic. Built for short-form social.",
    gender: "female",
    accent: "American",
    bestFor: ["viral"]
  },
  {
    slug: "viral-confident",
    label: "Domi — strong, expressive",
    description: "Female with strong presence. Punchy delivery for scroll-stopping content.",
    gender: "female",
    accent: "American",
    bestFor: ["viral"]
  },
  {
    slug: "investor-deep",
    label: "Drew — professional, measured",
    description: "Middle-aged male, business-news cadence. For investor/commercial.",
    gender: "male",
    accent: "American",
    bestFor: ["investor", "mls"]
  },
  {
    slug: "mls-neutral",
    label: "Rachel — neutral, professional",
    description: "Original default. Restrained delivery for compliance-first use.",
    gender: "female",
    accent: "American",
    bestFor: ["mls", "luxury"]
  }
];

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Static catalog — caches well at the edge.
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=3600");
  return res.status(200).json({
    voices: PUBLIC_VOICES,
    defaultsByStyle: {
      luxury: "luxury-warm",
      viral: "viral-energetic",
      mls: "mls-neutral",
      investor: "investor-deep"
    }
  });
}
