import { useEffect, useState } from "react";
import type { LibraryEntry, LibrarySceneEntry, Photo } from "../lib/types";
import { useStore } from "../lib/store";
import {
  pollRender,
  submitRegenerateScene,
  deleteLibraryEntry,
  type RegenerateMode,
  type RenderManifest
} from "../lib/api";
import { cn } from "../lib/cn";
import { engineLabel, isAiVideoEngine } from "../lib/engine-labels";
import { downloadVideo, deliverableFilename } from "../lib/download";

/**
 * Library detail modal — shown when an agent clicks a render in their
 * dashboard. v24+ ships a single 9:16 master video per render (the
 * variant fan-out + social shorts were removed). This modal surfaces
 * the master mp4 + thumbnail + per-scene regen controls.
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

  // v24.5 delete-entry state. `confirmDelete` is the two-stage gate so the
  // user has to deliberately confirm before the audit row + storage folder
  // are wiped. `deleting` blocks repeated clicks. `deleteError` surfaces
  // failures from the API.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>("");

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const result = await deleteLibraryEntry(entry.jobId);
      if (result.status === "ok") {
        // Reload the dashboard library so the deleted card disappears,
        // then close the modal.
        onUpdated?.();
        onClose();
        return;
      }
      setDeleteError(result.error || "Couldn't delete this video.");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete this video.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-paper/90 backdrop-blur-sm p-4 sm:p-8 fade-up-in"
      onClick={onClose}
    >
      {/* v26: dialog semantics — without role/aria-modal, screen readers
          treat this as ordinary page content layered on top. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="spring-in bg-surface border border-edge rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto"
        style={{ background: "radial-gradient(600px 200px at 50% -5%, rgba(199,167,108,0.08), transparent 60%), #16161B" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 sm:px-8 pt-6 sm:pt-8 pb-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-widest text-gold font-mono mb-1.5">
              {labelText} · {dateLabel}
            </p>
            <h2 className="font-display text-2xl sm:text-3xl font-semibold tracking-tighter2 truncate">
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

        {/* Master video preview — v24.5: height-first sizing centers the
            9:16 vertical master inside a black pillarbox container instead
            of stretching it to full modal width. Prior CSS used `w-full
            max-h-[60vh]` which made the video element render at modal
            width and the actual 9:16 frame got cropped/letterboxed
            unpredictably on different viewports. New layout: black
            container, video centered with object-contain, height capped
            at 65vh so the rest of the modal stays visible without
            scrolling. */}
        <div className="px-6 sm:px-8">
          <div className="rounded-lg bg-black flex items-center justify-center overflow-hidden">
            <video
              src={masterUrl}
              controls
              playsInline
              poster={entry.thumbnailUrl}
              className="block w-auto h-auto max-w-full max-h-[65vh] object-contain"
            />
          </div>
        </div>

        {/* v33.3: the engine-breakdown badge ("7 of 9 scenes used Cinematic
            AI · 2 motion-only fallback") was internal telemetry leaking into
            customer UI — removed. Per-scene regen below still lets users fix
            any scene they don't like, which is the actionable version. */}

        {/* v23.2 Render Details panel — diagnostic strip showing exactly
            what shipped on this render. Eliminates the "is it actually
            working?" guesswork that masked the voice-narrator-never-fired
            bug for the whole launch week. Collapsed by default; one
            click reveals the full per-feature audit. */}
        <div className="px-6 sm:px-8 mt-4">
          <RenderDetailsPanel entry={entry} />
        </div>

        {/* v33.3 Downloads — every format the render produced, one click
            each, real file downloads (blob-forced; the download attribute is
            ignored cross-origin and used to NAVIGATE to the mp4). */}
        <div className="px-6 sm:px-8 mt-6 flex flex-col gap-2.5">
          <h3 className="text-sm font-semibold tracking-tightish">Downloads</h3>
          <DeliverablePill
            label="Vertical · 9:16"
            sublabel="Instagram Reels · TikTok · YouTube Shorts"
            url={inferredUrls.vertical}
            filename={deliverableFilename(heading, "vertical")}
          />
          {/* v35.1: square is opt-in per render — only show the pill when
              this render actually produced it (formatsCount counts the
              uploaded variants; vertical-only renders have 1). */}
          {entry.formatsCount >= 2 && inferredUrls.square && (
            <DeliverablePill
              label="Square · 1:1"
              sublabel="Instagram & Facebook feed"
              url={inferredUrls.square}
              filename={deliverableFilename(heading, "square")}
            />
          )}
          {/* v35: wide (16:9) retired — a pillarboxed 9:16 isn't shippable
              quality. Returns with per-aspect generation (Formats pack). */}
        </div>

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
            <span className="text-xs text-ink-muted">
              {entry.listingPrice}
            </span>
          )}
          {/* v42: discreet support reference (was a "Job ID" row inside the
              details panel — demo energy; support still needs it). */}
          <span className="text-[10px] text-ink-dim font-mono" title="Reference for support">
            Ref {entry.jobId.slice(-8)}
          </span>
          {/* v24.5: delete this render. Two-stage confirm so a mis-click
              doesn't nuke an entry the agent worked 10 minutes on. */}
          <div className="ml-auto flex items-center gap-2">
            {deleteError && (
              <span className="text-[11px] text-rose-300">{deleteError}</span>
            )}
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
                className="text-xs text-ink-muted hover:text-rose-300 transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                Delete video
              </button>
            ) : (
              <>
                <span className="text-[11px] text-ink-muted">Permanently delete this render?</span>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  className="px-2.5 py-1 text-[11px] rounded-md bg-surface-input border border-edge hover:border-ink-muted text-ink-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-rose-500/15 border border-rose-500/40 hover:bg-rose-500/25 text-rose-200 disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* (EngineBreakdownBadge + humanizeReason removed v42 — dead since v33.3
   pulled the engine-breakdown telemetry out of customer UI.) */

/* v42 "Video details" — the premium fact strip that replaced the collapsed
   diagnostic panel (Troy: "more of a demo style thing"). Always visible,
   landing-page design language: mono gold eyebrow, serif values, gold dot
   markers. Customer vocabulary only — style, voice, captions, length,
   formats. Support reference (job id) lives discreetly in the footer. */
function RenderDetailsPanel({ entry }: { entry: LibraryEntry }) {
  const cfg = entry.renderConfig || {};

  const styleLabel = cfg.selectedStyle || engineLabel(entry.engine);
  const narrationValue = entry.narrationApplied
    ? (entry.narrationVoiceId && !/^[a-z]+-[a-z]+$/.test(entry.narrationVoiceId)
        ? "Your cloned voice"
        : "Studio voice")
    : "Off";
  // Prefer what actually shipped (captionsApplied) over what was asked for
  // (captionsEnabled); older rows have neither and default sensibly.
  const captionsValue = entry.narrationApplied
    ? (cfg.captionsApplied === false || cfg.captionsEnabled === false ? "Off" : "Word-synced")
    : "—";
  const lengthValue = cfg.targetDurationSec ? `~${cfg.targetDurationSec}s tour` : "";
  const formatsValue = entry.formatsCount >= 2 ? "9:16 vertical + 1:1 square" : "9:16 vertical";

  const facts: Array<{ label: string; value: string }> = [
    { label: "Style", value: styleLabel },
    { label: "Narration", value: narrationValue },
    { label: "Captions", value: captionsValue },
    ...(lengthValue ? [{ label: "Length", value: lengthValue }] : []),
    { label: "Formats", value: formatsValue }
  ].filter((f) => f.value && f.value !== "—");

  return (
    <div
      className="rounded-xl border border-edge-soft px-5 py-4"
      style={{ background: "radial-gradient(400px 120px at 0% 0%, rgba(199,167,108,0.06), transparent 60%), rgba(28,28,35,0.4)" }}
    >
      <p className="text-[10px] uppercase tracking-[0.22em] text-gold font-mono mb-3">
        Video details
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-ink-dim font-mono mb-0.5">
              {f.label}
            </div>
            <div className="text-sm text-ink flex items-center gap-1.5 truncate">
              <span className="w-1 h-1 rounded-full bg-gold flex-shrink-0" />
              <span className="truncate">{f.value}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DeliverablePill({ label, sublabel, url, filename }: { label: string; sublabel: string; url: string; filename: string }) {
  const [busy, setBusy] = useState(false);
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await downloadVideo(url, filename);
    } finally {
      setBusy(false);
    }
  };
  return (
    <a
      href={url}
      onClick={handleDownload}
      className="card-press flex items-center justify-between gap-3 p-3 bg-surface-input hover:bg-surface-raised border border-edge hover:border-gold rounded-lg transition-colors"
    >
      <div>
        <div className="font-mono text-base font-semibold text-gold">{label}</div>
        <div className="text-xs text-ink-muted">{sublabel}</div>
      </div>
      <span className="text-ink-muted text-sm">{busy ? "Saving…" : "↓"}</span>
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

  // A failed regen used to leave `active` set forever — the error overlay
  // stuck to the card and every OTHER scene's buttons stayed disabled until
  // the modal was reopened. Show the reason for a few seconds, then release
  // the grid so "just click it again" works.
  const releaseAfterFailure = (sceneIndex: number) => {
    setTimeout(() => {
      setActive((cur) =>
        cur && cur.status === "failed" && cur.sceneIndex === sceneIndex ? null : cur
      );
    }, 7000);
  };

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
        releaseAfterFailure(sceneIndex);
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

      // Poll with tolerance: a single failed poll (worker mid-deploy, network
      // blip) must NOT kill a regen that's still running server-side — the
      // job now lives in the render_jobs queue and survives worker restarts.
      // Only surface an error after ~5 straight failures (~12s dark), and cap
      // the whole wait at 12 minutes (worker hard-caps regen at 10).
      const startedAt = Date.now();
      let consecutivePollErrors = 0;
      while (true) {
        await new Promise((r) => setTimeout(r, 2500));
        let status;
        try {
          status = await pollRender(progressKey);
          consecutivePollErrors = 0;
        } catch (pollErr) {
          consecutivePollErrors++;
          if (consecutivePollErrors < 5) continue;
          throw pollErr;
        }
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
        if (Date.now() - startedAt > 12 * 60 * 1000) {
          throw new Error("This is taking longer than it should. Reopen this listing in a couple of minutes — if the scene hasn't updated, run the fix again.");
        }
      }

      if (lastStatus.status === "completed") {
        // Brief 1.5s "Done!" indicator before clearing — visually confirms
        // success before the modal reloads with the new master URL.
        setTimeout(() => {
          setActive(null);
          onUpdated?.();
        }, 1500);
      } else {
        // Worker reported failed — show the reason, then free the grid.
        releaseAfterFailure(sceneIndex);
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
      releaseAfterFailure(sceneIndex);
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
        Redo with AI re-creates a scene with fresh cinematic motion and re-stitches your
        video (60–180 seconds). Photo Motion swaps in a clean, artifact-free camera move —
        instant peace of mind for compliance-sensitive listings.
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
            Photo Motion
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
            title={!scene.clipUrl ? "This scene wasn't saved with the render — re-render the listing to enable fixes." : "Re-create this scene with fresh cinematic motion"}
            className="px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold bg-gold/10 hover:bg-gold/20 text-gold border border-gold/30 hover:border-gold rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Redo with AI
          </button>
          <button
            type="button"
            disabled={disabled || isActive || !scene.clipUrl}
            onClick={() => onRegen(scene.sceneIndex, "kenburns")}
            title={!scene.clipUrl ? "This scene wasn't saved with the render — re-render the listing to enable fixes." : "Replace with a clean, artifact-free camera move"}
            className="px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold bg-surface-raised hover:bg-surface-input text-ink-muted hover:text-ink border border-edge hover:border-ink-muted rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Photo Motion
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
    app: "Vistalia",
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
    // v42 FIX: these were hardcoded ("cinematic-luxury", crossfades off),
    // so regenerating one scene on an MLS/Investor render re-stitched the
    // video with the WRONG style context and different transitions than
    // the original. Pull the original render's actual config.
    musicMood: entry.renderConfig?.musicMood || "",
    selectedStyle: entry.renderConfig?.selectedStyle || "Cinematic Luxury",
    musicTrack: entry.renderConfig?.musicTrack || undefined,
    captionsEnabled: entry.renderConfig?.captionsEnabled,
    runwayConfig: {
      model: "gen4_turbo",
      ratio: "9:16",
      useCrossfades: entry.renderConfig?.useCrossfades !== false
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
  shorts: string[];
} {
  if (!masterUrl) {
    return { vertical: "", square: "", shorts: [] };
  }
  // Worker uploads as <basePath>/master.mp4 for vertical + square.mp4
  // (v35: square is a true 1:1 re-composition, not a master crop; wide
  // retired until per-aspect generation ships).
  const vertical = masterUrl;
  const square = masterUrl.replace(/\/master\.mp4(\?|$)/, "/square.mp4$1");
  const shorts = Array.from({ length: entry.socialShortCount }).map((_, i) =>
    masterUrl.replace(/\/master\.mp4(\?|$)/, `/short-${i + 1}.mp4$1`)
  );
  return { vertical, square, shorts };
}
