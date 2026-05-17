import { useEffect, useState } from "react";
import type { LibraryEntry, LibrarySceneEntry, Photo } from "../lib/types";
import { useStore } from "../lib/store";
import { pollRender, submitRegenerateScene, type RegenerateMode, type RenderManifest } from "../lib/api";
import { cn } from "../lib/cn";
import { engineLabel, isAiVideoEngine } from "../lib/engine-labels";

/**
 * Library detail modal — shown when an agent clicks a render in their
 * dashboard. Reinforces the "one render → full bundle" differentiator
 * by surfacing every deliverable: vertical/square/wide variants, three
 * social shorts, and the thumbnail. Each is downloadable individually.
 *
 * NEW (v16): per-scene regenerate. The scenes grid lets the agent surgically
 * re-render a single bad scene without re-running all 24. Two modes:
 *   - "Regen AI"      — re-roll the same Runway prompt (~$0.25, ~90s).
 *   - "Replace KB"    — swap the scene for a Ken Burns motion clip (free).
 * On success the modal triggers `onUpdated()` so the dashboard reloads
 * the library and the swapped scene is picked up everywhere.
 */
export default function LibraryDetailModal({
  entry,
  onClose,
  onUpdated
}: {
  entry: LibraryEntry;
  onClose: () => void;
  onUpdated?: () => void;
}) {
  // Lock body scroll while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ESC closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Library entries don't carry the full formats/shorts URL set right
  // now — the audit log only stores master_mp4_url + thumbnail_url. So
  // we infer the variant + short URLs from the master URL pattern,
  // since the worker uploads them with deterministic filenames.
  const masterUrl = entry.mp4Url;
  const inferredUrls = inferDeliverableUrls(masterUrl, entry);
  const heading = entry.listingAddress || entry.projectTitle || "Untitled listing";
  const date = new Date(entry.createdAt);
  const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const labelText = engineLabel(entry.engine);
  const hasScenes = Array.isArray(entry.scenes) && entry.scenes.length > 0;
  // Per-scene regen + hallucination guard UI only apply to AI video engines
  // (runway / depth). Quick Reel renders are deterministic Ken Burns and
  // don't have a 'regenerate this scene' concept.
  const isRunwayRender = isAiVideoEngine(entry.engine);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-paper/90 backdrop-blur-sm p-4 sm:p-8 fade-up-in"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-edge rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 sm:px-8 pt-6 sm:pt-8 pb-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-widest text-gold font-mono mb-1.5">
              {labelText} · {dateLabel}
            </p>
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tighter2 truncate">
              {heading}
            </h2>
            {entry.listingCity && (
              <p className="text-sm text-ink-muted mt-1">{entry.listingCity}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid place-items-center w-9 h-9 rounded-full bg-surface-input border border-edge hover:border-gold text-ink-muted hover:text-ink transition-colors flex-shrink-0"
          >
            ×
          </button>
        </div>

        {/* Master video preview */}
        <div className="px-6 sm:px-8">
          <video
            src={masterUrl}
            controls
            playsInline
            poster={entry.thumbnailUrl}
            className="w-full max-h-[60vh] rounded-lg bg-black"
          />
        </div>

        {/* v23: Engine breakdown badge — honest disclosure of which scenes
            ran on Cinematic AI vs Ken Burns fallback. Shown for Runway
            renders that have per-scene engine data. */}
        {isRunwayRender && hasScenes && (
          <div className="px-6 sm:px-8 mt-4">
            <EngineBreakdownBadge scenes={entry.scenes as any[]} />
          </div>
        )}

        {/* v23.2 Render Details panel — diagnostic strip showing exactly
            what shipped on this render. Eliminates the "is it actually
            working?" guesswork that masked the voice-narrator-never-fired
            bug for the whole launch week. Collapsed by default; one
            click reveals the full per-feature audit. */}
        <div className="px-6 sm:px-8 mt-4">
          <RenderDetailsPanel entry={entry} />
        </div>

        {/* Format bundle */}
        <div className="px-6 sm:px-8 mt-6">
          <div className="flex items-baseline justify-between mb-2.5">
            <h3 className="text-sm font-semibold tracking-tightish">Your full bundle</h3>
            <span className="text-xs text-ink-muted">{entry.formatsCount} format{entry.formatsCount === 1 ? "" : "s"} · all from one render</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <DeliverablePill
              label="9:16"
              sublabel="Reels · TikTok · Shorts"
              url={inferredUrls.vertical}
            />
            <DeliverablePill
              label="1:1"
              sublabel="Instagram feed"
              url={inferredUrls.square}
            />
            <DeliverablePill
              label="16:9"
              sublabel="YouTube · Zillow · MLS"
              url={inferredUrls.wide}
            />
          </div>
        </div>

        {/* Social shorts */}
        {entry.socialShortCount > 0 && (
          <div className="px-6 sm:px-8 mt-6">
            <div className="flex items-baseline justify-between mb-2.5">
              <h3 className="text-sm font-semibold tracking-tightish">Hero shorts</h3>
              <span className="text-xs text-ink-muted">{entry.socialShortCount} reel-ready cuts</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: entry.socialShortCount }).map((_, i) => {
                const shortUrl = inferredUrls.shorts[i];
                return (
                  <ShortPill
                    key={i}
                    clipNumber={i + 1}
                    url={shortUrl}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Per-scene regenerate — only relevant for runway renders that have
            persisted scene data. Renders before worker v16 won't have the
            scenes array and we tell the agent how to enable it. */}
        {isRunwayRender && (
          <div className="px-6 sm:px-8 mt-6">
            <div className="flex items-baseline justify-between mb-2.5">
              <h3 className="text-sm font-semibold tracking-tightish">
                Scene-by-scene fixes
              </h3>
              <span className="text-xs text-ink-muted">
                {hasScenes ? `${entry.scenes.length} scenes` : "Not available"}
              </span>
            </div>
            {hasScenes ? (
              <ScenesRegenGrid entry={entry} onUpdated={onUpdated} />
            ) : (
              <div className="rounded-lg bg-surface-input border border-edge-soft p-4 text-xs text-ink-muted">
                Per-scene regenerate isn't available for this render — it was made before scene-by-scene persistence shipped.
                Re-render this listing once to enable surgical fixes for any single scene.
              </div>
            )}
          </div>
        )}

        {/* Footer extras */}
        <div className="px-6 sm:px-8 py-6 mt-6 border-t border-edge-soft flex flex-wrap items-center gap-4">
          {entry.thumbnailUrl && (
            <a
              href={entry.thumbnailUrl}
              download
              className="text-xs text-ink-muted hover:text-gold transition-colors inline-flex items-center gap-1.5"
            >
              ↓ Download poster image
            </a>
          )}
          {entry.narrationApplied && (
            <span className="text-xs text-gold-light inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-gold" />
              Narrated
            </span>
          )}
          {entry.listingPrice && (
            <span className="text-xs text-ink-muted ml-auto">
              {entry.listingPrice}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* v23: EngineBreakdownBadge — honest disclosure of how each scene was
   actually rendered. Cinematic AI users paying for Runway should know
   when scenes fell back to Ken Burns (motion-only) so they can trust
   what they're getting. Click to expand for the per-scene reasons. */
function EngineBreakdownBadge({ scenes }: { scenes: any[] }) {
  const [expanded, setExpanded] = useState(false);

  // Tally engines used.
  const total = scenes.length;
  const cinematic = scenes.filter((s) => (s.engineUsed || (s.wasFallback ? "ken_burns" : "cinematic_ai")) === "cinematic_ai").length;
  const kenBurns = total - cinematic;
  const allCinematic = kenBurns === 0;

  // Group fallback reasons for the expanded view.
  const fallbacks = scenes
    .filter((s) => (s.engineUsed || (s.wasFallback ? "ken_burns" : "cinematic_ai")) === "ken_burns")
    .map((s) => ({
      sceneIndex: s.sceneIndex,
      roomType: s.roomType || "scene",
      reason: s.fallbackReason || (s.wasFallback ? "fallback" : "")
    }));

  return (
    <div className={
      "rounded-lg border " +
      (allCinematic
        ? "border-gold/30 bg-gold/5"
        : "border-edge-soft bg-surface-input")
    }>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center justify-between gap-3"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={
            "w-7 h-7 rounded-full grid place-items-center text-[11px] font-bold flex-shrink-0 " +
            (allCinematic
              ? "bg-gold text-paper"
              : "bg-surface text-ink-muted border border-edge")
          }>
            {allCinematic ? "✓" : `${kenBurns}`}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tightish">
              {allCinematic
                ? `All ${total} scenes used Cinematic AI`
                : `${cinematic} of ${total} scenes used Cinematic AI`}
            </div>
            <div className="text-xs text-ink-muted mt-0.5 truncate">
              {allCinematic
                ? "Every scene rendered with the AI engine."
                : `${kenBurns} scene${kenBurns === 1 ? "" : "s"} rendered with motion-only fallback. Tap to see which.`}
            </div>
          </div>
        </div>
        {!allCinematic && (
          <span className="text-ink-muted text-sm flex-shrink-0">
            {expanded ? "↑" : "↓"}
          </span>
        )}
      </button>
      {expanded && fallbacks.length > 0 && (
        <div className="border-t border-edge-soft px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-ink-dim mb-2">
            Fallback details
          </div>
          <ul className="flex flex-col gap-1.5">
            {fallbacks.map((f) => (
              <li key={f.sceneIndex} className="text-xs flex items-start gap-2">
                <span className="font-mono text-ink-dim flex-shrink-0">
                  Scene {(f.sceneIndex ?? 0) + 1}
                </span>
                <span className="text-ink-muted">
                  {formatRoomLabel(f.roomType)}
                  {f.reason && (
                    <span className="text-ink-dim"> — {humanizeReason(f.reason)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="text-[11px] text-ink-dim mt-3 leading-relaxed">
            Motion-only scenes look polished but use a slow zoom/pan instead of AI motion.
            We use them to protect against AI hallucinations on tricky scenes (kitchens,
            mirrored bathrooms) and to recover when the AI service has an issue.
          </div>
        </div>
      )}
    </div>
  );
}

// Map machine reasons to readable phrases.
function humanizeReason(reason: string): string {
  if (reason.startsWith("hallucination_guard")) return "AI safety check (kitchen/detail risk)";
  if (reason.startsWith("compliance_mode")) return "MLS-compliance mode";
  if (reason.startsWith("runway_error")) return "AI service timed out, used motion fallback";
  return reason;
}

/* v23.2 RenderDetailsPanel — collapsed diagnostic strip on every library
   entry. Shows exactly what shipped on this render: which Runway model
   ran, whether narration fired (and which voice), color grade, address
   card, twilight conversion, etc. Replaces the "I think it worked?"
   guesswork that hid the never-firing voice narrator for all of launch.

   Closed by default so it doesn't compete with the video preview for
   attention. One click reveals everything. Power-user / debug feature
   but useful to every user when something looks off. */
function RenderDetailsPanel({ entry }: { entry: LibraryEntry }) {
  const [open, setOpen] = useState(false);
  const cfg = entry.renderConfig || {};
  // Diagnostic panel applies to any AI engine (runway or depth).
  const isRunway = isAiVideoEngine(entry.engine);

  const rows: Array<{ label: string; value: string; ok: boolean | null }> = [
    {
      label: "Engine",
      value: isRunway
        ? `Cinematic AI · ${cfg.runwayModelRequested || "gen4_turbo"}`
        : "Quick Reel · Remotion Ken Burns",
      ok: true
    },
    {
      label: "Style pack",
      value: cfg.selectedStyle || "—",
      ok: true
    },
    {
      label: "Narration",
      value: entry.narrationApplied
        ? `Applied · ${entry.narrationVoiceId ? entry.narrationVoiceId.slice(0, 12) + "…" : "default voice"}`
        : "Skipped (ElevenLabs unavailable or disabled)",
      ok: entry.narrationApplied
    },
    {
      label: "Twilight Magic",
      value: cfg.twilightHero ? "Applied to hero shot" : "Off",
      ok: cfg.twilightHero ? true : null
    },
    {
      label: "Address card",
      value: cfg.disableAddressCard ? "Off" : "Included (3.5s opener)",
      ok: !cfg.disableAddressCard
    },
    {
      label: "Hallucination guard",
      value: cfg.hallucinationGuard
        ? cfg.hallucinationGuard === "off"
          ? "Off (pure AI motion — kitchens may morph)"
          : cfg.hallucinationGuard === "strict"
            ? "Strict (kitchens always Ken Burns)"
            : "Balanced (smart per-scene)"
        : (cfg.complianceMode ? "Compliance mode (all Ken Burns)" : "Balanced (default)"),
      ok: true
    },
    {
      label: "Prompt version",
      value: entry.promptVersion || "(pre-v23.0)",
      ok: true
    },
    {
      label: "Plan tier",
      value: cfg.userTier || "—",
      ok: true
    }
  ];

  // Per-scene engine breakdown summary (Runway only).
  const sceneSummary = isRunway && entry.scenes.length > 0 ? (() => {
    const total = entry.scenes.length;
    const cinematic = entry.scenes.filter((s) =>
      (s.engineUsed || (s.wasFallback ? "ken_burns" : "cinematic_ai")) === "cinematic_ai"
    ).length;
    return `${cinematic} of ${total} scenes used Cinematic AI · ${total - cinematic} motion fallback`;
  })() : null;

  return (
    <div className="rounded-xl border border-edge-soft bg-surface-input/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-surface-input transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-xs uppercase tracking-widest text-ink-dim font-mono">
            Render details
          </span>
          {!entry.narrationApplied && (
            <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40 uppercase">
              No narration
            </span>
          )}
        </div>
        <span className={cn(
          "text-ink-muted transition-transform flex-shrink-0 text-xs",
          open ? "rotate-180" : "rotate-0"
        )}>▼</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-2 border-t border-edge-soft flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="text-ink-dim font-mono uppercase tracking-wider text-[10px] flex-shrink-0 w-32">
                {r.label}
              </span>
              <span className={cn(
                "text-ink-muted text-right",
                r.ok === false && "text-amber-300"
              )}>
                {r.value}
              </span>
            </div>
          ))}
          {sceneSummary && (
            <div className="flex items-baseline justify-between gap-3 text-xs pt-1 border-t border-edge-soft mt-1">
              <span className="text-ink-dim font-mono uppercase tracking-wider text-[10px] flex-shrink-0 w-32">
                Scene breakdown
              </span>
              <span className="text-ink-muted text-right">{sceneSummary}</span>
            </div>
          )}
          <div className="text-[10px] text-ink-dim leading-relaxed pt-2 mt-1 border-t border-edge-soft">
            Job ID: <span className="font-mono">{entry.jobId}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function DeliverablePill({ label, sublabel, url }: { label: string; sublabel: string; url: string }) {
  return (
    <a
      href={url}
      download
      className="card-press flex items-center justify-between gap-3 p-3 bg-surface-input hover:bg-surface-raised border border-edge hover:border-gold rounded-lg transition-colors"
    >
      <div>
        <div className="font-mono text-base font-semibold text-gold">{label}</div>
        <div className="text-xs text-ink-muted">{sublabel}</div>
      </div>
      <span className="text-ink-muted text-sm">↓</span>
    </a>
  );
}

function ShortPill({ clipNumber, url }: { clipNumber: number; url: string }) {
  const [loadFailed, setLoadFailed] = useState(false);
  return (
    <a
      href={url}
      download
      className="card-press group block bg-surface-input hover:bg-surface-raised border border-edge hover:border-gold rounded-lg overflow-hidden transition-colors"
    >
      <div className="aspect-[9/16] bg-black grid place-items-center text-gold/60 text-xs font-mono uppercase tracking-wider relative">
        {!loadFailed ? (
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            onError={() => setLoadFailed(true)}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <span className="text-ink-dim">Short {clipNumber}</span>
        )}
        <span className="relative bg-paper/70 backdrop-blur-sm px-2 py-0.5 rounded text-[10px]">
          ↓ {clipNumber}
        </span>
      </div>
    </a>
  );
}

// ============================================================
// Scenes grid + regen flow
// ============================================================

interface RegenJobState {
  sceneIndex: number;
  mode: RegenerateMode;
  status: "queued" | "rendering" | "completed" | "failed";
  phase: string;
  progress: number;
  jobId?: string;
  error?: string;
}

function ScenesRegenGrid({
  entry,
  onUpdated
}: {
  entry: LibraryEntry;
  onUpdated?: () => void;
}) {
  // Track exactly ONE active regen at a time. Concurrent regens against the
  // same master would race each other's audit-row writes — by design.
  const [active, setActive] = useState<RegenJobState | null>(null);

  // Pull the agent's CURRENT branding from the store. The regen flow re-stitches
  // the video end-to-end so it picks up the latest brand kit — exactly what you
  // want if you've updated your headshot / logo / license since the original render.
  const branding = useStore((s) => s.branding);
  const profileUserId = useStore((s) => s.profile?.user_id || s.session?.user?.id || "");

  const handleRegen = async (sceneIndex: number, mode: RegenerateMode) => {
    if (active) return;
    const targetScene = entry.scenes.find((s) => s.sceneIndex === sceneIndex);
    if (!targetScene) return;

    setActive({
      sceneIndex,
      mode,
      status: "queued",
      phase: "Submitting…",
      progress: 0
    });

    try {
      const manifest = buildRegenManifest(entry, branding, profileUserId);
      const result = await submitRegenerateScene({
        jobId: entry.jobId,
        sceneIndex,
        mode,
        manifest
      });

      if (result.status === "failed" || !result.jobId) {
        setActive({
          sceneIndex,
          mode,
          status: "failed",
          phase: "Failed",
          progress: 100,
          error: result.error || "Regenerate submission failed."
        });
        return;
      }

      // Poll the worker until completion. Worker progress goes 5 → 100 across
      // the orchestrator. Total runtime is typically 60-180 seconds.
      const progressKey = result.jobId;
      let lastStatus: RegenJobState = {
        sceneIndex,
        mode,
        status: "rendering",
        phase: "Working…",
        progress: 5,
        jobId: progressKey
      };
      setActive(lastStatus);

      while (true) {
        await new Promise((r) => setTimeout(r, 2500));
        const status = await pollRender(progressKey);
        lastStatus = {
          sceneIndex,
          mode,
          status: status.status,
          phase: status.phase || lastStatus.phase,
          progress: status.progress ?? lastStatus.progress,
          jobId: progressKey,
          error: status.error
        };
        setActive(lastStatus);
        if (status.status === "completed" || status.status === "failed") break;
      }

      if (lastStatus.status === "completed") {
        // Brief 1.5s "Done!" indicator before clearing — visually confirms
        // success before the modal reloads with the new master URL.
        setTimeout(() => {
          setActive(null);
          onUpdated?.();
        }, 1500);
      }
    } catch (err) {
      setActive({
        sceneIndex,
        mode,
        status: "failed",
        phase: "Failed",
        progress: 100,
        error: err instanceof Error ? err.message : "Regenerate failed."
      });
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {entry.scenes
          .slice()
          .sort((a, b) => a.sceneIndex - b.sceneIndex)
          .map((scene) => (
            <SceneCell
              key={scene.sceneIndex}
              scene={scene}
              activeJob={active?.sceneIndex === scene.sceneIndex ? active : null}
              disabled={Boolean(active) && active?.sceneIndex !== scene.sceneIndex}
              onRegen={handleRegen}
            />
          ))}
      </div>
      <div className="text-[11px] text-ink-dim leading-relaxed">
        Each regen takes 60–180 seconds and re-stitches the full video.
        Cinematic AI regen uses one Runway credit (~$0.25). Replace with Ken Burns is free and guarantees no AI hallucinations.
      </div>
    </div>
  );
}

function SceneCell({
  scene,
  activeJob,
  disabled,
  onRegen
}: {
  scene: LibrarySceneEntry;
  activeJob: RegenJobState | null;
  disabled: boolean;
  onRegen: (sceneIndex: number, mode: RegenerateMode) => void;
}) {
  const sceneLabel = `Scene ${scene.sceneIndex + 1}`;
  const roomLabel = scene.roomType ? formatRoomLabel(scene.roomType) : "";
  const isActive = Boolean(activeJob);

  return (
    <div
      className={`relative rounded-lg overflow-hidden border ${
        isActive ? "border-gold" : "border-edge"
      } bg-surface-input`}
    >
      <div className="aspect-video bg-black relative">
        {scene.photoUrl ? (
          <img
            src={scene.photoUrl}
            alt={sceneLabel}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-ink-dim text-xs">
            No preview
          </div>
        )}
        <div className="absolute top-1.5 left-1.5 bg-paper/85 backdrop-blur-sm px-1.5 py-0.5 rounded text-[10px] font-mono text-gold">
          {String(scene.sceneIndex + 1).padStart(2, "0")}
        </div>
        {scene.wasFallback && (
          <div className="absolute top-1.5 right-1.5 bg-paper/85 backdrop-blur-sm px-1.5 py-0.5 rounded text-[10px] text-ink-muted">
            Ken Burns
          </div>
        )}
        {isActive && (
          <div className="absolute inset-0 bg-paper/85 backdrop-blur-sm grid place-items-center text-center p-2">
            {activeJob?.status === "completed" ? (
              <div>
                <div className="text-gold text-xs font-semibold mb-1">✓ Done</div>
                <div className="text-[10px] text-ink-muted">Reloading…</div>
              </div>
            ) : activeJob?.status === "failed" ? (
              <div>
                <div className="text-rose-300 text-xs font-semibold mb-1">Failed</div>
                <div className="text-[10px] text-ink-muted leading-tight">
                  {(activeJob.error || "Regen failed").slice(0, 70)}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-gold text-xs font-semibold mb-1">
                  {activeJob?.progress ?? 0}%
                </div>
                <div className="text-[10px] text-ink-muted leading-tight">
                  {activeJob?.phase || "Working…"}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="p-2">
        <div className="flex items-center justify-between text-[11px] mb-1.5">
          <span className="text-ink font-medium">{sceneLabel}</span>
          {roomLabel && <span className="text-ink-muted">{roomLabel}</span>}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            disabled={disabled || isActive || !scene.clipUrl}
            onClick={() => onRegen(scene.sceneIndex, "ai")}
            title={!scene.clipUrl ? "This scene wasn't persisted — can't regen." : "Re-roll the AI motion"}
            className="px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold bg-gold/10 hover:bg-gold/20 text-gold border border-gold/30 hover:border-gold rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Regen AI
          </button>
          <button
            type="button"
            disabled={disabled || isActive || !scene.clipUrl}
            onClick={() => onRegen(scene.sceneIndex, "kenburns")}
            title={!scene.clipUrl ? "This scene wasn't persisted — can't regen." : "Replace with a safe Ken Burns motion clip"}
            className="px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold bg-surface-raised hover:bg-surface-input text-ink-muted hover:text-ink border border-edge hover:border-ink-muted rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Use KB
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRoomLabel(room: string): string {
  const r = room.toLowerCase();
  if (r === "living") return "Living";
  if (r === "kitchen") return "Kitchen";
  if (r === "bedroom") return "Bedroom";
  if (r === "bathroom") return "Bath";
  if (r === "exterior") return "Exterior";
  if (r === "outdoor") return "Outdoor";
  if (r === "amenity") return "Amenity";
  if (r === "detail") return "Detail";
  return r.charAt(0).toUpperCase() + r.slice(1);
}

// Build the minimal manifest the worker needs for per-scene regen. The
// worker's regenerator falls back to the audit row for prompt + photo URL
// when a field isn't in the manifest, so we only need to ship the bits
// the worker can't reconstruct from the audit row itself:
//   - orderedPhotos (so generateClip's pickImageUrl finds the durable URL)
//   - brandKit (for watermark + outro card composition)
//   - runwayConfig (model / ratio — sensible defaults if absent)
//   - project.userId (Supabase storage path scoping)
function buildRegenManifest(
  entry: LibraryEntry,
  branding: import("../lib/types").AgentBranding,
  userId: string
): RenderManifest {
  // Reconstruct orderedPhotos from the per-scene metadata so the worker can
  // find the durable photo URL when generateClip looks it up by photoId.
  const seen = new Set<string>();
  const orderedPhotos: Photo[] = [];
  for (const s of entry.scenes) {
    if (!s.photoId || seen.has(s.photoId)) continue;
    seen.add(s.photoId);
    orderedPhotos.push({
      id: s.photoId,
      fileName: `${s.photoId}.jpg`,
      publicUrl: s.photoUrl,
      durableUrl: s.photoUrl,
      storagePath: "",
      bucket: "",
      width: 0,
      height: 0,
      size: 0,
      category: undefined,
      caption: "",
      order: s.sceneIndex,
      uploadedAt: entry.createdAt
    });
  }

  return {
    app: "EstateMotion",
    engine: "runway",
    exportFormat: "vertical",
    project: {
      id: entry.jobId,
      userId,
      title: entry.projectTitle,
      address: entry.listingAddress,
      city: entry.listingCity,
      price: entry.listingPrice
    },
    scenes: entry.scenes
      .slice()
      .sort((a, b) => a.sceneIndex - b.sceneIndex)
      .map((s) => ({
        photoId: s.photoId,
        type: "photo" as const,
        durableUrl: s.photoUrl,
        publicUrl: s.photoUrl,
        fileName: `${s.photoId}.jpg`,
        duration: s.duration,
        roomType: s.roomType,
        cameraMotion: s.cameraMotion,
        transition: "crossfade",
        overlay: { headline: "", subline: "" },
        runwayPrompt: s.runwayPrompt
      })),
    orderedPhotos,
    introCard: { headline: "", subline: "" },
    outroCard: { headline: "", subline: "" },
    musicMood: "",
    selectedStyle: "cinematic-luxury",
    runwayConfig: {
      model: "gen4_turbo",
      ratio: "9:16",
      useCrossfades: false
    },
    brandKit: branding,
    // Skip narration on regen by default — re-synthesizing 24 ElevenLabs
    // lines for a one-scene fix is wasteful and the original master's
    // narration was timed to the original stitch. Music-only master ships
    // ~30 seconds faster.
    skipNarration: true,
    regenSkipNarration: true,
    export4K: false
  };
}

// The audit log only stores the master URL — but the worker uploads
// every variant and short with deterministic filenames into the same
// folder. We can derive the others by string substitution. If the URLs
// don't match the expected pattern, fall back to the master URL itself.
function inferDeliverableUrls(masterUrl: string, entry: LibraryEntry): {
  vertical: string;
  square: string;
  wide: string;
  shorts: string[];
} {
  if (!masterUrl) {
    return { vertical: "", square: "", wide: "", shorts: [] };
  }
  // Worker uploads as <basePath>/master.mp4 for vertical, square.mp4, wide.mp4
  const vertical = masterUrl;
  const square = masterUrl.replace(/\/master\.mp4(\?|$)/, "/square.mp4$1");
  const wide = masterUrl.replace(/\/master\.mp4(\?|$)/, "/wide.mp4$1");
  const shorts = Array.from({ length: entry.socialShortCount }).map((_, i) =>
    masterUrl.replace(/\/master\.mp4(\?|$)/, `/short-${i + 1}.mp4$1`)
  );
  return { vertical, square, wide, shorts };
}
