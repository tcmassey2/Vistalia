import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { authHeaders } from "../lib/api";
import { cloneVoiceIdOf, cloneVoiceLabelOf } from "../lib/voice-presets";

/**
 * VoiceSection — Settings widget for picking the narrator voice.
 *
 * Reads the catalog from /api/voices, renders a radio-style picker, and
 * writes the selection to brandKit.voiceId (which the store auto-syncs to
 * Supabase). The render-worker's voice-mixer resolves the slug back into
 * the underlying ElevenLabs voice ID + tuned per-voice settings.
 *
 * v34.7: the user's CLONED voice is now a first-class option at the top of
 * the picker. Before, this list only knew presets — picking one silently
 * overwrote the clone id in voiceId (the only place it lived) and the
 * clone was unlinked with no warning. The clone now lives permanently in
 * brandKit.clonedVoiceId; this picker only ever changes which voice is
 * ACTIVE. Every option also gets a ▶ preview so "which voice is this?"
 * is answerable in two seconds.
 *
 * Default selection: empty string ("Use style default") so the worker
 * picks the right voice based on the active style pack at render time.
 */

interface PublicVoice {
  slug: string;
  label: string;
  description: string;
  gender: string;
  accent: string;
  bestFor: string[];
}

interface VoicesResponse {
  voices: PublicVoice[];
  defaultsByStyle: Record<string, string>;
}

export default function VoiceSection() {
  const branding = useStore((s) => s.branding);
  const setBranding = useStore((s) => s.setBranding);
  const setError = useStore((s) => s.setError);

  const [voices, setVoices] = useState<PublicVoice[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [previewingId, setPreviewingId] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/voices")
      .then((res) => res.json())
      .then((data: VoicesResponse) => {
        if (!alive) return;
        setVoices(Array.isArray(data?.voices) ? data.voices : []);
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : "Couldn't load voice catalog.");
        setVoices([]);
      });
    return () => {
      alive = false;
      audioRef.current?.pause();
    };
  }, []);

  const selectedSlug = branding.voiceId || "";
  const cloneId = cloneVoiceIdOf(branding);
  const cloneLabel = cloneVoiceLabelOf(branding);

  const handlePick = (voiceId: string, label: string) => {
    // Only the ACTIVE voice changes — clonedVoiceId is never touched here,
    // so switching to a preset can no longer destroy the clone linkage.
    setBranding({
      voiceId: voiceId || undefined,
      voiceLabel: label || undefined
    });
  };

  const previewVoice = async (voiceIdOrSlug: string, label: string) => {
    // Toggle off if the same row is already playing.
    if (previewingId === voiceIdOrSlug) {
      audioRef.current?.pause();
      setPreviewingId("");
      return;
    }
    audioRef.current?.pause();
    setPreviewingId(voiceIdOrSlug);
    try {
      const res = await fetch("/api/synthesize-narration", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          voiceId: voiceIdOrSlug,
          text: `Hi, this is ${label}. Welcome to this beautifully maintained three bedroom home.`
        })
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Preview failed (${res.status}).`);
      }
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.onended = () => setPreviewingId("");
      await audio.play();
    } catch (err) {
      setPreviewingId("");
      setError(err instanceof Error ? err.message : "Voice preview failed.");
    }
  };

  if (voices === null) {
    return (
      <div className="rounded-lg border border-edge-soft bg-surface-input p-4 animate-pulse">
        <div className="h-4 w-40 bg-edge rounded mb-2" />
        <div className="h-3 w-56 bg-edge rounded" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300">
        {loadError}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-ink-muted leading-relaxed max-w-xl">
        Pick the narrator that runs across your videos. "Use style default" lets us
        match the voice to whichever style pack you choose for each render
        (warm Sarah for Luxury, energetic Bella for Viral, deep Drew for Investor).
      </div>

      <div className="flex flex-col gap-2">
        {/* The user's cloned voice — first-class, top of the list. */}
        {cloneId && (
          <VoiceOption
            slug={cloneId}
            label={`${cloneLabel} — your cloned voice`}
            description="Your own voice, cloned from your recording. Every render narrated by you."
            accent=""
            gender="CLONE"
            selected={selectedSlug === cloneId}
            previewing={previewingId === cloneId}
            onPick={() => handlePick(cloneId, cloneLabel)}
            onPreview={() => previewVoice(cloneId, cloneLabel)}
          />
        )}

        {/* Default option — no slug means "use style default" */}
        <VoiceOption
          slug=""
          label="Use style default"
          description="Best match per style pack — recommended if you haven't cloned your voice."
          accent=""
          gender=""
          selected={selectedSlug === ""}
          previewing={false}
          onPick={() => handlePick("", "Use style default")}
        />

        {voices.map((v) => (
          <VoiceOption
            key={v.slug}
            slug={v.slug}
            label={v.label}
            description={v.description}
            accent={v.accent}
            gender={v.gender}
            selected={selectedSlug === v.slug}
            previewing={previewingId === v.slug}
            onPick={() => handlePick(v.slug, v.label)}
            onPreview={() => previewVoice(v.slug, v.label)}
          />
        ))}
      </div>

      <div className="text-[11px] text-ink-dim leading-relaxed mt-2">
        Voices are powered by ElevenLabs. Same voice plays across every scene of a render.
        You can change it any time — your next render will use the new pick.
      </div>
    </div>
  );
}

function VoiceOption({
  slug,
  label,
  description,
  accent,
  gender,
  selected,
  previewing,
  onPick,
  onPreview
}: {
  slug: string;
  label: string;
  description: string;
  accent: string;
  gender: string;
  selected: boolean;
  previewing: boolean;
  onPick: () => void;
  onPreview?: () => void;
}) {
  return (
    <div
      data-voice-slug={slug || "default"}
      className={
        "card-press w-full px-4 py-3 rounded-lg border transition-colors " +
        (selected
          ? "border-gold bg-gold/10 ring-2 ring-gold/30"
          : "border-edge bg-surface-input hover:border-edge-strong hover:bg-surface")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={onPick} className="min-w-0 flex-1 text-left">
          <div className="text-sm font-semibold tracking-tightish text-ink flex items-center gap-2 flex-wrap">
            {label}
            {accent && (
              <span className="text-[9px] font-bold tracking-widest px-1.5 py-px rounded bg-surface text-ink-muted border border-edge uppercase">
                {accent}
              </span>
            )}
            {gender && (
              <span className={
                "text-[9px] font-bold tracking-widest px-1.5 py-px rounded border uppercase " +
                (gender === "CLONE"
                  ? "bg-gold/15 text-gold border-gold/40"
                  : "bg-surface text-ink-muted border-edge")
              }>
                {gender}
              </span>
            )}
          </div>
          <div className="text-xs text-ink-muted mt-1 leading-relaxed">{description}</div>
        </button>

        <div className="flex items-center gap-2 shrink-0 mt-0.5">
          {onPreview && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onPreview(); }}
              title={previewing ? "Stop preview" : "Preview this voice"}
              aria-label={previewing ? "Stop preview" : `Preview ${label}`}
              className={
                "grid place-items-center w-7 h-7 rounded-full border transition-colors " +
                (previewing
                  ? "border-gold bg-gold text-paper"
                  : "border-edge bg-surface text-ink-muted hover:text-gold hover:border-gold")
              }
            >
              {previewing ? (
                <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="currentColor">
                  <rect x="2" y="2" width="8" height="8" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 translate-x-px" fill="currentColor">
                  <path d="M3 1.5v9l7-4.5-7-4.5z" />
                </svg>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onPick}
            aria-label={`Select ${label}`}
            className={
              "w-5 h-5 rounded-full border-2 transition-colors " +
              (selected ? "border-gold bg-gold" : "border-edge bg-transparent")
            }
          >
            {selected && (
              <svg viewBox="0 0 20 20" fill="none" className="w-full h-full p-0.5">
                <path
                  d="M5 10.5l3 3 7-7"
                  stroke="#0E0E10"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
