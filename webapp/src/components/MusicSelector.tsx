// EstateMotion — MusicSelector
//
// Shows the bundled music library. Each track is a row with label, vibe,
// duration, a preview play/pause button, and a "Use this track" affordance.
// The currently selected track (or the style default when no manual pick
// is set) is visually marked.
//
// Why no API endpoint:
//   The catalog is bundled into the webapp at build time (see
//   lib/music-catalog.ts). Audio files live in webapp/public/music/
//   so the browser plays them with <audio src="/music/<filename>"/>.
//   The worker reads its own copy from render-worker/music/ and uses
//   manifest.musicTrack to pick which file to mix.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import {
  MUSIC_CATALOG,
  defaultTrackForStyle,
  previewUrlFor,
  tracksGroupedByStyle,
  type MusicTrack
} from "../lib/music-catalog";
import type { StyleId } from "../lib/types";
import { cn } from "../lib/cn";

const STYLE_LABELS: Record<StyleId, string> = {
  "cinematic-luxury": "Luxury",
  "modern-social": "Social",
  "mls-clean": "MLS",
  "investor-tour": "Investor"
};

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function MusicSelector() {
  const selectedStyleId = useStore((s) => s.selectedStyleId);
  const selectedMusicTrackId = useStore((s) => s.selectedMusicTrackId);
  const setMusicTrack = useStore((s) => s.setMusicTrack);

  // The "effective" track currently in use — explicit pick if present,
  // otherwise the style default.
  const styleDefault = defaultTrackForStyle(selectedStyleId);
  const effectiveTrackId = selectedMusicTrackId ?? styleDefault.id;

  // Audio preview: only one track plays at a time. We hold a single
  // <audio> instance and swap its src.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);

  useEffect(() => {
    // Construct the audio element once, lazily — avoids SSR issues.
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "none";
      audioRef.current.addEventListener("ended", () => setPreviewingId(null));
      audioRef.current.addEventListener("pause", () => {
        // Browser pause (tab change, etc.) — drop the preview marker.
        if (audioRef.current?.paused) setPreviewingId((id) => id);
      });
    }
    // Tear down on unmount: stop playback if the screen unmounts so audio
    // doesn't leak between routes.
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const handlePreview = (track: MusicTrack) => {
    const el = audioRef.current;
    if (!el) return;
    if (previewingId === track.id) {
      el.pause();
      setPreviewingId(null);
      return;
    }
    el.src = previewUrlFor(track);
    el.currentTime = 0;
    el.play().then(() => setPreviewingId(track.id)).catch(() => {
      // Autoplay blocked or file missing — surface nothing; user can retry.
      setPreviewingId(null);
    });
  };

  const handleSelect = (track: MusicTrack) => {
    // If the user picks the current style's default, we store null so the
    // selection automatically follows future style changes. Picking any
    // other track stores the explicit id.
    setMusicTrack(track.id === styleDefault.id ? null : track.id);
  };

  const groups = tracksGroupedByStyle();
  const effectiveTrack = MUSIC_CATALOG.find((t) => t.id === effectiveTrackId) ?? styleDefault;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tightish">Music</h3>
          <p className="text-xs text-ink-muted mt-0.5">
            {selectedMusicTrackId
              ? <>Playing <span className="text-ink">{effectiveTrack.label}</span> — picked from the library.</>
              : <>Using <span className="text-ink">{styleDefault.label}</span> — the default for the {STYLE_LABELS[selectedStyleId]} style.</>}
          </p>
        </div>
        {selectedMusicTrackId && (
          <button
            type="button"
            onClick={() => setMusicTrack(null)}
            className="text-xs text-ink-muted hover:text-gold underline-offset-2 hover:underline"
          >
            Reset to style default
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {groups.map(({ style, tracks }) => (
          <div key={style} className="rounded-lg border border-edge bg-surface-input/30">
            <div className="px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-ink-muted font-mono border-b border-edge/60">
              {STYLE_LABELS[style]}
            </div>
            <ul className="divide-y divide-edge/40">
              {tracks.map((track) => {
                const isEffective = effectiveTrackId === track.id;
                const isPreviewing = previewingId === track.id;
                return (
                  <li
                    key={track.id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 transition-colors",
                      isEffective ? "bg-gold/8" : "hover:bg-surface-input/60"
                    )}
                  >
                    <button
                      type="button"
                      aria-label={isPreviewing ? "Pause preview" : "Play preview"}
                      onClick={() => handlePreview(track)}
                      className={cn(
                        "h-8 w-8 shrink-0 rounded-full border flex items-center justify-center transition-colors",
                        isPreviewing
                          ? "border-gold bg-gold text-paper"
                          : "border-edge bg-surface-input text-ink hover:border-gold hover:text-gold"
                      )}
                    >
                      {isPreviewing ? (
                        // pause glyph
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="2" y="1" width="2" height="8"/><rect x="6" y="1" width="2" height="8"/></svg>
                      ) : (
                        // play glyph
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-ink truncate">{track.label}</span>
                        {track.isStyleDefault && (
                          <span className="text-[9px] uppercase tracking-[0.15em] text-gold/80 font-mono">default</span>
                        )}
                        {isEffective && !track.isStyleDefault && (
                          <span className="text-[9px] uppercase tracking-[0.15em] text-gold font-mono">selected</span>
                        )}
                      </div>
                      <div className="text-xs text-ink-muted truncate">{track.vibe} · {formatDuration(track.durationSec)}</div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSelect(track)}
                      disabled={isEffective}
                      className={cn(
                        "h-8 px-3 rounded-md text-xs font-semibold shrink-0 transition-colors",
                        isEffective
                          ? "bg-gold/10 text-gold cursor-default"
                          : "bg-surface-input text-ink hover:text-gold border border-edge hover:border-gold"
                      )}
                    >
                      {isEffective ? "In use" : "Use"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
