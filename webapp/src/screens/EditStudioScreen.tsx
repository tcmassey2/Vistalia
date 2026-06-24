import { useState } from "react";
import { useStore } from "../lib/store";
import { cn } from "../lib/cn";
import { submitRegenerateScene, pollRender, RenderJobMissingError } from "../lib/api";
import type { SceneClipMeta } from "../lib/types";

/**
 * EditStudioScreen — post-render scene editor.
 *
 * Opened from a completed render. Lists every generated scene clip and lets the
 * agent re-render a single one if it came out wrong, without redoing the whole
 * video. Re-renders are FREE. After 2 failed AI attempts on a scene, it auto-
 * falls back to a Ken Burns clip (which can't hallucinate).
 *
 * All backend work already exists (api/regenerate-scene → worker regenerate-job):
 * we submit { jobId, sceneIndex, mode, manifest } and poll the returned
 * progressKey. On success the worker returns the new master URL + updated
 * scenes[], which we write back into the store so the final video updates here
 * and everywhere.
 *
 * Styling mirrors the rest of the app: surface/edge/gold/ink tokens, card-press,
 * fade-up-in. No new animation language is introduced.
 */

type SceneStatus = "idle" | "regenerating" | "done" | "failed";

interface SceneUiState {
  status: SceneStatus;
  aiAttempts: number;     // failed/used AI attempts → 2 triggers auto Ken Burns
  phase: string;
  progress: number;
  clipUrl: string;        // current clip (updates after a successful regen)
  isKenBurns: boolean;
  error: string;
}

export default function EditStudioScreen() {
  const renderJob = useStore((s) => s.renderJob);
  const manifest = useStore((s) => s.lastRenderManifest);
  const setRenderJob = useStore((s) => s.setRenderJob);
  const goToScreen = useStore((s) => s.goToScreen);
  const setToast = useStore((s) => s.setToast);

  const scenes = renderJob?.scenes || [];
  const jobId = renderJob?.jobId || "";
  const masterUrl = renderJob?.mp4Url || "";

  // Per-scene UI state, keyed by sceneIndex.
  const [sceneState, setSceneState] = useState<Record<number, SceneUiState>>({});
  // Bumped only after a successful regen, to cache-bust the master that the
  // worker overwrites in place. Previously we busted with Date.now() inline on
  // every render, which changed the <video> src constantly and made the preview
  // reload forever instead of playing.
  const [previewVersion, setPreviewVersion] = useState(0);

  const stateFor = (s: SceneClipMeta): SceneUiState =>
    sceneState[s.sceneIndex] || {
      status: "idle",
      aiAttempts: 0,
      phase: "",
      progress: 0,
      clipUrl: s.clipUrl || "",
      isKenBurns: Boolean(s.wasFallback),
      error: ""
    };

  const patchScene = (sceneIndex: number, patch: Partial<SceneUiState>) =>
    setSceneState((prev) => ({
      ...prev,
      [sceneIndex]: { ...stateFor({ sceneIndex } as SceneClipMeta), ...prev[sceneIndex], ...patch }
    }));

  // Core: submit a regen for one scene, poll to completion, swap results in.
  const runRegen = async (sceneIndex: number, mode: "ai" | "kenburns") => {
    if (!manifest || !jobId) {
      patchScene(sceneIndex, { status: "failed", error: "Missing render context — open Edit Studio right after a render." });
      return;
    }
    patchScene(sceneIndex, {
      status: "regenerating",
      phase: mode === "kenburns" ? "Switching to Ken Burns…" : "Re-rendering scene…",
      progress: 5,
      error: ""
    });

    try {
      const submitted = await submitRegenerateScene({ jobId, sceneIndex, mode, manifest });
      if (submitted.status === "failed" || !submitted.jobId) {
        throw new Error(submitted.error || "Couldn't start the re-render.");
      }
      const progressKey = submitted.jobId;

      // Poll the regen job (reuses the standard render status surface).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await sleep(2500);
        let status;
        try {
          status = await pollRender(progressKey);
        } catch (err) {
          if (err instanceof RenderJobMissingError) {
            throw new Error("The re-render job was lost (worker restarted). Try again.");
          }
          throw err;
        }
        patchScene(sceneIndex, {
          phase: status.phase || "Working…",
          progress: Math.max(5, Math.min(99, status.progress || 5))
        });

        if (status.status === "completed") {
          // The worker overwrites the master at the same URL; bust any cache.
          const freshScenes = status.scenes && status.scenes.length ? status.scenes : scenes;
          const newClip = freshScenes.find((x) => x.sceneIndex === sceneIndex)?.clipUrl || "";
          setRenderJob({
            ...(renderJob as NonNullable<typeof renderJob>),
            mp4Url: status.mp4Url || masterUrl,
            scenes: freshScenes
          });
          setPreviewVersion((v) => v + 1);
          patchScene(sceneIndex, {
            status: "done",
            phase: "Updated",
            progress: 100,
            clipUrl: bust(newClip),
            isKenBurns: mode === "kenburns"
          });
          setToast(mode === "kenburns" ? "Scene replaced with Ken Burns." : "Scene re-rendered.");
          return;
        }
        if (status.status === "failed") {
          throw new Error(status.error || "Re-render failed.");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Re-render failed.";
      // Auto Ken Burns: after 2 failed AI attempts, fall back automatically.
      const prevAttempts = stateFor({ sceneIndex } as SceneClipMeta).aiAttempts;
      const aiAttempts = mode === "ai" ? prevAttempts + 1 : prevAttempts;
      if (mode === "ai" && aiAttempts >= 2) {
        patchScene(sceneIndex, { aiAttempts, phase: "AI struggled twice — using Ken Burns…", error: "" });
        await runRegen(sceneIndex, "kenburns");
        return;
      }
      patchScene(sceneIndex, { status: "failed", aiAttempts, error: msg, progress: 0 });
    }
  };

  /* ---- guards ---- */
  if (!renderJob || renderJob.status !== "completed" || !scenes.length) {
    return (
      <div className="fade-up-in max-w-3xl mx-auto px-6 py-16 text-center">
        <h1 className="font-serif text-3xl text-ink mb-3">Edit Studio</h1>
        <p className="text-ink-muted mb-6">
          Open the Edit Studio right after a video finishes rendering — that's when each
          scene is available to fix individually.
        </p>
        <button onClick={() => goToScreen("project")} className="btn-primary px-5 py-2.5 rounded-xl">
          Back to project
        </button>
      </div>
    );
  }

  return (
    <div className="fade-up-in max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-gold mb-1">Edit Studio</div>
          <h1 className="font-serif text-3xl text-ink tracking-tightish">Fix any scene, keep the rest</h1>
          <p className="text-sm text-ink-muted mt-2 max-w-xl">
            Re-render a single scene if it came out wrong — the final video updates automatically.
            Re-renders are free. After two AI attempts, a scene switches to a guaranteed-safe Ken Burns clip.
          </p>
        </div>
        <button
          onClick={() => goToScreen("project")}
          className="card-press shrink-0 px-4 py-2 rounded-xl border border-edge-strong text-ink-soft hover:text-ink hover:border-gold transition-colors text-sm"
        >
          ← Back to project
        </button>
      </div>

      <div className="grid lg:grid-cols-[320px_1fr] gap-7 items-start">
        {/* Final video — sticky preview */}
        <div className="lg:sticky lg:top-6">
          <div className="rounded-2xl border border-edge bg-surface p-3">
            <div className="text-[11px] font-mono uppercase tracking-wider text-ink-muted mb-2 px-1">Final video</div>
            {masterUrl ? (
              <video
                key={`${masterUrl}:${previewVersion}`}
                src={withVersion(masterUrl, previewVersion)}
                controls
                playsInline
                preload="metadata"
                poster={renderJob.thumbnailUrl}
                className="w-full rounded-xl bg-black aspect-[9/16] object-contain"
              />
            ) : (
              <div className="w-full rounded-xl bg-surface-input aspect-[9/16] grid place-items-center text-ink-dim text-sm">
                No preview
              </div>
            )}
            {masterUrl && (
              <a
                href={masterUrl}
                download
                className="btn-primary mt-3 block text-center px-4 py-2.5 rounded-xl text-sm"
              >
                Download final
              </a>
            )}
          </div>
        </div>

        {/* Scene grid */}
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {scenes.map((scene) => (
            <SceneCard
              key={scene.sceneIndex}
              scene={scene}
              ui={stateFor(scene)}
              onRegen={() => runRegen(scene.sceneIndex, "ai")}
              onKenBurns={() => runRegen(scene.sceneIndex, "kenburns")}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SceneCard({
  scene,
  ui,
  onRegen,
  onKenBurns
}: {
  scene: SceneClipMeta;
  ui: SceneUiState;
  onRegen: () => void;
  onKenBurns: () => void;
}) {
  const busy = ui.status === "regenerating";
  const clip = ui.clipUrl || scene.clipUrl || "";
  const room = (scene.roomType || "Scene").replace(/(^|\s)\w/g, (c) => c.toUpperCase());
  const notRegenerable = !scene.clipUrl;

  return (
    <div className={cn(
      "rounded-xl border bg-surface overflow-hidden transition-colors",
      ui.status === "done" ? "border-gold/50" : ui.status === "failed" ? "border-red-500/40" : "border-edge"
    )}>
      {/* Preview */}
      <div className="relative aspect-[9/16] bg-black">
        {clip ? (
          <video src={clip} muted loop playsInline poster={scene.photoUrl}
            className="w-full h-full object-cover"
            onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
            onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
          />
        ) : scene.photoUrl ? (
          <img src={scene.photoUrl} alt={room} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full grid place-items-center text-ink-dim text-xs">No clip</div>
        )}

        {/* Scene index + room */}
        <div className="absolute top-2 left-2 flex items-center gap-1.5">
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-ink-soft border border-edge">
            {String(scene.sceneIndex + 1).padStart(2, "0")}
          </span>
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-ink-soft border border-edge">
            {room}
          </span>
        </div>

        {/* Ken Burns badge */}
        {ui.isKenBurns && (
          <span className="absolute top-2 right-2 font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-black/60 text-gold border border-gold/40">
            Ken Burns
          </span>
        )}

        {/* Busy overlay */}
        {busy && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm grid place-items-center text-center px-4">
            <div>
              <div className="text-sm text-ink mb-2">{ui.phase || "Working…"}</div>
              <div className="h-1.5 w-40 mx-auto rounded-full bg-edge overflow-hidden">
                <div className="h-full bg-gold transition-all duration-500" style={{ width: `${ui.progress}%` }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="p-3">
        {ui.status === "failed" && (
          <div className="text-[11px] text-red-300 mb-2 leading-relaxed">{ui.error}</div>
        )}
        {notRegenerable ? (
          <div className="text-[11px] text-ink-dim leading-relaxed">
            This scene wasn't persisted individually — a full re-render is needed to enable fixing it.
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={onRegen}
              disabled={busy}
              className={cn(
                "card-press flex-1 px-3 py-2 rounded-lg text-sm font-semibold transition-colors",
                busy ? "bg-surface-input text-ink-dim cursor-not-allowed"
                     : "bg-gold/10 text-gold border border-gold/30 hover:bg-gold/20"
              )}
            >
              {ui.status === "done" ? "Re-render again" : "Re-render scene"}
            </button>
            {ui.aiAttempts >= 1 && (
              <button
                onClick={onKenBurns}
                disabled={busy}
                title="Use a safe Ken Burns clip instead"
                className="card-press px-3 py-2 rounded-lg text-sm border border-edge-strong text-ink-soft hover:text-ink hover:border-gold transition-colors disabled:opacity-50"
              >
                Ken Burns
              </button>
            )}
          </div>
        )}
        {ui.aiAttempts > 0 && ui.status !== "regenerating" && (
          <div className="text-[10px] text-ink-dim mt-1.5 font-mono">
            AI attempts: {ui.aiAttempts}{ui.aiAttempts >= 2 ? " · auto Ken Burns" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

/* helpers */
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
// Cache-bust a URL whose content was overwritten at the same path.
function bust(url: string) {
  if (!url) return url;
  return url + (url.includes("?") ? "&" : "?") + "v=" + Date.now();
}
// Stable cache-bust: the URL is untouched on first load (version 0) and only
// gets a ?v=N suffix after a regen, so the preview src doesn't change — and the
// video doesn't reload — on unrelated re-renders.
function withVersion(url: string, version: number) {
  if (!url || version <= 0) return url;
  return url + (url.includes("?") ? "&" : "?") + "v=" + version;
}
