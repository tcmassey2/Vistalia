// Vistalia — bundled music catalog.
//
// Source of truth for the music selector. Each entry corresponds to a
// real .mp3 file that lives in TWO places:
//   - webapp/public/music/<filename>   ← served to the browser for preview
//   - render-worker/music/<filename>   ← read by ffmpeg at render time
//
// Adding a new track:
//   1. Drop the .mp3 in BOTH directories above (same filename).
//   2. Add an entry to MUSIC_CATALOG below.
//   3. (Optional) Set isStyleDefault:true if it should be the default for
//      its style. Only ONE entry per style should have isStyleDefault:true.
//   4. ffprobe the duration so the UI can render a meter.
//
// Worker contract:
//   - manifest.musicTrack = "<filename.mp3>" → worker uses exactly this file
//   - manifest.musicTrack = undefined / null → worker falls back to the
//     style default (luxury.mp3 / social.mp3 / mls.mp3 / investor.mp3)

import type { StyleId } from "./types";

export type MusicTrack = {
  id: string;
  filename: string;       // matches the file in webapp/public/music/ and render-worker/music/
  label: string;          // shown in the UI
  vibe: string;           // 1-line description shown under the label
  style: StyleId;         // which style this track lives under in the picker
  isStyleDefault: boolean; // true if this is the auto-pick when the user selects this style
  durationSec: number;    // for the UI duration label
};

export const MUSIC_CATALOG: MusicTrack[] = [
  // ───────── Cinematic Luxury ─────────
  {
    id: "luxury-default",
    filename: "luxury.mp3",
    label: "Cinematic Luxury",
    vibe: "Slow build, piano-led — the original luxury default",
    style: "cinematic-luxury",
    isStyleDefault: true,
    durationSec: 189
  },
  {
    id: "luxury-poradovskyi",
    filename: "luxury-poradovskyi.mp3",
    label: "Poradovskyi — Luxury Real Estate",
    vibe: "Refined cinematic, modern restraint",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 125
  },
  {
    id: "universal-fallback",
    filename: "default.mp3",
    label: "Universal Cinematic",
    vibe: "Safe-bet cinematic — works under any listing",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 103
  },
  // + Pixabay picks (free / redistribution-safe)
  {
    id: "lux-leberch-piano",
    filename: "leberch-piano-516448.mp3",
    label: "Piano — Leberch",
    vibe: "Bright cinematic piano, gentle forward motion",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 122
  },
  {
    id: "lux-emotional",
    filename: "jonasblakewood-emotional-527472.mp3",
    label: "Emotional",
    vibe: "Warm ambient swell — heartfelt, unhurried",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 136
  },
  {
    id: "lux-inspiring",
    filename: "tunetank-inspiring-cinematic-music-409347.mp3",
    label: "Inspiring Cinematic",
    vibe: "Slow, wide, uplifting build",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 132
  },
  {
    id: "lux-softness",
    filename: "atlasaudio-cinematic-softness-511863.mp3",
    label: "Cinematic Softness",
    vibe: "Soft, elegant, whisper-quiet under narration",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 120
  },
  {
    id: "lux-paulyudin-piano",
    filename: "paulyudin-piano-piano-music-508963.mp3",
    label: "Piano — PaulYudin",
    vibe: "Reflective solo piano, refined restraint",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 131
  },

  // ───────── Energetic Social (viral) ─────────
  {
    id: "viral-default",
    filename: "social.mp3",
    label: "Energetic Social",
    vibe: "Modern beat, social-pacing — the viral default",
    style: "modern-social",
    isStyleDefault: true,
    durationSec: 141
  },
  // + Pixabay picks
  {
    id: "social-mountain-pop",
    filename: "the_mountain-pop-490010.mp3",
    label: "Pop — The_Mountain",
    vibe: "Bright soft-house pop, high energy",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 103
  },
  {
    id: "social-jbw-pop",
    filename: "jonasblakewood-pop-524132.mp3",
    label: "Pop — JonasBlakewood",
    vibe: "Punchy, scroll-stopping pop",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 141
  },
  {
    id: "social-friends-freq",
    filename: "jonasblakewood-pop-dance-friends-frequencies-445891.mp3",
    label: "Pop Dance — Friends Frequencies",
    vibe: "Feel-good dance-pop groove",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 132
  },
  {
    id: "social-uplifting-pop",
    filename: "eliveta-uplifting-pop-491240.mp3",
    label: "Uplifting Pop",
    vibe: "Sunny, optimistic, energetic",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 145
  },
  {
    id: "social-prettyjohn-pop",
    filename: "prettyjohn1-pop-pop-music-503314.mp3",
    label: "Pop — prettyjohn1",
    vibe: "Short, snappy pop hit",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 63
  },

  // ───────── MLS Clean ─────────
  {
    id: "mls-default",
    filename: "mls.mp3",
    label: "Clean MLS",
    vibe: "Light, unobtrusive — disappears under narration",
    style: "mls-clean",
    isStyleDefault: true,
    durationSec: 131
  },
  // + Pixabay picks
  {
    id: "mls-corporate-soft",
    filename: "nastelbom-corporate-soft-488321.mp3",
    label: "Corporate Soft",
    vibe: "Gentle, neutral bed — steps out of the way",
    style: "mls-clean",
    isStyleDefault: false,
    durationSec: 151
  },
  {
    id: "mls-leberch-corporate",
    filename: "leberch-corporate-509707.mp3",
    label: "Corporate — Leberch",
    vibe: "Clean, steady, professional",
    style: "mls-clean",
    isStyleDefault: false,
    durationSec: 208
  },
  {
    id: "mls-elegant-brand",
    filename: "daily-business-anthe-elegant-corporate-brand-541377.mp3",
    label: "Elegant Corporate Brand",
    vibe: "Polished, brand-forward, light",
    style: "mls-clean",
    isStyleDefault: false,
    durationSec: 73
  },
  {
    id: "mls-corporate-bg",
    filename: "jonasblakewood-corporate-background-524146.mp3",
    label: "Corporate Background",
    vibe: "Understated bed — vanishes under VO",
    style: "mls-clean",
    isStyleDefault: false,
    durationSec: 183
  },

  // ───────── Investor Tour ─────────
  {
    id: "investor-default",
    filename: "investor.mp3",
    label: "Confident Investor",
    vibe: "Mid-tempo confident — supports number-heavy narration",
    style: "investor-tour",
    isStyleDefault: true,
    durationSec: 81
  },
  // + Pixabay picks
  {
    id: "investor-mountain-corp",
    filename: "the_mountain-corporate-455905.mp3",
    label: "Corporate — The_Mountain",
    vibe: "Confident, assured, mid-tempo",
    style: "investor-tour",
    isStyleDefault: false,
    durationSec: 122
  },
  {
    id: "investor-atlas-corp",
    filename: "atlasaudio-corporate-corporate-music-507826.mp3",
    label: "Corporate — AtlasAudio",
    vibe: "Driving, business-forward",
    style: "investor-tour",
    isStyleDefault: false,
    durationSec: 103
  },
  {
    id: "investor-energetic",
    filename: "prettyjohn1-corporate-corporate-music-483403.mp3",
    label: "Corporate Energetic",
    vibe: "Upbeat momentum for numbers",
    style: "investor-tour",
    isStyleDefault: false,
    durationSec: 81
  },
  {
    id: "investor-upbeat-corp",
    filename: "jonasblakewood-upbeat-corporate-533853.mp3",
    label: "Upbeat Corporate",
    vibe: "Optimistic, forward-driving",
    style: "investor-tour",
    isStyleDefault: false,
    durationSec: 129
  }
];

/* ============================================================
   Helpers
   ============================================================ */

export function defaultTrackForStyle(styleId: StyleId): MusicTrack {
  const styleDefault = MUSIC_CATALOG.find(
    (t) => t.style === styleId && t.isStyleDefault
  );
  if (styleDefault) return styleDefault;
  // Last-resort fallback so the picker is never empty.
  return MUSIC_CATALOG.find((t) => t.id === "universal-fallback") ?? MUSIC_CATALOG[0];
}

export function trackById(id: string | null | undefined): MusicTrack | undefined {
  if (!id) return undefined;
  return MUSIC_CATALOG.find((t) => t.id === id);
}

// Resolve the actual filename the worker should mix into the master MP4.
// If the user explicitly chose a track, use that; otherwise fall back to
// the style default. Always returns SOMETHING — never null — so callers
// don't have to guard.
export function resolveTrack(
  selectedMusicTrackId: string | null | undefined,
  styleId: StyleId
): MusicTrack {
  return trackById(selectedMusicTrackId) ?? defaultTrackForStyle(styleId);
}

// Public URL the browser uses to preview a track. Files live in
// webapp/public/music/ which Vite emits to <BASE_URL>music/<filename>.
// The deployed app runs under /app/ (vite.config.ts: base: "/app/"), so a
// root-absolute "/music/..." misses the file. import.meta.env.BASE_URL
// resolves to "/app/" in production and "/" in dev, so this works in both.
export function previewUrlFor(track: MusicTrack): string {
  const base = import.meta.env?.BASE_URL ?? "/";
  return `${base}music/${track.filename}`;
}

// Tracks grouped by style, in the order they should appear in the picker.
// The style default surfaces first within its group.
export function tracksGroupedByStyle(): { style: StyleId; tracks: MusicTrack[] }[] {
  const styles: StyleId[] = ["cinematic-luxury", "modern-social", "mls-clean", "investor-tour"];
  return styles.map((style) => ({
    style,
    tracks: MUSIC_CATALOG
      .filter((t) => t.style === style)
      .sort((a, b) => Number(b.isStyleDefault) - Number(a.isStyleDefault))
  }));
}
