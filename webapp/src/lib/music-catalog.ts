// EstateMotion — bundled music catalog.
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

  // ───────── Investor Tour ─────────
  {
    id: "investor-default",
    filename: "investor.mp3",
    label: "Confident Investor",
    vibe: "Mid-tempo confident — supports number-heavy narration",
    style: "investor-tour",
    isStyleDefault: true,
    durationSec: 81
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
