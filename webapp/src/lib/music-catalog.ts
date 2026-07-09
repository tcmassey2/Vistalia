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
//     per-style default (see STYLE_DEFAULT_TRACK in api/create-edit-plan.js
//     and SLOT_DEFAULT_FILE in render-worker/src/runway-job.mjs)

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
    id: "luxury-poradovskyi",
    filename: "luxury-poradovskyi.mp3",
    label: "Grand Reveal",
    vibe: "Refined cinematic, modern restraint — verified Pixabay",
    style: "cinematic-luxury",
    isStyleDefault: true,
    durationSec: 125
  },
  // + Pixabay picks (free / redistribution-safe)
  {
    id: "lux-leberch-piano",
    filename: "leberch-piano-516448.mp3",
    label: "Golden Hour",
    vibe: "Bright cinematic piano, gentle forward motion",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 122
  },
  {
    id: "lux-emotional",
    filename: "jonasblakewood-emotional-527472.mp3",
    label: "Homecoming",
    vibe: "Warm ambient swell — heartfelt, unhurried",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 136
  },
  {
    id: "lux-inspiring",
    filename: "tunetank-inspiring-cinematic-music-409347.mp3",
    label: "Horizon",
    vibe: "Slow, wide, uplifting build",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 132
  },
  {
    id: "lux-softness",
    filename: "atlasaudio-cinematic-softness-511863.mp3",
    label: "Soft Light",
    vibe: "Soft, elegant, whisper-quiet under narration",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 120
  },
  {
    id: "lux-paulyudin-piano",
    filename: "paulyudin-piano-piano-music-508963.mp3",
    label: "Quiet Luxury",
    vibe: "Reflective solo piano, refined restraint",
    style: "cinematic-luxury",
    isStyleDefault: false,
    durationSec: 131
  },

  // ───────── Energetic Social (viral) ─────────
  {
    id: "social-mountain-pop",
    filename: "the_mountain-pop-490010.mp3",
    label: "Open House",
    vibe: "Bright soft-house pop, high energy",
    style: "modern-social",
    isStyleDefault: true,
    durationSec: 103
  },
  {
    id: "social-jbw-pop",
    filename: "jonasblakewood-pop-524132.mp3",
    label: "Curb Appeal",
    vibe: "Punchy, scroll-stopping pop",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 141
  },
  {
    id: "social-friends-freq",
    filename: "jonasblakewood-pop-dance-friends-frequencies-445891.mp3",
    label: "Weekend Tour",
    vibe: "Feel-good dance-pop groove",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 132
  },
  {
    id: "social-uplifting-pop",
    filename: "eliveta-uplifting-pop-491240.mp3",
    label: "Sunny Side",
    vibe: "Sunny, optimistic, energetic",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 145
  },
  {
    id: "social-prettyjohn-pop",
    filename: "prettyjohn1-pop-pop-music-503314.mp3",
    label: "Quick Tour",
    vibe: "Short, snappy pop hit",
    style: "modern-social",
    isStyleDefault: false,
    durationSec: 63
  },

  // ───────── MLS Clean ─────────
  {
    id: "mls-corporate-soft",
    filename: "nastelbom-corporate-soft-488321.mp3",
    label: "Clean Slate",
    vibe: "Gentle, neutral bed — steps out of the way",
    style: "mls-clean",
    // v41.4 (master-25 "tree clatter"): demoted from default — the track's
    // quiet bed carries baked-in percussive clicks (worst-window
    // impulsiveness 17.4, highest of all 19 tracks) that read as diegetic
    // rattle over outdoor scenes whenever the voice pauses.
    isStyleDefault: false,
    durationSec: 151
  },
  {
    id: "mls-leberch-corporate",
    filename: "leberch-corporate-509707.mp3",
    label: "Walkthrough",
    vibe: "Clean, steady, professional",
    style: "mls-clean",
    isStyleDefault: false,
    durationSec: 208
  },
  {
    id: "mls-elegant-brand",
    filename: "daily-business-anthe-elegant-corporate-brand-541377.mp3",
    label: "Signature",
    vibe: "Polished, brand-forward, light",
    style: "mls-clean",
    isStyleDefault: false,
    durationSec: 73
  },
  {
    id: "mls-corporate-bg",
    filename: "jonasblakewood-corporate-background-524146.mp3",
    label: "Backdrop",
    vibe: "Understated bed — vanishes under VO",
    style: "mls-clean",
    isStyleDefault: true, // v41.4: cleanest MLS bed (impulsiveness 7.2)
    durationSec: 183
  },

  // ───────── Investor Tour ─────────
  {
    id: "investor-mountain-corp",
    filename: "the_mountain-corporate-455905.mp3",
    label: "The Deal",
    vibe: "Confident, assured, mid-tempo",
    style: "investor-tour",
    isStyleDefault: true,
    durationSec: 122
  },
  {
    id: "investor-atlas-corp",
    filename: "atlasaudio-corporate-corporate-music-507826.mp3",
    label: "Market Move",
    vibe: "Driving, business-forward",
    style: "investor-tour",
    isStyleDefault: false,
    durationSec: 103
  },
  {
    id: "investor-energetic",
    filename: "prettyjohn1-corporate-corporate-music-483403.mp3",
    label: "Momentum",
    vibe: "Upbeat momentum for numbers",
    style: "investor-tour",
    isStyleDefault: false,
    durationSec: 81
  },
  {
    id: "investor-upbeat-corp",
    filename: "jonasblakewood-upbeat-corporate-533853.mp3",
    label: "Closing Day",
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

/* ============================================================
   Beat-sync (display only)

   The render pipeline snaps each scene's CUT to the music beat grid so
   transitions land on the beat (api/create-edit-plan.js). The snap interval
   for a track = the musical subdivision (beat / half-bar / bar / 2-bar) whose
   length is closest to the render style's target cadence. We recompute that
   here PURELY to show it in the UI — the actual render uses its own copy.

   ⚠️  BEAT_GRID and STYLE_TARGET_CADENCE below MIRROR the constants in
       api/create-edit-plan.js (same librosa measurements). Keep them in sync
       when adding/removing tracks or retuning cadence.
   ============================================================ */

type BeatGrid = { beat: number; bar: number };

const BEAT_GRID: Record<string, BeatGrid> = {
  "luxury-poradovskyi.mp3": { beat: 0.627, bar: 2.508 },
  "leberch-piano-516448.mp3": { beat: 0.372, bar: 1.486 },
  "jonasblakewood-emotional-527472.mp3": { beat: 0.511, bar: 2.043 },
  "tunetank-inspiring-cinematic-music-409347.mp3": { beat: 1.091, bar: 4.365 },
  "atlasaudio-cinematic-softness-511863.mp3": { beat: 0.813, bar: 3.251 },
  "paulyudin-piano-piano-music-508963.mp3": { beat: 0.488, bar: 1.950 },
  "the_mountain-pop-490010.mp3": { beat: 0.511, bar: 2.043 },
  "jonasblakewood-pop-524132.mp3": { beat: 0.464, bar: 1.858 },
  "jonasblakewood-pop-dance-friends-frequencies-445891.mp3": { beat: 0.650, bar: 2.601 },
  "eliveta-uplifting-pop-491240.mp3": { beat: 0.720, bar: 2.879 },
  "prettyjohn1-pop-pop-music-503314.mp3": { beat: 0.488, bar: 1.950 },
  "nastelbom-corporate-soft-488321.mp3": { beat: 0.604, bar: 2.415 },
  "leberch-corporate-509707.mp3": { beat: 0.534, bar: 2.136 },
  "daily-business-anthe-elegant-corporate-brand-541377.mp3": { beat: 0.534, bar: 2.136 },
  "jonasblakewood-corporate-background-524146.mp3": { beat: 0.511, bar: 2.043 },
  "the_mountain-corporate-455905.mp3": { beat: 0.511, bar: 2.043 },
  "atlasaudio-corporate-corporate-music-507826.mp3": { beat: 0.372, bar: 1.486 },
  "prettyjohn1-corporate-corporate-music-483403.mp3": { beat: 0.580, bar: 2.322 },
  "jonasblakewood-upbeat-corporate-533853.mp3": { beat: 0.534, bar: 2.136 }
};

const STYLE_TARGET_CADENCE: Record<StyleId, number> = {
  "cinematic-luxury": 2.6,
  "modern-social": 1.5,
  "mls-clean": 2.2,
  "investor-tour": 2.0
};

export type BeatSync = { unitSec: number; label: string; bpm: number };

// The beat-sync cadence a track will use UNDER a given render style. Returns
// null if we have no grid for the track (older/unmeasured file) — callers hide
// the indicator rather than guess.
export function beatSyncFor(track: MusicTrack, styleId: StyleId): BeatSync | null {
  const g = BEAT_GRID[track.filename];
  if (!g || !(g.beat > 0)) return null;
  const bar = g.bar > 0 ? g.bar : g.beat * 4;
  const target = STYLE_TARGET_CADENCE[styleId] ?? 2.2;
  const candidates: BeatSync[] = [
    { unitSec: g.beat, label: "beat", bpm: Math.round(60 / g.beat) },
    { unitSec: g.beat * 2, label: "½-bar", bpm: Math.round(60 / g.beat) },
    { unitSec: bar, label: "bar", bpm: Math.round(60 / g.beat) },
    { unitSec: bar * 2, label: "2-bar", bpm: Math.round(60 / g.beat) }
  ];
  return candidates.reduce((best, c) =>
    Math.abs(c.unitSec - target) < Math.abs(best.unitSec - target) ? c : best
  );
}
