import { useRef, useState, type ReactNode } from "react";
import { useStore } from "../lib/store";
import { uploadListingPhoto, photoFromUpload, readImageDimensions } from "../lib/supabase";
import { createEditPlan, submitRender, pollRender, type RenderManifest } from "../lib/api";
import type { Photo, RenderEngine, StyleId } from "../lib/types";
import { cn } from "../lib/cn";

const STYLES: Array<{
  id: StyleId;
  name: string;
  tagline: string;
  bestFor: string;
  engineLabel: string;
}> = [
  { id: "cinematic-luxury", name: "Cinematic Luxury", tagline: "Slow, premium, editorial pacing", bestFor: "Premium / $1M+", engineLabel: "Cinematic Luxury" },
  { id: "modern-social",   name: "Modern Social",    tagline: "Fast, punchy, social-ready",      bestFor: "Reels / TikTok",  engineLabel: "Modern Social" },
  { id: "mls-clean",       name: "MLS Clean",        tagline: "Clean, neutral, listing-safe",   bestFor: "Standard listings", engineLabel: "MLS Clean" },
  { id: "investor-tour",   name: "Investor Tour",    tagline: "Direct, factual, deal-focused",  bestFor: "Wholesale / deals",  engineLabel: "Investor Tour" }
];

export default function ProjectScreen() {
  const session = useStore((s) => s.session);
  const projectId = useStore((s) => s.projectId);
  const photos = useStore((s) => s.photos);
  const listing = useStore((s) => s.listing);
  const projectTitle = useStore((s) => s.projectTitle);
  const selectedStyleId = useStore((s) => s.selectedStyleId);
  const renderEngine = useStore((s) => s.renderEngine);
  const renderJob = useStore((s) => s.renderJob);
  const error = useStore((s) => s.error);

  const setProjectTitle = useStore((s) => s.setProjectTitle);
  const setListing = useStore((s) => s.setListing);
  const setStyle = useStore((s) => s.setStyle);
  const setEngine = useStore((s) => s.setEngine);
  const setError = useStore((s) => s.setError);

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col gap-10">
      {/* Project header */}
      <header className="flex flex-col gap-3">
        <input
          value={projectTitle}
          onChange={(e) => setProjectTitle(e.target.value)}
          placeholder="Untitled listing"
          className="bg-transparent border-0 outline-none text-3xl sm:text-4xl font-semibold tracking-tighter2 text-ink placeholder:text-ink-dim w-full"
        />
        <p className="text-sm text-ink-muted">
          Add listing details, upload photos, pick a style, and render.
        </p>
      </header>

      {error && (
        <div className="px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-300/70 hover:text-red-300 text-lg leading-none">×</button>
        </div>
      )}

      {/* Listing details */}
      <Section title="Listing details" subtitle="What should appear on the video.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Property address" value={listing.address} onChange={(v) => setListing({ address: v })} placeholder="9828 E Pinnacle Peak Rd" />
          <Input label="City / area"      value={listing.city}    onChange={(v) => setListing({ city: v })}    placeholder="Scottsdale, AZ" />
          <Input label="Price"            value={listing.price}   onChange={(v) => setListing({ price: v })}   placeholder="$2,850,000" />
          <Input label="Square footage"   value={listing.squareFeet} onChange={(v) => setListing({ squareFeet: v })} placeholder="5,640" />
          <Input label="Beds"             value={listing.beds}    onChange={(v) => setListing({ beds: v })}    placeholder="5" />
          <Input label="Baths"            value={listing.baths}   onChange={(v) => setListing({ baths: v })}   placeholder="5.5" />
        </div>
        <Input
          label="Hook line (optional)"
          value={listing.hook}
          onChange={(v) => setListing({ hook: v })}
          placeholder="A modern desert retreat built for evenings outside."
        />
      </Section>

      {/* Photos */}
      <Section
        title="Listing photos"
        subtitle={photos.length === 0 ? "Drop in 8–25 photos." : `${photos.length} ${photos.length === 1 ? "photo" : "photos"} uploaded.`}
      >
        <PhotosArea projectId={projectId} userId={session?.user?.id || ""} />
      </Section>

      {/* Style */}
      <Section title="Style" subtitle="Pick the look that matches your audience.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => setStyle(s.id)}
              className={cn(
                "text-left p-4 rounded-xl bg-surface border transition-colors",
                selectedStyleId === s.id ? "border-gold bg-surface-raised ring-1 ring-gold/40" : "border-edge hover:border-edge-strong"
              )}
            >
              <div className="text-xs uppercase tracking-wider text-ink-muted mb-2 font-mono">
                {s.bestFor}
              </div>
              <div className="text-base font-semibold tracking-tightish mb-1">{s.name}</div>
              <div className="text-xs text-ink-muted leading-relaxed">{s.tagline}</div>
            </button>
          ))}
        </div>
      </Section>

      {/* Render */}
      <Section title="Render" subtitle="Pick an engine and generate the final MP4.">
        <EngineToggle engine={renderEngine} onChange={setEngine} />
        <RenderControls />
        {renderJob && <RenderStatusPanel />}
      </Section>
    </div>
  );
}

/* ============================================================
   Section primitive — consistent header + content slot
   ============================================================ */
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold tracking-tightish">{title}</h2>
        {subtitle && <p className="text-sm text-ink-muted mt-0.5">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

/* ============================================================
   Input primitive
   ============================================================ */
function Input({
  label,
  value,
  onChange,
  placeholder,
  type = "text"
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-soft">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 px-3.5 bg-surface-input border border-edge rounded-lg text-ink text-sm placeholder:text-ink-dim focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 transition-colors"
      />
    </label>
  );
}

/* ============================================================
   Photo upload + grid
   ============================================================ */
function PhotosArea({ projectId, userId }: { projectId: string; userId: string }) {
  const photos = useStore((s) => s.photos);
  const addPhotos = useStore((s) => s.addPhotos);
  const removePhoto = useStore((s) => s.removePhoto);
  const reorderPhotos = useStore((s) => s.reorderPhotos);
  const setError = useStore((s) => s.setError);
  const setToast = useStore((s) => s.setToast);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    if (!userId) {
      setError("Sign in expired. Refresh the page.");
      return;
    }
    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });
    const uploaded: Photo[] = [];
    let i = 0;
    for (const file of Array.from(files)) {
      try {
        const meta = await uploadListingPhoto(file, userId, projectId, i);
        const dims = await readImageDimensions(file);
        uploaded.push(photoFromUpload(file, meta, dims, photos.length + uploaded.length + 1));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setError(`${file.name}: ${msg}`);
        break;
      }
      i++;
      setUploadProgress({ done: i, total: files.length });
    }
    if (uploaded.length) {
      addPhotos(uploaded);
      setToast(`${uploaded.length} photo${uploaded.length === 1 ? "" : "s"} uploaded`);
    }
    setUploading(false);
    setUploadProgress({ done: 0, total: 0 });
    if (fileInput.current) fileInput.current.value = "";
  };

  const movePhoto = (id: string, dir: -1 | 1) => {
    const ids = photos.map((p) => p.id);
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= ids.length) return;
    [ids[idx], ids[next]] = [ids[next], ids[idx]];
    reorderPhotos(ids);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Drop zone (always visible — small if photos exist, big if empty) */}
      <label
        className={cn(
          "block cursor-pointer rounded-xl border-[1.5px] border-dashed transition-colors text-center",
          uploading
            ? "border-gold bg-gold/5"
            : "border-edge-strong hover:border-gold hover:bg-gold/5",
          photos.length === 0 ? "py-16" : "py-8"
        )}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
          disabled={uploading}
        />
        <div className="flex flex-col items-center gap-2">
          <div className="grid place-items-center w-12 h-12 rounded-full bg-gold/10 text-gold text-2xl mb-1">
            +
          </div>
          {uploading ? (
            <>
              <div className="text-sm font-medium">
                Uploading {uploadProgress.done} / {uploadProgress.total}…
              </div>
              <div className="w-48 h-1 bg-edge rounded-full overflow-hidden">
                <div
                  className="h-full bg-gold transition-all"
                  style={{ width: `${(uploadProgress.done / Math.max(1, uploadProgress.total)) * 100}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-medium">Drop listing photos here, or click to browse</div>
              <div className="text-xs text-ink-muted">JPG, PNG, or WebP — 8 to 25 photos recommended</div>
            </>
          )}
        </div>
      </label>

      {photos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {photos.map((photo, idx) => (
            <div
              key={photo.id}
              className="group relative aspect-[4/3] rounded-lg overflow-hidden bg-surface-input border border-edge"
            >
              <img src={photo.publicUrl} alt={photo.fileName} className="w-full h-full object-cover" />
              {/* Order pill */}
              <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-paper/80 backdrop-blur-sm text-[10px] font-mono font-semibold text-gold-light border border-edge">
                {String(idx + 1).padStart(2, "0")}
              </div>
              {/* Reorder + remove controls */}
              <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => movePhoto(photo.id, -1)}
                  disabled={idx === 0}
                  className="w-7 h-7 grid place-items-center rounded bg-paper/80 backdrop-blur-sm text-ink hover:text-gold text-xs disabled:opacity-30"
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  onClick={() => movePhoto(photo.id, 1)}
                  disabled={idx === photos.length - 1}
                  className="w-7 h-7 grid place-items-center rounded bg-paper/80 backdrop-blur-sm text-ink hover:text-gold text-xs disabled:opacity-30"
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  onClick={() => removePhoto(photo.id)}
                  className="w-7 h-7 grid place-items-center rounded bg-paper/80 backdrop-blur-sm text-ink hover:text-red-400 text-sm"
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Engine toggle (Quick Reel vs Cinematic AI)
   ============================================================ */
function EngineToggle({ engine, onChange }: { engine: RenderEngine; onChange: (e: RenderEngine) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <EngineCard
        active={engine === "remotion"}
        title="Quick Reel"
        description="Cinematic photo motion. Fast, reliable, no AI artifacts."
        meta="~90 second render • included with every plan"
        onClick={() => onChange("remotion")}
      />
      <EngineCard
        active={engine === "runway"}
        title="Cinematic AI"
        proTag
        description="True image-to-video motion via Runway Gen-3."
        meta="3–5 minute render • Cinematic AI plan"
        onClick={() => onChange("runway")}
      />
    </div>
  );
}

function EngineCard({
  active,
  title,
  description,
  meta,
  proTag,
  onClick
}: {
  active: boolean;
  title: string;
  description: string;
  meta: string;
  proTag?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-left p-4 rounded-xl bg-surface border transition-colors",
        active ? "border-gold ring-1 ring-gold/40 bg-surface-raised" : "border-edge hover:border-edge-strong"
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-base font-semibold tracking-tightish">{title}</span>
        {proTag && (
          <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-gold text-paper">
            PRO
          </span>
        )}
      </div>
      <div className="text-sm text-ink-soft leading-relaxed">{description}</div>
      <div className="text-xs text-ink-muted mt-1.5">{meta}</div>
    </button>
  );
}

/* ============================================================
   Render controls
   ============================================================ */
function RenderControls() {
  const session = useStore((s) => s.session);
  const photos = useStore((s) => s.photos);
  const listing = useStore((s) => s.listing);
  const selectedStyleId = useStore((s) => s.selectedStyleId);
  const renderEngine = useStore((s) => s.renderEngine);
  const renderJob = useStore((s) => s.renderJob);
  const projectId = useStore((s) => s.projectId);
  const projectTitle = useStore((s) => s.projectTitle);
  const setRenderJob = useStore((s) => s.setRenderJob);
  const setError = useStore((s) => s.setError);
  const setLoading = useStore((s) => s.setLoading);
  const setEditPlan = useStore((s) => s.setEditPlan);
  const setToast = useStore((s) => s.setToast);

  const isRendering = renderJob?.status === "queued" || renderJob?.status === "rendering";
  const isComplete = renderJob?.status === "completed" && renderJob.mp4Url;
  const canRender = photos.length >= 3 && !isRendering;

  const generate = async () => {
    if (!session?.user) { setError("Session expired."); return; }
    if (photos.length < 3) { setError("Add at least 3 photos before rendering."); return; }

    setError("");
    setLoading("Sequencing your tour…");

    try {
      // 1. Get edit plan
      const styleLabel = STYLES.find((s) => s.id === selectedStyleId)?.engineLabel || "Cinematic Luxury";
      const planResult = await createEditPlan({
        photos,
        listing,
        selectedStyle: styleLabel,
        exportFormat: "vertical",
        engine: renderEngine
      });
      if (!planResult.editPlan) {
        throw new Error(planResult.reason || "Could not create edit plan.");
      }
      setEditPlan(planResult.editPlan);

      // 2. Build manifest
      setLoading("Submitting render…");
      const manifest: RenderManifest = {
        app: "EstateMotion",
        engine: renderEngine,
        exportFormat: "vertical",
        project: { id: projectId, userId: session.user.id, title: projectTitle },
        scenes: planResult.editPlan.scenes.map((scene) => {
          const photo = photos.find((p) => p.id === scene.photoId);
          return {
            photoId: scene.photoId,
            type: "photo" as const,
            durableUrl: photo?.durableUrl,
            publicUrl: photo?.publicUrl,
            fileName: photo?.fileName,
            duration: scene.duration,
            cameraMotion: scene.cameraMotion,
            transition: scene.transition,
            overlay: scene.overlay,
            runwayPrompt: scene.runwayPrompt
          };
        }),
        orderedPhotos: photos,
        introCard: planResult.editPlan.introCard,
        outroCard: planResult.editPlan.outroCard,
        musicMood: planResult.editPlan.musicMood,
        selectedStyle: styleLabel,
        runwayConfig: planResult.editPlan.runwayConfig
      };

      // 3. Submit
      const submitted = await submitRender(manifest);
      if (submitted.upgradeRequired) {
        setError(`Upgrade required: ${submitted.error}`);
        setLoading("");
        return;
      }
      if (submitted.status === "failed") {
        throw new Error(submitted.error || "Render submission failed.");
      }
      setRenderJob({
        jobId: submitted.jobId || "",
        status: submitted.status,
        phase: submitted.phase || "Queued",
        progress: submitted.progress || 5,
        engine: renderEngine
      });
      setLoading("");
      setToast("Render started — this takes 60–300 seconds");

      // 4. Poll
      if (submitted.jobId) pollUntilDone(submitted.jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Render failed.";
      setError(msg);
      setLoading("");
    }
  };

  const pollUntilDone = async (jobId: string) => {
    const startTime = Date.now();
    const maxMs = 12 * 60 * 1000; // 12 min hard cap
    while (Date.now() - startTime < maxMs) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const status = await pollRender(jobId);
        setRenderJob({ ...status, jobId });
        if (status.status === "completed" || status.status === "failed") return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Status check failed.";
        setError(msg);
        return;
      }
    }
    setError("Render timed out after 12 minutes.");
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={generate}
        disabled={!canRender}
        className="h-12 px-6 bg-gold hover:bg-gold-light text-paper font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
      >
        {isRendering ? (
          <>
            <span className="spinner" /> Rendering…
          </>
        ) : isComplete ? (
          "Render again"
        ) : (
          "Generate video →"
        )}
      </button>
      {photos.length < 3 && (
        <span className="text-sm text-ink-muted">
          Add at least 3 photos to render.
        </span>
      )}
    </div>
  );
}

/* ============================================================
   Render status panel — progress while rendering, video when done
   ============================================================ */
function RenderStatusPanel() {
  const renderJob = useStore((s) => s.renderJob);
  if (!renderJob) return null;

  if (renderJob.status === "completed" && renderJob.mp4Url) {
    return (
      <div className="bg-surface border border-gold/40 rounded-xl p-4 flex flex-col gap-3">
        <video
          src={renderJob.mp4Url}
          controls
          playsInline
          className="w-full max-h-[600px] rounded-lg bg-black"
        />
        <div className="flex flex-wrap gap-3">
          <a
            href={renderJob.mp4Url}
            download
            className="h-10 px-4 bg-gold hover:bg-gold-light text-paper font-semibold rounded-lg transition-colors inline-flex items-center"
          >
            Download MP4
          </a>
          {renderJob.thumbnailUrl && (
            <a
              href={renderJob.thumbnailUrl}
              download
              className="h-10 px-4 border border-edge hover:border-edge-strong text-ink rounded-lg transition-colors inline-flex items-center text-sm"
            >
              Download thumbnail
            </a>
          )}
        </div>
      </div>
    );
  }

  if (renderJob.status === "failed") {
    return (
      <div className="bg-surface border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
        <strong className="text-red-200">Render failed.</strong>{" "}
        {renderJob.error || "Try again or contact support."}
      </div>
    );
  }

  return (
    <div className="bg-surface border border-edge rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="spinner" />
        <strong>{renderJob.phase || "Rendering"}</strong>
        <span className="text-ink-muted ml-auto">{renderJob.progress || 0}%</span>
      </div>
      <div className="h-1.5 bg-edge rounded-full overflow-hidden">
        <div
          className="h-full bg-gold transition-all duration-500"
          style={{ width: `${Math.max(5, renderJob.progress || 5)}%` }}
        />
      </div>
      <p className="text-xs text-ink-muted">
        {renderJob.engine === "runway"
          ? "Cinematic AI uses Runway image-to-video — typically 3–5 minutes."
          : "Quick Reel renders in under 90 seconds."}
      </p>
    </div>
  );
}
