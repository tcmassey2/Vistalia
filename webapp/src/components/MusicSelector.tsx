// Vistalia — MusicSelector (v2: cleaned up).
//
// Layout rationale (vs v1):
//   v1 had a big grouped list with per-row Play + Use buttons + three
//   different chip variants (default / selected / In use) + a permanent
//   <audio controls> widget at the bottom. Functional but visually noisy.
//
//   v2 condenses to a single-line-per-track row: one tap = play, one tap
//   on the row body = select. Default per style is shown inline (gold
//   left rail). The bottom audio player only appears WHILE actively
//   previewing — gone the rest of the time. Same data, half the chrome.
//
// Same store contract: selectedMusicTrackId in store; null = use style
// default. Same catalog: MUSIC_CATALOG / defaultTrackForStyle / etc.

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

  const styleDefault = defaultTrackForStyle(selectedStyleId);
  const effectiveTrackId = selectedMusicTrackId ?? styleDefault.id;
  const effectiveTrack =
    MUSIC_CATALOG.find((t) => t.id === effectiveTrackId) ?? styleDefault;

  // Audio playback state. Only one preview at a time. The persistent
  // <audio> tag lives below the list and ONLY mounts when previewingId
  // is set — keeping the chrome out of view when nothing is playing.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Cleanup playback when the screen unmounts.
  useEffect(() => {
    return () => { audioRef.current?.pause(); };
  }, []);

  const handlePreview = (track: MusicTrack) => {
    setPreviewError(null);
    // Tapping the play button on the row currently previewing pauses + closes.
    if (previewingId === track.id) {
      audioRef.current?.pause();
      setPreviewingId(null);
      return;
    }
    setPreviewingId(track.id);
    // Audio element renders on next paint; play() happens in the
    // <audio onLoadedMetadata> handler below to stay inside the
    // user-gesture context.
  };

  const handleSelect = (track: MusicTrack) => {
    // Picking the current style's default stores null so style changes
    // re-track the default. Picking anything else stores the explicit id.
    setMusicTrack(track.id === styleDefault.id ? null : track.id);
  };

  const previewTrack = previewingId
    ? MUSIC_CATALOG.find((t) => t.id === previewingId) ?? null
    : null;

  const groups = tracksGroupedByStyle();

  return (
    <div className="flex flex-col gap-3">
      {/* Header line — current selection at a glance + reset link. */}
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-ink-muted">
          In use:{" "}
          <span className="text-ink font-medium">{effectiveTrack.label}</span>
          {!selectedMusicTrackId && (
            <span className="text-ink-muted"> — style default for {STYLE_LABELS[selectedStyleId]}</span>
          )}
        </span>
        {selectedMusicTrackId && (
          <button
            type="button"
            onClick={() => setMusicTrack(null)}
            className="text-ink-muted hover:text-gold underline-offset-2 hover:underline"
          >
            Reset to default
          </button>
        )}
      </div>

      {/* Track list — single panel, grouped by style with thin dividers. */}
      <div className="rounded-lg border border-edge bg-surface-input/30 overflow-hidden">
        {groups.map(({ style, tracks }, gi) => (
          <div key={style}>
            <div className="px-3 py-1.5 text-[9px] uppercase tracking-[0.2em] text-ink-muted font-mono bg-surface-input/40 border-b border-edge/40">
              {STYLE_LABELS[style]}
            </div>
            <ul>
              {tracks.map((track) => {
                const isEffective = effectiveTrackId === track.id;
                const isPreviewing = previewingId === track.id;
                return (
                  <li
                    key={track.id}
                    className={cn(
                      "group flex items-center gap-3 px-3 py-2.5 border-b border-edge/40 last:border-b-0 transition-colors cursor-pointer",
                      isEffective
                        ? "bg-gold/8 border-l-2 border-l-gold"
                        : "hover:bg-surface-input/60 border-l-2 border-l-transparent"
                    )}
                    onClick={() => handleSelect(track)}
                  >
                    {/* Play / pause — stops propagation so it doesn't also select. */}
                    <button
                      type="button"
                      aria-label={isPreviewing ? "Pause preview" : "Preview track"}
                      onClick={(e) => { e.stopPropagation(); handlePreview(track); }}
                      className={cn(
                        "h-7 w-7 shrink-0 rounded-full flex items-center justify-center transition-colors",
                        isPreviewing
                          ? "bg-gold text-paper"
                          : "bg-surface-input border border-edge text-ink-soft hover:text-gold hover:border-gold"
                      )}
                    >
                      {isPreviewing ? (
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><rect x="2" y="1" width="2" height="8"/><rect x="6" y="1" width="2" height="8"/></svg>
                      ) : (
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink truncate leading-tight">
                        {track.label}
                      </div>
                      <div className="text-[11px] text-ink-muted truncate leading-tight mt-0.5">
                        {track.vibe}
                      </div>
                    </div>

                    <div className="shrink-0 text-[10px] font-mono text-ink-muted tabular-nums">
                      {formatDuration(track.durationSec)}
                    </div>

                    {/* Status indicator: single dot — gold = in use, hidden otherwise.
                        Eliminates the v1 default/selected/In-use triple-chip noise. */}
                    <div className="shrink-0 w-3 flex justify-center">
                      {isEffective && (
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full bg-gold"
                          aria-label="Currently in use"
                          title="Currently in use"
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {gi < groups.length - 1 && <div aria-hidden="true" className="h-0" />}
          </div>
        ))}
      </div>

      {/* Mini preview player — ONLY appears while previewing. Slim, native
          controls, plus a close X so it never lingers when the user is
          done listening. */}
      {previewTrack && (
        <div className="rounded-lg border border-edge bg-surface-input/30 px-3 py-2 flex items-center gap-3">
          <audio
            ref={audioRef}
            src={previewUrlFor(previewTrack)}
            autoPlay
            onLoadedMetadata={() => {
              audioRef.current?.play().catch((err) => {
                console.error("[music-preview] play() rejected", err);
                setPreviewError("Couldn't play preview. Tap the play button again.");
                setPreviewingId(null);
              });
            }}
            onEnded={() => setPreviewingId(null)}
            onError={() => {
              const url = previewUrlFor(previewTrack);
              console.error("[music-preview] <audio> error for", url);
              setPreviewError(`Couldn't load ${url}.`);
              setPreviewingId(null);
            }}
            controls
            className="flex-1 h-8"
          />
          <button
            type="button"
            aria-label="Close preview"
            onClick={() => {
              audioRef.current?.pause();
              setPreviewingId(null);
            }}
            className="h-7 w-7 shrink-0 rounded-md text-ink-muted hover:text-ink hover:bg-surface-input flex items-center justify-center"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 1l8 8M9 1l-8 8" />
            </svg>
          </button>
        </div>
      )}

      {previewError && (
        <div className="text-[11px] text-red-300 px-1">{previewError}</div>
      )}
    </div>
  );
}
