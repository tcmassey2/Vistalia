// EstateMotion — MusicSelector
//
// Per-row preview button + a single bottom-of-the-list <audio controls>
// element that always reflects the most recently-previewed track. The
// inline native player is the bulletproof fallback: even if our custom
// play button hits a CORS/autoplay edge case, the user can scrub and
// hit play on the native widget.
//
// Source of truth for the catalog is webapp/src/lib/music-catalog.ts.
// MP3 files live in webapp/public/music/ (served at /music/<filename>).

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

  // The track currently loaded into the inline preview player. Starts as
  // the effective track so the player has something to play if the user
  // just hits the native play button.
  const [previewTrack, setPreviewTrack] = useState<MusicTrack>(effectiveTrack);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Keep the inline player in sync with the effective track. If the user
  // changes the selected track via the Use button, the preview snaps to
  // that track (paused). This is the expected UX — pick a track, hear it.
  useEffect(() => {
    setPreviewTrack(effectiveTrack);
    setPreviewError(null);
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }, [effectiveTrack.id]);

  const handleRowPreview = (track: MusicTrack) => {
    const el = audioRef.current;
    if (!el) return;
    setPreviewError(null);
    // If this row's track is already playing, pause it. Otherwise switch
    // the player to this track and play.
    if (previewTrack.id === track.id && isPlaying) {
      el.pause();
      return;
    }
    setPreviewTrack(track);
    // Setting src triggers a load. We need to wait a tick before play.
    // Doing it inline (not in useEffect) keeps the play() inside the
    // user-gesture context that browsers require for autoplay.
    el.src = previewUrlFor(track);
    el.currentTime = 0;
    el.load();
    const playPromise = el.play();
    if (playPromise && typeof playPromise.then === "function") {
      playPromise.catch((err) => {
        console.error("[music-preview] play() rejected", err, "for", previewUrlFor(track));
        setPreviewError(
          `Preview blocked or file missing. Use the player controls below to retry.`
        );
      });
    }
  };

  const handleSelect = (track: MusicTrack) => {
    setMusicTrack(track.id === styleDefault.id ? null : track.id);
  };

  const groups = tracksGroupedByStyle();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tightish">Music</h3>
          <p className="text-xs text-ink-muted mt-0.5">
            {selectedMusicTrackId
              ? <>Picked from library: <span className="text-ink">{effectiveTrack.label}</span></>
              : <>Style default: <span className="text-ink">{styleDefault.label}</span> (for {STYLE_LABELS[selectedStyleId]})</>}
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
                const isPreviewing = previewTrack.id === track.id && isPlaying;
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
                      onClick={() => handleRowPreview(track)}
                      className={cn(
                        "h-8 w-8 shrink-0 rounded-full border flex items-center justify-center transition-colors",
                        isPreviewing
                          ? "border-gold bg-gold text-paper"
                          : "border-edge bg-surface-input text-ink hover:border-gold hover:text-gold"
                      )}
                    >
                      {isPreviewing ? (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="2" y="1" width="2" height="8"/><rect x="6" y="1" width="2" height="8"/></svg>
                      ) : (
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

      {/* Bulletproof preview player. Always present in the DOM so the
          browser owns the audio state and the user has reliable controls
          if our custom button hits any edge case. The src is bound to
          whatever track was most recently previewed (or the effective
          track on first render). */}
      <div className="rounded-lg border border-edge bg-surface-input/30 px-3 py-3">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="text-xs text-ink-muted truncate">
            Preview: <span className="text-ink font-medium">{previewTrack.label}</span>
          </div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-ink-muted font-mono shrink-0">
            {formatDuration(previewTrack.durationSec)}
          </div>
        </div>
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={previewUrlFor(previewTrack)}
          onPlay={() => { setIsPlaying(true); setPreviewError(null); }}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onError={() => {
            setIsPlaying(false);
            const url = previewUrlFor(previewTrack);
            console.error("[music-preview] <audio> error for", url);
            setPreviewError(`Couldn't load ${url}. Check that the file deployed to /music/.`);
          }}
          className="w-full"
        />
        {previewError && (
          <div className="mt-2 text-[11px] text-red-300">
            {previewError}
          </div>
        )}
      </div>
    </div>
  );
}
