import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { useStore } from "../lib/store";
import { uploadListingPhoto, photoFromUpload, readImageDimensions, uploadAgentHeadshot, uploadBrokerageLogo } from "../lib/supabase";
import { createEditPlan, submitRender, pollRender, lookupProperty, fetchLibrary, fetchUsage, authHeaders, RenderJobMissingError, type RenderManifest } from "../lib/api";
import VoiceSection from "../components/VoiceSection";
import { events, track } from "../lib/analytics";
import type { AgentBranding, Photo, RenderEngine, StyleId } from "../lib/types";
import { cn } from "../lib/cn";
import { downloadVideo, deliverableFilename } from "../lib/download";
import { resolveTrack } from "../lib/music-catalog";
import { isAiVideoEngine, engineLabel as engineDisplayLabel } from "../lib/engine-labels";
import { cloneVoiceIdOf, cloneVoiceLabelOf } from "../lib/voice-presets";
import MusicSelector from "../components/MusicSelector";
import { fireConfetti } from "../lib/confetti";
import PaywallModal from "../components/PaywallModal";

const STYLES: Array<{
  id: StyleId;
  name: string;
  tagline: string;
  bestFor: string;
  engineLabel: string;
}> = [
  { id: "cinematic-luxury", name: "Cinematic Luxury", tagline: "Slow camera moves, editorial tone, premium feel.",     bestFor: "Premium / $1M+",      engineLabel: "Cinematic Luxury" },
  { id: "modern-social",    name: "Modern Social",    tagline: "Fast cuts and punchy pacing — built for Reels and TikTok.", bestFor: "Reels & TikTok",  engineLabel: "Modern Social" },
  { id: "mls-clean",        name: "MLS Clean",        tagline: "Neutral, factual, broker-compliant.",                  bestFor: "Standard listings",   engineLabel: "MLS Clean" },
  { id: "investor-tour",    name: "Investor Tour",    tagline: "Direct walkthroughs for wholesale and deal flow.",     bestFor: "Wholesale & deals",   engineLabel: "Investor Tour" }
];

export default function ProjectScreen() {
  const session = useStore((s) => s.session);
  const projectId = useStore((s) => s.projectId);
  const photos = useStore((s) => s.photos);
  const listing = useStore((s) => s.listing);
  const projectTitle = useStore((s) => s.projectTitle);
  const selectedStyleId = useStore((s) => s.selectedStyleId);
  const renderEngine = useStore((s) => s.renderEngine);
  const targetDurationSec = useStore((s) => s.targetDurationSec);
  const setTargetDuration = useStore((s) => s.setTargetDuration);
  const renderJob = useStore((s) => s.renderJob);
  const error = useStore((s) => s.error);

  const setProjectTitle = useStore((s) => s.setProjectTitle);
  const setListing = useStore((s) => s.setListing);
  const setStyle = useStore((s) => s.setStyle);
  const setEngine = useStore((s) => s.setEngine);
  const setError = useStore((s) => s.setError);

  return (
    <div className="max-w-5xl mx-auto px-5 sm:px-6 py-8 sm:py-10 flex flex-col gap-10">
      {/* Project header */}
      <header className="flex flex-col gap-2.5">
        <p className="text-xs uppercase tracking-wider text-gold font-mono">New listing video</p>
        <input
          value={projectTitle}
          onChange={(e) => setProjectTitle(e.target.value)}
          placeholder="Untitled listing"
          className="bg-transparent border-0 outline-none font-display text-3xl sm:text-4xl font-semibold tracking-tighter2 text-ink placeholder:text-ink-dim w-full"
        />
        <p className="text-sm text-ink-muted leading-relaxed">
          Tell us about the listing, drop in your photos, pick a style — your cinematic video is ready in about ten minutes, every scene verified.
        </p>
      </header>

      {error && (
        <div role="alert" className="fade-up-in px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300 flex items-start justify-between gap-3">
          <span className="leading-relaxed">{error}</span>
          <button
            onClick={() => setError("")}
            aria-label="Dismiss error"
            className="text-red-300/70 hover:text-red-300 text-xl leading-none flex-shrink-0 -mt-0.5"
          >
            ×
          </button>
        </div>
      )}

      {/* Listing details — grouped by visual priority */}
      <Section title="Listing details" subtitle="The facts that appear on the finished video.">
        <ListingDetailsCard />
      </Section>

      {/* Photos */}
      <Section
        title="Photos"
        subtitle={photos.length === 0
          ? "Drop in 8–25 listing photos. JPG, PNG, or WebP."
          : `${photos.length} ${photos.length === 1 ? "photo" : "photos"} ready to direct.`}
      >
        <PhotosArea projectId={projectId} userId={session?.user?.id || ""} />
      </Section>

      {/* Agent brand kit — drives the outro card on every video.
          Persisted to Supabase so it follows you across browsers / logins. */}
      <Section
        title="Your branding"
        subtitle="Appears on the closing card of every video. Synced to your account."
      >
        <BrandKitArea userId={session?.user?.id || ""} />
      </Section>

      {/* Style */}
      <Section title="Style" subtitle="The visual direction the cinematographer takes.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => setStyle(s.id)}
              className={cn(
                "card-press text-left p-4 rounded-xl bg-surface border",
                selectedStyleId === s.id
                  ? "border-gold bg-surface-raised card-selected"
                  : "border-edge hover:border-edge-strong"
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

      {/* Music selector — each style ships with a default track, but the
          full library is here for users who want a different feel. */}
      <Section title="Music" subtitle="Default picks for each style — swap any time.">
        <MusicSelector />
      </Section>

      {/* v24.2: voice + music toggles + music volume slider. Lets agents
          ship voice-only, music-only, both with ducking, or silent. */}
      <Section title="Audio" subtitle="Voice narration, music bed, and how loud each plays.">
        <AudioControls />
      </Section>

      {/* v26.6: single cinematic engine (Veo 3.1). The engine toggle,
          tier/quality panel, and hallucination-safety picker are gone —
          there's one pipeline now, MLS-safe by design. Length still matters
          (60s consumes 2 credits). Everything else is automatic. */}
      <Section title="Render" subtitle="Pick a length and hit Generate. Review every scene before you publish.">
        <div className="flex flex-col gap-5">
          <LengthToggle value={targetDurationSec} onChange={setTargetDuration} />
          <FormatsToggle />
          <RenderControls />
          {renderJob && <RenderStatusPanel />}
        </div>
      </Section>
    </div>
  );
}

/* AdvancedRenderSettings, NarrationToggle, and TwilightToggle removed.
   Narration is always on (worker fail-soft to music-only if unavailable).
   Twilight Magic was a per-render upgrade that didn't justify its toggle
   surface area. Render Safety lives directly in the Render section now,
   not behind a disclosure — it's the only quality-affecting choice
   the user actually controls. */

/* v35.2 repo cleanup: RenderQualityPanel and RenderSafetyControl deleted —
   both were defined but never mounted, and their copy described retired
   products (Runway Gen-4 tiers, Ken Burns fallback, $79/$149/$299 pricing).
   The engine is Veo-only with guard always-on; quality/safety copy lives in
   the live components. See git history if a tier panel ever returns. */

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
   Listing details — with public-records auto-fill (RentCast)
   ============================================================ */
function ListingDetailsCard() {
  const listing = useStore((s) => s.listing);
  const setListing = useStore((s) => s.setListing);
  const setError = useStore((s) => s.setError);
  const setToast = useStore((s) => s.setToast);

  const [looking, setLooking] = useState(false);
  // Verified facts surfaced after a successful lookup. Lets the agent see
  // bonus details (year built, lot size, last sale) without crowding the
  // main form, and signals "this came from public records" — the trust
  // signal that anchors the anti-hallucination claim.
  const [verifiedFacts, setVerifiedFacts] = useState<{
    yearBuilt: string;
    lotSize: string;
    propertyType: string;
    lastSalePrice: string;
  } | null>(null);

  const runLookup = async () => {
    const address = listing.address.trim();
    if (!address) {
      setError("Type the property address first, then look it up.");
      return;
    }
    setLooking(true);
    try {
      const result = await lookupProperty(address);
      if (result.status === "ok" && result.property) {
        const p = result.property;
        // Only overwrite fields that are currently empty so we don't clobber
        // anything the agent already typed. Address/city always update —
        // RentCast normalizes them better than the agent will.
        setListing({
          address: p.address || listing.address,
          city: p.city || listing.city,
          beds: listing.beds || p.beds,
          baths: listing.baths || p.baths,
          squareFeet: listing.squareFeet || p.squareFeet
        });
        setVerifiedFacts({
          yearBuilt: p.extras.yearBuilt,
          lotSize: p.extras.lotSize,
          propertyType: p.extras.propertyType,
          lastSalePrice: p.extras.lastSalePrice
        });
        setToast("Listing facts pulled from public records.");
      } else if (result.status === "not_found") {
        setError(result.message || "Address not found in public records. Fill the details manually.");
      } else {
        setError(result.message || "Property lookup unavailable. Fill the details manually.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Property lookup failed.";
      setError(msg);
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="bg-surface border border-edge rounded-xl p-5 sm:p-6 flex flex-col gap-4">
      {/* Address row — input + verify button */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <Input
            label="Property address"
            value={listing.address}
            onChange={(v) => setListing({ address: v })}
            placeholder="9828 E Pinnacle Peak Rd, Scottsdale AZ"
          />
        </div>
        <button
          type="button"
          onClick={runLookup}
          disabled={looking || !listing.address.trim()}
          className="btn-secondary-em h-10 px-4 rounded-lg text-sm whitespace-nowrap disabled:opacity-50 inline-flex items-center gap-2"
        >
          {looking ? (
            <><span className="spinner" /> Looking up…</>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Verify from public records
            </>
          )}
        </button>
      </div>

      {/* Verified facts callout — the trust signal */}
      {verifiedFacts && (
        <div className="px-3.5 py-3 rounded-lg bg-gold/5 border border-gold/30 fade-up-in">
          <div className="flex items-start gap-2.5">
            <div className="grid place-items-center w-5 h-5 mt-0.5 rounded-full bg-gold text-paper">
              <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 6l3 3 5-6" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-xs font-semibold text-gold-light tracking-tightish">
                Verified from public records
              </p>
              <p className="text-[11px] text-ink-muted mt-0.5">
                {[
                  verifiedFacts.propertyType,
                  verifiedFacts.yearBuilt && `built ${verifiedFacts.yearBuilt}`,
                  verifiedFacts.lotSize && `${verifiedFacts.lotSize} lot`,
                  verifiedFacts.lastSalePrice && `last sale ${verifiedFacts.lastSalePrice}`
                ].filter(Boolean).join(" · ") || "County records confirm the listing details below."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* City + price — secondary pair */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input label="City / area" value={listing.city}  onChange={(v) => setListing({ city: v })}  placeholder="Scottsdale, AZ" />
        <Input label="Price"       value={listing.price} onChange={(v) => setListing({ price: v })} placeholder="$2,850,000" />
      </div>
      {/* Beds / baths / sqft — tight numeric trio */}
      <div className="grid grid-cols-3 gap-3">
        <Input label="Beds"       value={listing.beds}       onChange={(v) => setListing({ beds: v })}       placeholder="5"     />
        <Input label="Baths"      value={listing.baths}      onChange={(v) => setListing({ baths: v })}      placeholder="5.5"   />
        <Input label="Sq ft"      value={listing.squareFeet} onChange={(v) => setListing({ squareFeet: v })} placeholder="5,640" />
      </div>
      {/* Hook — optional, deprioritized */}
      <div className="pt-2 border-t border-edge-soft">
        <Input
          label="Hook line (optional)"
          value={listing.hook}
          onChange={(v) => setListing({ hook: v })}
          placeholder="A modern desert retreat built for evenings outside."
        />
      </div>
    </div>
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
  const [isDragOver, setIsDragOver] = useState(false);
  // v23.2: drag-and-drop reorder. Tracks which photo is being dragged
  // and which position it's hovering over for the drop indicator.
  const [draggedPhotoIdx, setDraggedPhotoIdx] = useState<number | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Upload up to 24 photos. Render uses them in the order shown — drag the
  // tiles to rearrange. AI curation was removed (it consistently picked
  // wrong subsets / wrong order), so MAX_PHOTOS now equals RENDER_LIMIT.
  const MAX_PHOTOS = 24;
  const RENDER_LIMIT = 24;

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    if (!userId) {
      setError("Sign in expired. Refresh the page.");
      return;
    }

    // Soft-cap: only keep the first N that fit under MAX_PHOTOS.
    const slotsLeft = Math.max(0, MAX_PHOTOS - photos.length);
    const fileArray = Array.from(files);
    const accepted = fileArray.slice(0, slotsLeft);
    const dropped = fileArray.length - accepted.length;
    if (slotsLeft === 0) {
      setError(`You're at the max of ${MAX_PHOTOS} photos. Remove one before adding more.`);
      return;
    }
    if (dropped > 0) {
      setToast(`Adding ${accepted.length} of ${fileArray.length} — max is ${MAX_PHOTOS} per video.`);
    }

    setUploading(true);
    setUploadProgress({ done: 0, total: accepted.length });
    const uploaded: Photo[] = [];
    let i = 0;
    for (const file of accepted) {
      // Type guard — drag-and-drop can deliver folders or non-images.
      if (!file.type.startsWith("image/")) {
        setError(`${file.name} isn't an image (JPG, PNG, or WebP).`);
        continue;
      }
      try {
        const meta = await uploadListingPhoto(file, userId, projectId, i);
        const dims = await readImageDimensions(file);
        uploaded.push(photoFromUpload(file, meta, dims, photos.length + uploaded.length + 1));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setError(`Couldn't upload ${file.name}: ${msg}`);
        break;
      }
      i++;
      setUploadProgress({ done: i, total: accepted.length });
    }
    if (uploaded.length) {
      addPhotos(uploaded);
      setToast(`${uploaded.length} photo${uploaded.length === 1 ? "" : "s"} added`);
    }
    setUploading(false);
    setUploadProgress({ done: 0, total: 0 });
    if (fileInput.current) fileInput.current.value = "";
  };

  // Real drag-and-drop handlers — the previous version only opened a
  // file picker on click and silently ignored drop events.
  const onDragOver = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!isDragOver) setIsDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    // Only clear when truly leaving the drop zone, not when crossing inner children.
    if (e.currentTarget === e.target) setIsDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) handleFiles(files);
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

  // v23.2 drag-and-drop reorder. Splices the dragged photo into the
  // target index and updates the store. Edge cases handled:
  //   - dropping on the same index (no-op)
  //   - dropping after the source position (target index decremented
  //     so the move lands where the user expects, since removing the
  //     source first shifts everything left by one)
  const reorderViaDrop = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const ids = photos.map((p) => p.id);
    if (fromIdx < 0 || fromIdx >= ids.length) return;
    if (toIdx < 0 || toIdx > ids.length) return;
    const [moved] = ids.splice(fromIdx, 1);
    // After splice, target may have shifted. If dragging downward,
    // toIdx is now one greater than what the user pointed at — adjust.
    const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
    ids.splice(adjustedTo, 0, moved);
    reorderPhotos(ids);
  };

  // AI photo curator removed — photos render in upload order. Users can
  // drag to reorder. The `curating` state + `handleCurate` were retired
  // along with the button that called them.

  const photoCountLabel = `${photos.length} of ${MAX_PHOTOS}`;
  const isFull = photos.length >= MAX_PHOTOS;

  return (
    <div className="flex flex-col gap-4">
      {/* Drop zone — now genuinely drag-and-drop */}
      <label
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "block cursor-pointer rounded-xl border-[1.5px] border-dashed transition-all text-center",
          uploading || isDragOver
            ? "border-gold bg-gold/10 scale-[1.005]"
            : isFull
            ? "border-edge bg-surface-input cursor-not-allowed opacity-60"
            : "border-edge-strong hover:border-gold hover:bg-gold/5",
          photos.length === 0 ? "py-16" : "py-8"
        )}
        aria-disabled={isFull}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
          disabled={uploading || isFull}
        />
        <div className="flex flex-col items-center gap-2 pointer-events-none">
          <div className={cn(
            "grid place-items-center w-12 h-12 rounded-full text-2xl mb-1 transition-colors",
            uploading || isDragOver ? "bg-gold/25 text-gold-light" : "bg-gold/10 text-gold"
          )}>
            {uploading ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> : "+"}
          </div>
          {uploading ? (
            <>
              <div className="text-sm font-medium">
                Uploading {uploadProgress.done} of {uploadProgress.total}…
              </div>
              <div className="w-48 h-1 bg-edge rounded-full overflow-hidden">
                <div
                  className="h-full bg-gold rounded-full"
                  style={{
                    width: `${(uploadProgress.done / Math.max(1, uploadProgress.total)) * 100}%`,
                    transition: "width 200ms ease-out"
                  }}
                />
              </div>
            </>
          ) : isDragOver ? (
            <>
              <div className="text-base font-semibold text-gold-light tracking-tightish">Drop to upload</div>
              <div className="text-xs text-ink-muted">Up to {MAX_PHOTOS - photos.length} more photos</div>
            </>
          ) : isFull ? (
            <>
              <div className="text-base font-semibold tracking-tightish">All {MAX_PHOTOS} slots used</div>
              <div className="text-xs text-ink-muted">Remove a photo below to add another.</div>
            </>
          ) : photos.length === 0 ? (
            <>
              <div className="text-base font-semibold tracking-tightish">Drop your listing photos</div>
              <div className="text-xs text-ink-muted max-w-md">
                Or <span className="text-gold underline">click to browse</span>. 8–{MAX_PHOTOS} photos works best —
                exterior, kitchen, living, primary bedroom, plus any standout details.
                Upload the original full-resolution exports; bigger photos make sharper video.
              </div>
              <div className="text-[10px] text-ink-dim font-mono uppercase tracking-widest mt-1">
                JPG · PNG · WebP
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold tracking-tightish">Add more photos</div>
              <div className="text-xs text-ink-muted">
                Drag here or click to browse · {MAX_PHOTOS - photos.length} {MAX_PHOTOS - photos.length === 1 ? "slot" : "slots"} left
              </div>
            </>
          )}
        </div>
      </label>

      {/* Readiness bar + AI curation CTA */}
      {photos.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-mono uppercase tracking-wider text-ink-muted">
                {photoCountLabel} photos
              </span>
              <span className={cn(
                "font-semibold tracking-tightish",
                photos.length >= 8 ? "text-gold" : "text-ink-muted"
              )}>
                {photos.length >= 8
                  ? "Ready to render"
                  : `${8 - photos.length} more for a full tour`}
              </span>
            </div>
            {/* AI auto-arrange removed — photos render in the order you
                upload (or drag) them. Use the drag handles below to
                rearrange. The AI selector consistently picked the wrong
                subset and was retired. */}
          </div>
          <div className="h-1 bg-edge rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                photos.length >= 8 ? "bg-gold" : "bg-gold/55"
              )}
              style={{
                // Cap visual progress at 100% — once we're at 8+, the bar is
                // full regardless of upload count.
                width: `${Math.min(100, (photos.length / 8) * 100)}%`
              }}
            />
          </div>
          <p className="text-[11px] text-ink-dim leading-relaxed">
            Photo 1 is your <span className="text-gold-light font-semibold">hero shot</span> — the AI opens the video on it.
            Drag the corner controls to reorder, or hand the whole set to AI for a curated walkthrough.
          </p>
        </div>
      )}

      {photos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {photos.map((photo, idx) => {
            const isBeingDragged = draggedPhotoIdx === idx;
            const isDropTarget = dropTargetIdx === idx && draggedPhotoIdx !== null && draggedPhotoIdx !== idx;
            return (
            <div
              key={photo.id}
              draggable
              onDragStart={(e) => {
                setDraggedPhotoIdx(idx);
                // Required for drag to work on Firefox; data also provides
                // a fallback for cross-window drops (we ignore it on drop).
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(idx));
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                if (draggedPhotoIdx !== null && draggedPhotoIdx !== idx) {
                  setDropTargetIdx(idx);
                }
              }}
              onDragOver={(e) => {
                // Required to allow a drop on this element.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDragLeave={(e) => {
                // Only clear if leaving the actual element bounds (not
                // children) — checking relatedTarget avoids flicker.
                const next = e.relatedTarget as Node | null;
                if (!e.currentTarget.contains(next)) {
                  setDropTargetIdx((cur) => (cur === idx ? null : cur));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedPhotoIdx !== null && draggedPhotoIdx !== idx) {
                  reorderViaDrop(draggedPhotoIdx, idx);
                }
                setDraggedPhotoIdx(null);
                setDropTargetIdx(null);
              }}
              onDragEnd={() => {
                setDraggedPhotoIdx(null);
                setDropTargetIdx(null);
              }}
              className={cn(
                "card-press group relative aspect-[4/3] rounded-lg overflow-hidden bg-surface-input border cursor-grab active:cursor-grabbing transition-all",
                isBeingDragged && "opacity-40 scale-95",
                isDropTarget && "ring-2 ring-gold scale-[1.02]",
                idx === 0 && !isDropTarget ? "border-gold ring-1 ring-gold/40" : "border-edge hover:border-edge-strong"
              )}
            >
              <img src={photo.publicUrl} alt={photo.fileName} className="w-full h-full object-cover pointer-events-none" loading="lazy" draggable={false} />
              {/* Order pill — plus the HERO badge on photo 1 */}
              <div className="absolute top-2 left-2 flex items-center gap-1 pointer-events-none">
                <div className={cn(
                  "px-1.5 py-0.5 rounded backdrop-blur-sm text-[10px] font-mono font-semibold border",
                  idx === 0
                    ? "bg-gold text-paper border-gold"
                    : "bg-paper/80 text-gold-light border-edge"
                )}>
                  {String(idx + 1).padStart(2, "0")}
                </div>
                {idx === 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-paper/90 backdrop-blur-sm text-[9px] font-bold tracking-widest text-gold border border-gold/40 uppercase">
                    Hero
                  </span>
                )}
              </div>
              {/* Drag-handle hint — small grip icon at bottom-left, hover-revealed.
                  Tells the user the card is draggable without competing with
                  the order pill or hero badge for visual attention. */}
              <div className="absolute bottom-1.5 left-1.5 px-1 py-0.5 rounded bg-paper/80 backdrop-blur-sm text-[10px] text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                ⋮⋮ drag
              </div>
              {/* Filename caption — hover-revealed at bottom-right */}
              <div className="absolute right-2 bottom-1.5 max-w-[60%] px-2 py-0.5 bg-paper/85 backdrop-blur-sm text-[10px] text-ink-muted truncate rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                {photo.fileName}
              </div>
              {/* Reorder + remove controls — always visible on touch devices,
                  hover-to-reveal on devices that support hover. Up/down
                  buttons remain as a keyboard / no-mouse fallback for
                  accessibility, even with drag-and-drop. */}
              <div className={cn(
                "absolute top-2 right-2 flex flex-col gap-1 transition-opacity",
                "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
              )}>
                <button
                  type="button"
                  onClick={() => movePhoto(photo.id, -1)}
                  disabled={idx === 0}
                  className="w-8 h-8 grid place-items-center rounded bg-paper/85 backdrop-blur-sm text-ink hover:text-gold text-sm disabled:opacity-30 shadow-sm"
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => movePhoto(photo.id, 1)}
                  disabled={idx === photos.length - 1}
                  className="w-8 h-8 grid place-items-center rounded bg-paper/85 backdrop-blur-sm text-ink hover:text-gold text-sm disabled:opacity-30 shadow-sm"
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removePhoto(photo.id)}
                  className="w-8 h-8 grid place-items-center rounded bg-paper/85 backdrop-blur-sm text-ink hover:text-red-400 text-base shadow-sm"
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Brand kit — agent name, brokerage, headshot. Renders on the outro
   card for both Quick Reel and Cinematic AI. Persisted in localStorage
   so the agent never has to re-enter it.
   ============================================================ */
function BrandKitArea({ userId }: { userId: string }) {
  const branding = useStore((s) => s.branding);
  const setBranding = useStore((s) => s.setBranding);
  const setError = useStore((s) => s.setError);
  const setToast = useStore((s) => s.setToast);

  const [uploading, setUploading] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  const handleHeadshot = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!userId) {
      setError("Sign in expired. Refresh the page.");
      return;
    }
    // v33: explicitly reject SVG — it passes the generic image/ check but the
    // render worker's ffmpeg can't rasterize it (test-8: the headshot slot
    // held vistalia-mark.svg and every outro fell back to text-only).
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      setError("Headshot must be a JPG, PNG, or WebP photo (SVG isn't supported).");
      return;
    }
    setUploading(true);
    try {
      const { url } = await uploadAgentHeadshot(file, userId);
      setBranding({ headshotUrl: url });
      setToast("Headshot saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Headshot upload failed";
      setError(msg);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const handleLogo = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!userId) { setError("Sign in expired. Refresh the page."); return; }
    if (!file.type.startsWith("image/")) {
      setError("Brokerage logo must be an image (PNG with transparent background works best).");
      return;
    }
    setUploadingLogo(true);
    try {
      const { url } = await uploadBrokerageLogo(file, userId);
      setBranding({ brokerageLogoUrl: url });
      setToast("Brokerage logo saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Logo upload failed";
      setError(msg);
    } finally {
      setUploadingLogo(false);
      if (logoInput.current) logoInput.current.value = "";
    }
  };

  return (
    <div className="bg-surface border border-edge rounded-xl overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_290px]">
        {/* ==== Form column ==== */}
        <div className="p-5 sm:p-6 flex flex-col gap-6 min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-5 items-start">
            {/* Headshot uploader */}
            <div className="flex flex-col items-center gap-2">
              <label
                className={cn(
                  "card-press group relative w-28 h-28 rounded-full overflow-hidden cursor-pointer grid place-items-center bg-surface-input transition-all",
                  uploading
                    ? "border-2 border-gold"
                    : branding.headshotUrl
                    ? "border-2 border-gold/60 ring-2 ring-gold/15 hover:ring-gold/30"
                    : "border-2 border-dashed border-edge-strong hover:border-gold hover:bg-gold/5"
                )}
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleHeadshot(e.target.files)}
                  disabled={uploading}
                />
                {branding.headshotUrl ? (
                  <>
                    <img
                      src={branding.headshotUrl}
                      alt="Agent headshot"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-semibold tracking-widest uppercase text-white">
                      Replace
                    </span>
                  </>
                ) : uploading ? (
                  <span className="spinner" />
                ) : (
                  <div className="text-[10px] text-ink-muted text-center px-2 leading-tight">
                    Add<br />headshot
                  </div>
                )}
              </label>
              <span className="text-[10px] font-mono uppercase tracking-widest text-ink-dim">Headshot</span>
              {branding.headshotUrl && (
                <button
                  type="button"
                  onClick={() => setBranding({ headshotUrl: "" })}
                  className="text-[11px] text-ink-muted hover:text-red-300 transition-colors -mt-1"
                >
                  Remove
                </button>
              )}
            </div>

            {/* Identity fields */}
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Full name"
                  value={branding.fullName}
                  onChange={(v) => setBranding({ fullName: v })}
                  placeholder="Troy Massey"
                />
                <Input
                  label="Brokerage"
                  value={branding.brokerage}
                  onChange={(v) => setBranding({ brokerage: v })}
                  placeholder="Vistalia Realty"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Phone"
                  value={branding.phone}
                  onChange={(v) => setBranding({ phone: v })}
                  placeholder="(555) 555-1234"
                />
                <Input
                  label="Email"
                  value={branding.email}
                  onChange={(v) => setBranding({ email: v })}
                  placeholder="agent@example.com"
                  type="email"
                />
              </div>
            </div>
          </div>

          {/* Brokerage logo + license — both required for MLS-compliant
              marketing in most states. These appear on the closing card and
              drive the "MLS compliant" differentiator. */}
          <div className="pt-5 border-t border-edge-soft">
            <div className="flex items-baseline justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold tracking-tightish flex items-center gap-2">
                  Brokerage compliance
                  <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-gold/20 text-gold-light border border-gold/30">MLS-READY</span>
                </h3>
                <p className="text-xs text-ink-muted mt-0.5">
                  Logo + license number appear on the closing card and on every Equal Housing footer.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-5 items-start">
              {/* Logo uploader */}
              <div className="flex flex-col items-center gap-2">
                <label
                  className={cn(
                    "card-press group relative w-32 h-20 rounded-lg overflow-hidden cursor-pointer grid place-items-center bg-surface-input transition-all",
                    uploadingLogo
                      ? "border-2 border-gold"
                      : branding.brokerageLogoUrl
                      ? "border border-gold/50 ring-1 ring-gold/10 hover:ring-gold/25"
                      : "border-2 border-dashed border-edge-strong hover:border-gold hover:bg-gold/5"
                  )}
                >
                  <input
                    ref={logoInput}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handleLogo(e.target.files)}
                    disabled={uploadingLogo}
                  />
                  {branding.brokerageLogoUrl ? (
                    <>
                      <img
                        src={branding.brokerageLogoUrl}
                        alt="Brokerage logo"
                        className="max-w-[90%] max-h-[80%] object-contain"
                      />
                      <span className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-semibold tracking-widest uppercase text-white">
                        Replace
                      </span>
                    </>
                  ) : uploadingLogo ? (
                    <span className="spinner" />
                  ) : (
                    <div className="text-[10px] text-ink-muted text-center px-2 leading-tight">
                      Add<br />brokerage<br />logo
                    </div>
                  )}
                </label>
                {branding.brokerageLogoUrl && (
                  <button
                    type="button"
                    onClick={() => setBranding({ brokerageLogoUrl: "" })}
                    className="text-[11px] text-ink-muted hover:text-red-300 transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
              {/* License number */}
              <div className="flex flex-col gap-3">
                <Input
                  label="License number"
                  value={branding.licenseNumber || ""}
                  onChange={(v) => setBranding({ licenseNumber: v })}
                  placeholder="DRE# 01234567 · TREC# 0123456 · AZ SA-123456"
                />
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  Stamped on every video for state advertising compliance. PNG with transparent background recommended for the logo.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ==== Live closing-card preview ==== */}
        <aside className="border-t lg:border-t-0 lg:border-l border-edge-soft bg-surface-input/40 p-5 sm:p-6 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-widest text-gold">Closing card</span>
            <span className="text-[10px] text-ink-dim">Live preview</span>
          </div>
          <OutroCardPreview branding={branding} />
          <p className="text-[11px] text-ink-muted leading-relaxed text-center">
            Closes every video you render — your branding, no one else's.
          </p>
        </aside>
      </div>

      {/* v26.9: VoiceCloneCard moved to the Audio panel (under the narration
          toggle) where agents look for voiceover — it was buried here in the
          brand kit and went undiscovered. */}
    </div>
  );
}

/* Miniature of the ffmpeg brand outro (buildBrandOutroClip): vignette bg,
   headshot circle + logo row, gold CTA eyebrow, name, brokerage, license,
   contact, accent rule, Equal Housing footer. Purely cosmetic — the worker
   remains the source of truth for the real card. */
function OutroCardPreview({ branding }: { branding: AgentBranding }) {
  const name = branding.fullName.trim() || "Your Name";
  const brokerage = branding.brokerage.trim();
  const license = (branding.licenseNumber || "").trim();
  const contact = [branding.phone.trim(), branding.email.trim()].filter(Boolean).join("  ·  ");
  const initial = (branding.fullName.trim() || "V").charAt(0).toUpperCase();
  return (
    <div className="relative w-full max-w-[230px] mx-auto aspect-[9/15] rounded-xl overflow-hidden border border-edge-strong bg-[#0B0B0D] shadow-2xl select-none">
      {/* vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 28%, rgba(199,167,108,.10), transparent 55%), radial-gradient(150% 110% at 50% 105%, rgba(0,0,0,.6), transparent 62%)"
        }}
      />
      <div className="relative h-full flex flex-col items-center justify-center px-4 text-center">
        <div className="flex items-center justify-center gap-3 mb-3">
          {branding.headshotUrl ? (
            <img
              src={branding.headshotUrl}
              alt=""
              className="w-16 h-16 rounded-full object-cover border border-gold/40"
            />
          ) : (
            <div className="w-16 h-16 rounded-full border border-gold/30 bg-white/[.04] grid place-items-center font-display text-xl text-gold/70">
              {initial}
            </div>
          )}
          {branding.brokerageLogoUrl && (
            <img src={branding.brokerageLogoUrl} alt="" className="max-h-10 max-w-[64px] object-contain" />
          )}
        </div>
        <div className="text-[7px] font-semibold tracking-[.3em] uppercase text-gold mb-1.5">
          Schedule a private tour
        </div>
        <div className="font-display text-lg font-semibold tracking-tighter2 text-white leading-tight">
          {name}
        </div>
        {brokerage && <div className="text-[10px] text-white/75 mt-1">{brokerage}</div>}
        {license && <div className="text-[8px] tracking-wider text-gold/90 mt-1">{license}</div>}
        {contact && <div className="text-[8px] text-white/80 mt-1.5 px-2 break-words leading-relaxed">{contact}</div>}
        <div className="w-12 h-px bg-gold/70 mt-3" />
      </div>
      <div className="absolute bottom-2 inset-x-0 text-center text-[6.5px] text-white/45">
        Equal Housing Opportunity&ensp;·&ensp;Made with Vistalia
      </div>
    </div>
  );
}

/* ============================================================
   Voice clone — in-browser microphone recording with live waveform.
   ============================================================
   The agent taps "Record," watches a live audio waveform pulse with
   their voice, and submits to ElevenLabs without ever leaving the page.
   File upload is kept as a secondary affordance for agents who already
   have a clean recording on disk (podcast clip, etc.) but the primary
   path is one tap → speak → done.
*/
type VoiceMode = "idle" | "permission" | "countdown" | "recording" | "review" | "cloning" | "cloned";

// Preset narrator slugs (mirror of api/voices.js). These live in the SAME
// branding.voiceId field as a cloned voice ID, so the clone card must not
// mistake a preset selection for "you cloned a voice."
function VoiceCloneCard() {
  const branding = useStore((s) => s.branding);
  const setBranding = useStore((s) => s.setBranding);
  const setError = useStore((s) => s.setError);
  const setToast = useStore((s) => s.setToast);

  // v34.7: the clone lives in branding.clonedVoiceId (with legacy inference
  // for kits saved before the split) — the card no longer disappears when
  // Settings makes a preset the ACTIVE voice.
  const hasClonedVoice = !!cloneVoiceIdOf(branding);
  const initialMode: VoiceMode = hasClonedVoice ? "cloned" : "idle";
  const [mode, setMode] = useState<VoiceMode>(initialMode);
  const [countdown, setCountdown] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);

  // Recording infrastructure refs (mutable, never re-rendering).
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number>(0);
  const countdownIntervalRef = useRef<number>(0);
  const elapsedIntervalRef = useRef<number>(0);
  const startedAtRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 32 waveform bar refs, mutated directly via the rAF loop for 60fps
  // animation without React re-renders.
  const barRefs = useRef<Array<HTMLDivElement | null>>(new Array(32).fill(null));

  const MAX_DURATION_SEC = 90;
  const MIN_DURATION_SEC = 8; // ElevenLabs IVC needs at least a few seconds

  // Cleanup helper — stops everything currently running.
  const stopAndCleanup = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch { /* ignore */ }
      audioCtxRef.current = null;
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (countdownIntervalRef.current) window.clearInterval(countdownIntervalRef.current);
    if (elapsedIntervalRef.current) window.clearInterval(elapsedIntervalRef.current);
  };

  // Cleanup on unmount.
  useEffect(() => () => {
    stopAndCleanup();
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* -----------------------------------------------------------------
     Begin recording flow — mic permission → 3-2-1 countdown → record.
     ----------------------------------------------------------------- */
  const beginRecording = async () => {
    if (!branding.fullName.trim()) {
      setError("Add your full name above first — it labels the cloned voice.");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Your browser doesn't support microphone recording. Try Chrome, Safari, or Firefox.");
      return;
    }

    setMode("permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 44100,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      // v34.8: permission granted is NOT the same as audio flowing. On
      // macOS a revoked system-level mic permission, a dead input device,
      // or an input volume of zero all yield a granted-but-silent track —
      // which used to sail through to a review screen with a 0-byte blob,
      // a dead player, and a "Use this voice" button that looked broken.
      const micTrack = stream.getAudioTracks()[0];
      if (!micTrack || micTrack.readyState !== "live" || micTrack.muted) {
        stream.getTracks().forEach((t) => t.stop());
        setMode("idle");
        setError(
          "Your microphone connected but isn't delivering audio. On a Mac: System Settings → Privacy & Security → Microphone → allow your browser, and check Sound → Input shows a level when you speak. Or use 'Upload audio file' below instead."
        );
        return;
      }
      audioStreamRef.current = stream;
    } catch (err) {
      const name = (err as Error)?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setError("Microphone access was blocked. Click the lock icon in your browser bar and allow microphone for this site.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setError("No microphone detected. Plug one in (or grant permission to your built-in mic) and try again.");
      } else {
        setError("Couldn't access your microphone. Try again or upload a file instead.");
      }
      setMode("idle");
      return;
    }

    // Countdown 3 → 2 → 1 → start
    setMode("countdown");
    setCountdown(3);
    let n = 3;
    countdownIntervalRef.current = window.setInterval(() => {
      n -= 1;
      if (n <= 0) {
        window.clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = 0;
        startActualRecording();
      } else {
        setCountdown(n);
      }
    }, 700);
  };

  const startActualRecording = () => {
    const stream = audioStreamRef.current;
    if (!stream) { setMode("idle"); return; }

    setMode("recording");
    setElapsed(0);
    audioChunksRef.current = [];

    // Web Audio analyser drives the live waveform.
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const audioCtx = new Ctx();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    analyserRef.current = analyser;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    // v34.8 silence watchdog: the analyser is already sampling the mic for
    // the waveform — reuse it to catch a granted-but-silent input. If the
    // loudest FFT bin stays near zero for the first 4 seconds, tell the
    // user NOW instead of letting them narrate 60s into a dead mic.
    const silenceWatch = { t0: Date.now(), peak: 0, warned: false };
    const tick = () => {
      analyser.getByteFrequencyData(dataArray);
      // Sample 32 evenly-spaced bins from the FFT for our 32 bars.
      for (let i = 0; i < 32; i++) {
        const binIndex = Math.floor((i / 32) * dataArray.length);
        const value = dataArray[binIndex] / 255;
        silenceWatch.peak = Math.max(silenceWatch.peak, value);
        // Apply a slight curve so quiet sounds still register.
        const scaled = Math.max(0.06, Math.pow(value, 0.7));
        const bar = barRefs.current[i];
        if (bar) bar.style.transform = `scaleY(${scaled})`;
      }
      if (!silenceWatch.warned && Date.now() - silenceWatch.t0 > 4000 && silenceWatch.peak < 0.02) {
        silenceWatch.warned = true;
        setError(
          "We're not hearing anything from your microphone. Check your Mac's input device and level (System Settings → Sound → Input), or cancel and use 'Upload audio file' instead."
        );
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    // MediaRecorder — try opus webm first (best compatibility + size),
    // fall back to mp4 (Safari) or default container.
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 96000 })
      : new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
      // v34.8 fingerprint — if capture ever silently fails again, DevTools
      // names the culprit in one line instead of a debugging session.
      console.info(
        `[voice-rec] captured ${audioChunksRef.current.length} chunk(s), ${blob.size} bytes, type=${blob.type || "?"}`
      );
      // v34.8: a silent/dead capture produces a tiny or empty blob. Never
      // present that as a reviewable recording — the player would be dead
      // and "Use this voice" would bounce off the server's 16KB floor.
      if (blob.size < 12 * 1024) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        if (audioStreamRef.current) {
          audioStreamRef.current.getTracks().forEach((t) => t.stop());
          audioStreamRef.current = null;
        }
        if (audioCtxRef.current) {
          audioCtxRef.current.close().catch(() => {});
          audioCtxRef.current = null;
        }
        if (elapsedIntervalRef.current) {
          window.clearInterval(elapsedIntervalRef.current);
          elapsedIntervalRef.current = 0;
        }
        setElapsed(0);
        setMode("idle");
        setError(
          `The recording captured almost no audio (${blob.size} bytes) — your microphone isn't delivering sound. ` +
          `On a Mac: System Settings → Privacy & Security → Microphone → allow your browser, then Sound → Input to pick a working device. ` +
          `Or record a 60-second Voice Memo and use 'Upload audio file' — the clone comes out identical.`
        );
        return;
      }
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
      const url = URL.createObjectURL(blob);
      setRecordedBlob(blob);
      setRecordedUrl(url);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      // Tear down the live mic stream — the recorded blob is what we keep.
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((t) => t.stop());
        audioStreamRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      if (elapsedIntervalRef.current) {
        window.clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = 0;
      }
      setMode("review");
    };
    recorder.start(250);

    // Timer ticking up to MAX_DURATION_SEC; auto-stops at the cap.
    startedAtRef.current = Date.now();
    elapsedIntervalRef.current = window.setInterval(() => {
      const sec = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsed(sec);
      if (sec >= MAX_DURATION_SEC) {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }
      }
    }, 200);
  };

  const stopRecording = () => {
    if (elapsed < MIN_DURATION_SEC) {
      setError(`Hold on — record at least ${MIN_DURATION_SEC} seconds so the clone has enough audio.`);
      return;
    }
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const cancelRecording = () => {
    stopAndCleanup();
    audioChunksRef.current = [];
    setElapsed(0);
    setMode("idle");
  };

  /* -----------------------------------------------------------------
     Review → submit / re-record
     ----------------------------------------------------------------- */
  const reRecord = () => {
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedBlob(null);
    setRecordedUrl("");
    setElapsed(0);
    setMode("idle");
  };

  const submitRecording = async () => {
    if (!recordedBlob) return;
    if (!branding.fullName.trim()) {
      setError("Add your full name above first.");
      return;
    }
    setMode("cloning");
    try {
      const audioBase64 = await blobToBase64(recordedBlob);
      const ext = (recordedBlob.type.includes("mp4") ? "m4a" : "webm");
      const res = await fetch("/api/clone-voice", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          audioBase64,
          fileName: `${branding.fullName.split(/\s+/)[0] || "agent"}-voice.${ext}`,
          contentType: recordedBlob.type || "audio/webm",
          voiceLabel: branding.fullName.split(/\s+/)[0] || branding.fullName
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `Voice clone failed (${res.status}).`);
      // v34.7: the clone id lives in BOTH fields — voiceId makes it the
      // active narrator now; clonedVoiceId remembers it permanently so a
      // preset pick in Settings can never destroy the linkage again.
      setBranding({
        voiceId: payload.voiceId,
        voiceLabel: payload.voiceLabel || branding.fullName.split(/\s+/)[0] || "",
        clonedVoiceId: payload.voiceId,
        clonedVoiceLabel: payload.voiceLabel || branding.fullName.split(/\s+/)[0] || ""
      });
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
      setRecordedBlob(null);
      setRecordedUrl("");
      setToast("Your voice is cloned and ready.");
      setMode("cloned");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Voice clone failed";
      setError(msg);
      setMode("review");
    }
  };

  /* -----------------------------------------------------------------
     File upload fallback
     ----------------------------------------------------------------- */
  const handleFileUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setError("That doesn't look like an audio file. Use MP3, M4A, WAV, or WebM.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("Audio file must be under 8MB. Trim it to about 60–90 seconds.");
      return;
    }
    if (!branding.fullName.trim()) {
      setError("Add your full name above first.");
      return;
    }
    setMode("cloning");
    try {
      const audioBase64 = await blobToBase64(file);
      const res = await fetch("/api/clone-voice", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          audioBase64,
          fileName: file.name,
          contentType: file.type,
          voiceLabel: branding.fullName.split(/\s+/)[0] || branding.fullName
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `Voice clone failed (${res.status}).`);
      setBranding({
        voiceId: payload.voiceId,
        voiceLabel: payload.voiceLabel || branding.fullName.split(/\s+/)[0] || "",
        clonedVoiceId: payload.voiceId,
        clonedVoiceLabel: payload.voiceLabel || branding.fullName.split(/\s+/)[0] || ""
      });
      setToast("Your voice is cloned and ready.");
      setMode("cloned");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Voice clone failed";
      setError(msg);
      setMode("idle");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /* -----------------------------------------------------------------
     Cloned-state actions: preview + remove
     ----------------------------------------------------------------- */
  const previewVoice = async () => {
    // v34.7: preview the CLONE specifically — this card is the clone card.
    // The old `if (!branding.voiceId) return;` was a silent no-op whenever
    // Settings had reset voiceId ("clicked Preview, nothing happened"), and
    // when voiceId held a preset slug it previewed the preset while
    // claiming to be your clone.
    const cloneId = cloneVoiceIdOf(branding);
    if (!cloneId) {
      setError("No cloned voice found — record or upload a sample first.");
      return;
    }
    setPreviewLoading(true);
    try {
      const text = `Hi, I'm ${cloneVoiceLabelOf(branding) || branding.fullName.split(/\s+/)[0] || "your agent"}. This is how I'll sound on every Vistalia video.`;
      const res = await fetch("/api/synthesize-narration", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ voiceId: cloneId, text })
      });
      if (!res.ok) {
        const errPayload = await res.json().catch(() => ({}));
        throw new Error(errPayload.error || `Preview failed (${res.status}).`);
      }
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audio.play().catch(() => setError("Couldn't autoplay — your browser blocked it."));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Preview failed";
      setError(msg);
    } finally {
      setPreviewLoading(false);
    }
  };

  const removeVoice = () => {
    setBranding({ voiceId: "", voiceLabel: "", clonedVoiceId: "", clonedVoiceLabel: "" });
    setMode("idle");
    setToast("Voice clone removed");
  };

  /* -----------------------------------------------------------------
     RENDER
     ----------------------------------------------------------------- */
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const maxLabel = `${Math.floor(MAX_DURATION_SEC / 60)}:${String(MAX_DURATION_SEC % 60).padStart(2, "0")}`;

  // Cloned state — clean, confident "ready" card. v34.7: keyed off the
  // dedicated clone field, so a preset pick in Settings no longer hides it.
  if (mode === "cloned" && cloneVoiceIdOf(branding)) {
    return (
      <div>
        <VoiceHeader />
        <div className="flex flex-wrap items-center gap-3 p-4 bg-surface-input border border-gold/30 rounded-xl">
          <div className="grid place-items-center w-10 h-10 rounded-full bg-gold/20 text-gold flex-shrink-0">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 2v6m0 8v6M5 12h14" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold tracking-tightish truncate">
              {branding.voiceLabel || "Your voice"} <span className="text-gold-light font-normal">— ready</span>
            </div>
            <div className="text-xs text-ink-muted mt-0.5">Narrating every render in your voice.</div>
          </div>
          <button
            type="button"
            onClick={previewVoice}
            disabled={previewLoading}
            className="btn-secondary-em h-9 px-3.5 rounded-lg text-xs disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {previewLoading ? (
              <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> Loading…</>
            ) : (
              <>▸ Preview</>
            )}
          </button>
          <button
            type="button"
            onClick={removeVoice}
            className="text-xs text-ink-muted hover:text-red-300 transition-colors"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  // Cloning — submitting to ElevenLabs
  if (mode === "cloning") {
    return (
      <div>
        <VoiceHeader />
        <div className="bg-surface-input border border-gold/30 rounded-xl p-6 text-center">
          <div className="grid place-items-center w-12 h-12 mx-auto rounded-full bg-gold/15 text-gold mb-3">
            <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
          </div>
          <div className="text-sm font-semibold tracking-tightish">Cloning your voice…</div>
          <p className="text-xs text-ink-muted mt-1.5 leading-relaxed max-w-sm mx-auto">
            Locking in your voiceprint. About 30 seconds — don't refresh.
          </p>
        </div>
      </div>
    );
  }

  // Permission-pending — granted between user click and getUserMedia resolving
  if (mode === "permission") {
    return (
      <div>
        <VoiceHeader />
        <div className="bg-surface-input border border-gold/30 rounded-xl p-6 text-center">
          <div className="grid place-items-center w-12 h-12 mx-auto rounded-full bg-gold/15 text-gold mb-3">
            <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
          </div>
          <div className="text-sm font-semibold tracking-tightish">Asking for microphone access…</div>
          <p className="text-xs text-ink-muted mt-1.5">If your browser shows a permission prompt, click "Allow."</p>
        </div>
      </div>
    );
  }

  // Countdown
  if (mode === "countdown") {
    return (
      <div>
        <VoiceHeader />
        <div className="bg-surface-input border border-gold/40 rounded-xl p-8 text-center">
          <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-gold mb-4">Recording in</div>
          <div className="text-7xl font-bold text-gold tracking-tighter2 leading-none mb-3" style={{ fontFeatureSettings: "'tnum'" }}>
            {countdown}
          </div>
          <p className="text-xs text-ink-muted mt-3">Get ready to speak — your microphone is on.</p>
          <button
            type="button"
            onClick={cancelRecording}
            className="text-xs text-ink-muted hover:text-ink mt-4 underline-offset-4 hover:underline"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Recording — live waveform + timer
  if (mode === "recording") {
    const progressPct = Math.min(100, (elapsed / MAX_DURATION_SEC) * 100);
    return (
      <div>
        <VoiceHeader />
        <div className="bg-surface-input border border-gold/40 rounded-xl p-5">
          {/* Header row — REC indicator + timer */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="relative flex w-2.5 h-2.5">
                <span className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-60" />
                <span className="relative w-2.5 h-2.5 rounded-full bg-red-500" />
              </span>
              <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-red-400 font-semibold">Recording</span>
            </div>
            <div className="font-mono text-sm text-gold tabular-nums" style={{ fontFeatureSettings: "'tnum'" }}>
              {elapsedLabel}
              <span className="text-ink-muted"> / {maxLabel}</span>
            </div>
          </div>

          {/* Live waveform — 32 bars driven via DOM mutation */}
          <div className="flex items-center justify-center gap-[3px] h-20 mb-4">
            {Array.from({ length: 32 }).map((_, i) => (
              <div
                key={i}
                ref={(el) => { barRefs.current[i] = el; }}
                className="w-1.5 origin-center bg-gradient-to-t from-gold-dim to-gold-light rounded-full"
                style={{ height: "100%", transform: "scaleY(0.06)", willChange: "transform", transition: "transform 60ms linear" }}
              />
            ))}
          </div>

          {/* Time progress bar */}
          <div className="h-1 bg-edge rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-gradient-to-r from-gold-dim to-gold-light rounded-full"
              style={{ width: `${progressPct}%`, transition: "width 200ms linear" }}
            />
          </div>

          {/* Suggested script + controls */}
          <p className="text-xs text-ink-muted mb-4 leading-relaxed text-center max-w-md mx-auto">
            Speak naturally. Try: <span className="text-ink-soft italic">"Hi, I'm {branding.fullName.split(/\s+/)[0] || "your agent"}. I help families find homes in {branding.brokerage ? "the area we love" : "the neighborhoods I know best"}…"</span>
          </p>

          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={cancelRecording}
              className="btn-secondary-em h-10 px-4 rounded-lg text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={stopRecording}
              disabled={elapsed < MIN_DURATION_SEC}
              className={cn(
                "h-10 px-5 rounded-lg text-xs font-semibold inline-flex items-center gap-2 transition-all",
                elapsed >= MIN_DURATION_SEC
                  ? "bg-red-500/15 text-red-400 border border-red-500/40 hover:bg-red-500/25"
                  : "bg-surface text-ink-muted border border-edge cursor-not-allowed opacity-60"
              )}
            >
              <span className="block w-2.5 h-2.5 bg-red-500 rounded-sm" />
              Stop recording
              {elapsed < MIN_DURATION_SEC && <span className="ml-1 text-ink-dim">({MIN_DURATION_SEC - elapsed}s more)</span>}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Review — playback + submit / re-record
  if (mode === "review") {
    return (
      <div>
        <VoiceHeader />
        <div className="bg-surface-input border border-gold/30 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="grid place-items-center w-7 h-7 rounded-full bg-gold/15 text-gold">
              <svg viewBox="0 0 12 12" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M2 6l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tightish">Recording captured ({elapsedLabel})</div>
              <div className="text-[11px] text-ink-muted">Listen back — if it sounds good, clone it.</div>
            </div>
          </div>
          <audio
            src={recordedUrl}
            controls
            className="w-full mb-4 rounded-md"
            style={{ filter: "invert(0.85)", colorScheme: "light" }}
            onError={() =>
              setError(
                "Playback of the recording failed in this browser — but the captured audio itself is fine, so 'Use this voice' will still clone correctly. Or re-record / upload a file instead."
              )
            }
          />
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={submitRecording}
              className="btn-primary-em h-10 px-5 rounded-lg text-xs flex-1 sm:flex-initial"
            >
              Use this voice →
            </button>
            <button
              type="button"
              onClick={reRecord}
              className="btn-secondary-em h-10 px-4 rounded-lg text-xs"
            >
              Re-record
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Idle — initial CTA
  return (
    <div>
      <VoiceHeader />
      <div className="bg-surface-input border border-edge-strong border-dashed rounded-xl p-6 text-center hover:border-gold transition-colors">
        <div className="grid place-items-center w-14 h-14 mx-auto rounded-full bg-gold/10 text-gold mb-3">
          <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="text-base font-semibold tracking-tightish mb-1.5">Tap to record your voice</div>
        <p className="text-xs text-ink-muted leading-relaxed max-w-md mx-auto mb-4">
          About 60–90 seconds in a quiet room. Read your favorite listing description, or just talk naturally
          about what you do. Clarity matters more than content.
        </p>
        <button
          type="button"
          onClick={beginRecording}
          className="btn-primary-em h-11 px-6 rounded-lg text-sm inline-flex items-center gap-2"
        >
          <span className="block w-2 h-2 bg-paper rounded-full" />
          Start recording
        </button>

        {/* Secondary actions: file upload + connection test */}
        <div className="mt-5 pt-4 border-t border-edge-soft flex items-center justify-center gap-4 flex-wrap">
          <label className="text-xs text-ink-muted hover:text-gold transition-colors cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => handleFileUpload(e.target.files)}
            />
            Or upload an audio file
          </label>
          <span className="text-ink-dim">·</span>
          <VoiceDiagnosticButton />
        </div>
      </div>
    </div>
  );
}

// Hits /api/clone-voice?diagnose=1 and shows whether the ElevenLabs key
// works, what tier the account is on, and whether voice cloning is
// available — without burning a real upload. Critical for debugging
// "audio upload broken" issues without needing Vercel function logs.
function VoiceDiagnosticButton() {
  const [running, setRunning] = useState(false);
  const setError = useStore((s) => s.setError);
  const setToast = useStore((s) => s.setToast);

  const run = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/clone-voice?diagnose=1", { headers: await authHeaders() });
      const payload = await res.json().catch(() => ({}));
      if (payload.ok && payload.canCloneVoice) {
        setToast(`✓ Voice service connected. Voice cloning is available.`);
      } else if (payload.ok && !payload.canCloneVoice) {
        // v42: this used to tell CUSTOMERS to upgrade Vistalia's own vendor
        // plan at elevenlabs.io — operator diagnostics leaking into customer
        // UI. Details for the operator live in the Vercel function logs.
        setError(`Voice cloning is temporarily unavailable — studio voices still work. We're on it.`);
      } else {
        setError(payload.message || "Could not reach the voice service. Please try again in a moment.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Diagnostic failed";
      setError(msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      disabled={running}
      className="text-xs text-ink-muted hover:text-gold transition-colors disabled:opacity-50 inline-flex items-center gap-1"
    >
      {running ? (
        <><span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> Testing…</>
      ) : (
        <>Test connection</>
      )}
    </button>
  );
}

function VoiceHeader() {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <div>
        <h3 className="text-sm font-semibold tracking-tightish flex items-center gap-2">
          Voice clone
          <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-gold text-paper">PRO</span>
        </h3>
        <p className="text-xs text-ink-muted mt-0.5">
          Every video gets narrated in your voice. One quick recording, every render forever after.
        </p>
      </div>
    </div>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Audio read failed"));
    reader.readAsDataURL(blob);
  });
}

/* ============================================================
   Engine toggle (Quick Reel vs Cinematic AI)
   ============================================================ */
function EngineToggle({ engine, onChange }: { engine: RenderEngine; onChange: (e: RenderEngine) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <EngineCard
        active={engine === "remotion"}
        title="Photo Motion"
        description="Smooth cinematic pans across your photos. Fast, reliable, zero AI artifacts. Best for any listing — always works."
        meta="~90 seconds • every plan"
        onClick={() => onChange("remotion")}
      />
      <EngineCard
        active={engine === "runway"}
        title="Cinematic AI"
        proTag
        description="True AI camera motion generated from each photo, with a per-scene quality inspection — any scene that fails is regenerated automatically. Best for hero exteriors and living spaces."
        meta="5–7 minutes • Pro & Studio plans"
        onClick={() => onChange("runway")}
      />
    </div>
  );
}

/* ============================================================
   v24.2 audio controls — voice on/off, music on/off, music volume.
   ============================================================
   Renders inside a top-level Section. Reads + writes the same store
   fields used by the render manifest builder, so changes propagate
   at the next Generate.
*/
function AudioControls() {
  const narrationEnabled = useStore((s) => s.narrationEnabled);
  const setNarrationEnabled = useStore((s) => s.setNarrationEnabled);
  const captionsEnabled = useStore((s) => s.captionsEnabled);
  const setCaptionsEnabled = useStore((s) => s.setCaptionsEnabled);
  const musicEnabled = useStore((s) => s.musicEnabled);
  const setMusicEnabled = useStore((s) => s.setMusicEnabled);
  const musicVolume = useStore((s) => s.musicVolume);
  const setMusicVolume = useStore((s) => s.setMusicVolume);

  const volumePct = Math.round(musicVolume * 100);

  return (
    <div className="flex flex-col gap-4">
      {/* v38: word-synced captions — only meaningful when narration is on */}
      {narrationEnabled && (
        <button
          type="button"
          onClick={() => setCaptionsEnabled(!captionsEnabled)}
          className={cn(
            "card-press text-left p-3 rounded-lg bg-surface border transition-colors",
            captionsEnabled
              ? "border-gold bg-surface-raised card-selected"
              : "border-edge hover:border-edge-strong"
          )}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-sm font-semibold tracking-tightish">Captions</span>
            <span className={cn(
              "text-[10px] font-mono uppercase tracking-wider",
              captionsEnabled ? "text-gold" : "text-ink-muted"
            )}>
              {captionsEnabled ? "ON" : "OFF"}
            </span>
          </div>
          <div className="text-xs text-ink-muted">
            Word-synced captions styled to your video — most viewers watch Reels muted
          </div>
        </button>
      )}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setNarrationEnabled(!narrationEnabled)}
          className={cn(
            "card-press text-left p-3 rounded-lg bg-surface border transition-colors",
            narrationEnabled
              ? "border-gold bg-surface-raised card-selected"
              : "border-edge hover:border-edge-strong"
          )}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-sm font-semibold tracking-tightish">Voice narration</span>
            <span className={cn(
              "text-[10px] font-mono uppercase tracking-wider",
              narrationEnabled ? "text-gold" : "text-ink-muted"
            )}>
              {narrationEnabled ? "ON" : "OFF"}
            </span>
          </div>
          <div className="text-xs text-ink-muted">AI voice reads listing details over each scene</div>
        </button>

        <button
          type="button"
          onClick={() => setMusicEnabled(!musicEnabled)}
          className={cn(
            "card-press text-left p-3 rounded-lg bg-surface border transition-colors",
            musicEnabled
              ? "border-gold bg-surface-raised card-selected"
              : "border-edge hover:border-edge-strong"
          )}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-sm font-semibold tracking-tightish">Background music</span>
            <span className={cn(
              "text-[10px] font-mono uppercase tracking-wider",
              musicEnabled ? "text-gold" : "text-ink-muted"
            )}>
              {musicEnabled ? "ON" : "OFF"}
            </span>
          </div>
          <div className="text-xs text-ink-muted">Plays your selected track throughout the video</div>
        </button>
      </div>

      {/* v26.9: "use your own voice" surfaced HERE, under the narration toggle,
          where agents look for it — instead of buried in the brand-kit panel.
          Record once → every future listing narrates in your actual voice. */}
      {narrationEnabled && (
        <div className="p-4 rounded-lg border border-gold/30 bg-gold/[0.04]">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-sm font-semibold tracking-tightish">Whose voice?</span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-gold">Your voice</span>
          </div>
          <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
            Pick one of our professional narrators — or record once and narrate every listing in your own voice, automatically.
          </p>

          {/* Default narrator picker — usable right here in the render pipeline,
              not just buried in Settings. Writes branding.voiceId (a slug). */}
          <VoiceSection />

          <div className="flex items-center gap-3 my-4">
            <div className="h-px flex-1 bg-edge" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-ink-dim">or use your own voice</span>
            <div className="h-px flex-1 bg-edge" />
          </div>

          <VoiceCloneCard />
        </div>
      )}

      {musicEnabled && (
        <div className="p-3 rounded-lg border border-edge bg-surface-input/30">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-xs font-semibold text-ink tracking-tightish">Music volume</span>
            <span className="text-[10px] font-mono text-ink-muted tabular-nums">{volumePct}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={150}
            step={5}
            value={volumePct}
            onChange={(e) => setMusicVolume(Number(e.target.value) / 100)}
            className="w-full accent-gold"
            aria-label="Music volume"
          />
          <div className="flex justify-between text-[10px] text-ink-muted mt-1 font-mono uppercase tracking-wider">
            <span>Quiet</span>
            <span>Default</span>
            <span>Loud</span>
          </div>
          {narrationEnabled && (
            <div className="text-[11px] text-ink-muted mt-2">
              Music auto-ducks under voice — voice always plays clearly above the music.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   v24 length toggle — 30s default / 60s max.
   ============================================================
   Drives manifest.targetDurationSec → edit-plan scene count.
   30s ≈ 6 Cinematic AI scenes (or ~10 Quick Reel). 60s doubles that.
*/
/* v35.1: formats are OPT-IN. The square is a real 1:1 re-composition
   (~2 extra minutes of render time), and most agents only want the 9:16 —
   so the default is vertical-only and the square is a deliberate choice. */
function FormatsToggle() {
  const includeSquare = useStore((s) => s.includeSquare);
  const setIncludeSquare = useStore((s) => s.setIncludeSquare);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2.5">
        <h3 className="text-sm font-semibold tracking-tightish">Formats</h3>
        <span className="text-xs text-ink-muted">Square is composed separately — not a crop</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setIncludeSquare(false)}
          className={cn(
            "card-press text-left p-3 rounded-lg bg-surface border",
            !includeSquare
              ? "border-gold bg-surface-raised card-selected"
              : "border-edge hover:border-edge-strong"
          )}
        >
          <div className="text-sm font-semibold tracking-tightish mb-0.5">Vertical · 9:16</div>
          <div className="text-xs text-ink-muted">Reels · TikTok · Shorts — fastest render</div>
        </button>
        <button
          type="button"
          onClick={() => setIncludeSquare(true)}
          className={cn(
            "card-press text-left p-3 rounded-lg bg-surface border",
            includeSquare
              ? "border-gold bg-surface-raised card-selected"
              : "border-edge hover:border-edge-strong"
          )}
        >
          <div className="text-sm font-semibold tracking-tightish mb-0.5">Vertical + Square · 1:1</div>
          <div className="text-xs text-ink-muted">Adds IG/FB feed format · ~2 min longer</div>
        </button>
      </div>
    </div>
  );
}

function LengthToggle({ value, onChange }: { value: 30 | 60; onChange: (v: 30 | 60) => void }) {
  const setToast = useStore((s) => s.setToast);
  // v49: the FREE trial video is capped at 30 seconds (server-enforced in
  // /api/render — first customer render was a surprise 60s/2-credit-class
  // freebie). Surface the cap on the picker so trial users aren't invited
  // into a paywall bounce. Trial WITH purchased credits renders 60s
  // normally (consumes 2).
  const [freeSixtyLocked, setFreeSixtyLocked] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchUsage()
      .then((u) => {
        if (!alive || !u) return;
        const locked = u.tier === "trial" && Number(u.render_credits || 0) < 1;
        setFreeSixtyLocked(locked);
        if (locked) onChange(30); // persisted 60 from an earlier session → snap back
      })
      .catch(() => {}); // usage fetch failure → leave unlocked; server still enforces
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2.5">
        <h3 className="text-sm font-semibold tracking-tightish">Video length</h3>
        <span className="text-xs text-ink-muted">Shorter = higher completion + cheaper render</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onChange(30)}
          className={cn(
            "card-press text-left p-3 rounded-lg bg-surface border",
            value === 30
              ? "border-gold bg-surface-raised card-selected"
              : "border-edge hover:border-edge-strong"
          )}
        >
          <div className="text-sm font-semibold tracking-tightish mb-0.5">30 seconds</div>
          <div className="text-xs text-ink-muted">Reels · TikTok · best completion rate</div>
        </button>
        <button
          type="button"
          onClick={() => {
            if (freeSixtyLocked) {
              setToast("Your free trial video is 30 seconds — upgrade or grab a credit pack for 60-second tours.");
              return;
            }
            onChange(60);
          }}
          className={cn(
            "card-press text-left p-3 rounded-lg bg-surface border relative",
            value === 60 && !freeSixtyLocked
              ? "border-gold bg-surface-raised card-selected"
              : "border-edge hover:border-edge-strong",
            freeSixtyLocked && "opacity-70"
          )}
        >
          {freeSixtyLocked && (
            <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-gold/15 border border-gold/40 text-gold text-[9px] font-bold tracking-widest uppercase">
              Paid plans
            </span>
          )}
          <div className="text-sm font-semibold tracking-tightish mb-0.5">60 seconds</div>
          <div className="text-xs text-ink-muted">
            {freeSixtyLocked ? "Free trial video is 30s — upgrade to unlock" : "Longer tour · Zillow · listing site"}
          </div>
        </button>
      </div>
    </div>
  );
}

function EngineCard({
  active,
  title,
  description,
  meta,
  proTag,
  betaTag,
  onClick
}: {
  active: boolean;
  title: string;
  description: string;
  meta: string;
  proTag?: boolean;
  betaTag?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "card-press text-left p-4 rounded-xl bg-surface border",
        active
          ? "border-gold bg-surface-raised card-selected"
          : "border-edge hover:border-edge-strong"
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-base font-semibold tracking-tightish">{title}</span>
        {proTag && (
          <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-gold text-paper">
            PRO
          </span>
        )}
        {betaTag && (
          <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded border border-gold text-gold">
            BETA
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
  const branding = useStore((s) => s.branding);
  const organization = useStore((s) => s.organization);
  const selectedStyleId = useStore((s) => s.selectedStyleId);
  const selectedMusicTrackId = useStore((s) => s.selectedMusicTrackId);
  const targetDurationSec = useStore((s) => s.targetDurationSec);
  const setTargetDuration = useStore((s) => s.setTargetDuration);
  const narrationEnabled = useStore((s) => s.narrationEnabled);
  const musicEnabled = useStore((s) => s.musicEnabled);
  const musicVolume = useStore((s) => s.musicVolume);
  const crossfadesEnabled = useStore((s) => s.crossfadesEnabled);
  const renderEngine = useStore((s) => s.renderEngine);
  const renderSafety = useStore((s) => s.renderSafety);
  const renderJob = useStore((s) => s.renderJob);
  const projectId = useStore((s) => s.projectId);
  const projectTitle = useStore((s) => s.projectTitle);
  const setRenderJob = useStore((s) => s.setRenderJob);
  const setLastRenderManifest = useStore((s) => s.setLastRenderManifest);
  const setError = useStore((s) => s.setError);
  const setLoading = useStore((s) => s.setLoading);
  const setEditPlan = useStore((s) => s.setEditPlan);
  const setToast = useStore((s) => s.setToast);

  // v26.6: paywall state for the free-video → paid moment.
  const [showPaywall, setShowPaywall] = useState(false);
  const [paywallReason, setPaywallReason] = useState<string>("");

  const isRendering = renderJob?.status === "queued" || renderJob?.status === "rendering";
  const isComplete = renderJob?.status === "completed" && renderJob.mp4Url;
  const canRender = photos.length >= 3 && !isRendering;

  const generate = async () => {
    if (!session?.user) { setError("Your session expired. Sign in again to keep going."); return; }
    if (photos.length < 3) { setError("Add at least 3 photos before we can render."); return; }

    setError("");

    // KEY FIX #1: show the progress panel IMMEDIATELY on click. The earlier
    // implementation showed a tiny "Directing…" toast for ~10 seconds before
    // anything moved on screen. Now the user sees the panel mount the same
    // frame they click, and the bar starts ticking forward right away.
    setRenderJob({
      jobId: "",
      status: "queued",
      phase: "Directing your tour",
      progress: 2,
      // v40: hardcode "veo" for the optimistic panel. The store's
      // renderEngine still defaults to the retired "remotion", which made
      // the eyebrow read "PHOTO MOTION" (the fallback tier's name) for the
      // first seconds of every render until the worker's status arrived.
      engine: "veo"
    });
    // The legacy `loading` toast is replaced by the progress panel — clear it.
    setLoading("");

    // KEY FIX #2: while waiting on async work that has no real progress
    // signal (edit plan generation, render submission), creep the bar forward
    // a tiny bit so the user always sees forward motion. When the real
    // progress signal arrives from the worker, we snap to it.
    const phaseCreep = startPhaseCreep({ ceilingProgress: 9 });

    try {
      // 1. Get edit plan
      // v38.3: no silent style defaults (master-19 shipped the wrong style
      // invisibly). Log what actually goes to the plan + worker.
      const matchedStyle = STYLES.find((s) => s.id === selectedStyleId);
      if (!matchedStyle) console.error(`[render] UNKNOWN styleId "${selectedStyleId}" — defaulting to Cinematic Luxury`);
      const styleLabel = matchedStyle?.engineLabel || "Cinematic Luxury";
      console.info(`[render] style: ${styleLabel} (${selectedStyleId})`);
      const planResult = await createEditPlan({
        photos,
        listing,
        selectedStyle: styleLabel,
        exportFormat: "vertical",
        // v26.9 FIX: single Veo engine. The store's renderEngine still
        // defaults to "remotion" (the toggle that set it was removed), and
        // an edit plan generated for "remotion" carries NO motion prompts —
        // so the Veo render then failed validation ("missing prompt"). Always
        // request the plan as "veo" so veoPrompt is generated per scene.
        engine: "veo",
        brandKit: branding,
        targetDurationSec,
        // v30 beat-sync: send the SAME track the manifest will use (below), so
        // the plan snaps scene cuts to this track's actual beat grid.
        musicTrack: resolveTrack(selectedMusicTrackId, selectedStyleId).filename
      });
      if (!planResult.editPlan) {
        throw new Error(planResult.reason || "We couldn't draft an edit plan. Try again in a moment.");
      }
      setEditPlan(planResult.editPlan);

      // 2. Build manifest
      phaseCreep.update({ phase: "Sending the cut to the renderer", progressFloor: 10, ceilingProgress: 14 });
      const manifest: RenderManifest = {
        app: "Vistalia",
        // v26.6: single production engine. The worker upgrades "veo"
        // (and legacy "runway") through the Veo 3.1 pipeline.
        engine: "veo",
        exportFormat: "vertical",
        project: {
          id: projectId,
          userId: session.user.id,
          title: projectTitle,
          address: listing.address,
          city: listing.city,
          price: listing.price,
          beds: listing.beds,
          baths: listing.baths,
          squareFeet: listing.squareFeet,
          hook: listing.hook
        },
        scenes: planResult.editPlan.scenes.map((scene) => {
          const photo = photos.find((p) => p.id === scene.photoId);
          return {
            photoId: scene.photoId,
            type: "photo" as const,
            durableUrl: photo?.durableUrl,
            publicUrl: photo?.publicUrl,
            fileName: photo?.fileName,
            duration: scene.duration,
            roomType: scene.roomType,
            qualityScore: scene.qualityScore,
            cameraMotion: scene.cameraMotion,
            transition: scene.transition,
            overlay: scene.overlay,
            runwayPrompt: scene.runwayPrompt,
            // v26.9: forward veoPrompt so Veo uses its purpose-built
            // cinematography prompts (not the Runway-style fallback).
            veoPrompt: scene.veoPrompt,
            // narrationLine drives ElevenLabs synthesis on the worker
            narrationLine: scene.narrationLine || ""
          };
        }),
        orderedPhotos: photos,
        // v23: prompt version stamp — flows from /api/create-edit-plan
        // (PROMPT_VERSION constant) → editPlan → manifest → audit_log so
        // we can correlate quality complaints with specific prompt revisions.
        promptVersion: (planResult.editPlan as any).promptVersion || null,
        introCard: planResult.editPlan.introCard,
        outroCard: planResult.editPlan.outroCard,
        // v32: one continuous voiceover script for the whole tour — the
        // worker synthesizes it in a single TTS pass (no per-scene chops).
        narrationScript: (planResult.editPlan as any).narrationScript || "",
        musicMood: planResult.editPlan.musicMood,
        // Music selector: explicit track filename overrides the style
        // default in the worker's pickMusicUrl. Resolved here so the
        // payload always carries a concrete filename instead of the
        // worker having to re-derive it.
        musicTrack: resolveTrack(selectedMusicTrackId, selectedStyleId).filename,
        // v24.2: independent music + voice toggles. musicEnabled:false
        // skips the music mix step entirely. musicVolume multiplies the
        // worker's default musicBedLevel — 1.0 = unchanged, 0 = silent.
        skipMusic: !musicEnabled,
        musicBedLevel: 0.22 * musicVolume,
        selectedStyle: styleLabel,
        runwayConfig: {
          ...(planResult.editPlan.runwayConfig || {}),
          // Crossfades default on (xfade is the product). Manifest still
          // honors an explicit useCrossfades:false if MLS regions reject
          // blended frames.
          useCrossfades: crossfadesEnabled
        },
        brandKit: branding,
        organizationId: organization?.id || null,
        // v24.2: narrationEnabled is now exposed in the Audio panel.
        // Worker still fail-soft to music-only if ElevenLabs is unavailable.
        skipNarration: !narrationEnabled,
        // v26.6: the Hallucination Guard now routes risky rooms (kitchen,
        // bath, pool, laundry) to constrained locked-tripod Veo prompts
        // instead of Ken Burns — always on, no user-facing safety picker.
        hallucinationGuard: "balanced",
        // v35.1: 1:1 square is opt-in (adds ~2 min; most agents want 9:16 only).
        includeSquare: useStore.getState().includeSquare === true,
        // v38: word-synced narration captions (Audio panel toggle).
        captionsEnabled: useStore.getState().captionsEnabled !== false
      };

      // v27: capture the manifest so the Edit Studio can re-render a single
      // scene against this exact job. Purely additive — never affects render.
      setLastRenderManifest(manifest);

      // 3. Submit
      const submitted = await submitRender(manifest);
      if (submitted.upgradeRequired) {
        phaseCreep.stop();
        setRenderJob(null); // clear the panel — paywall takes over
        // v26.6: open the buy-credits paywall instead of a dead-end error.
        setPaywallReason(submitted.error || "");
        setShowPaywall(true);
        return;
      }
      if (submitted.status === "failed") {
        throw new Error(submitted.error || "The renderer turned us down. Try again.");
      }

      phaseCreep.stop();
      track(events.renderStarted, {
        engine: renderEngine,
        sceneCount: planResult.editPlan.scenes.length
      });
      setRenderJob({
        jobId: submitted.jobId || "",
        status: submitted.status,
        phase: submitted.phase || "Queued for render",
        progress: Math.max(15, Number(submitted.progress) || 15),
        engine: renderEngine
      });
      setToast(
        `Render started — your cinematic video is usually ready in about ${useStore.getState().includeSquare ? 12 : 10} minutes, every scene verified.`
      );

      // 4. Poll
      if (submitted.jobId) pollUntilDone(submitted.jobId);
    } catch (err) {
      phaseCreep.stop();
      setRenderJob(null);
      const msg = err instanceof Error ? err.message : "Something blocked the render. Try once more.";
      setError(msg);
    }
  };

  // Drives a subtle forward creep on the progress bar while we're waiting
  // on async work whose real progress we can't observe. Returns an object
  // with `update()` to retarget the creep mid-flight (e.g. from "Directing"
  // to "Sending to renderer") and `stop()` to halt before the worker takes
  // over reporting real progress.
  function startPhaseCreep(initial: { ceilingProgress: number }) {
    const state = {
      ceiling: initial.ceilingProgress,
      stopped: false
    };
    const tick = () => {
      if (state.stopped) return;
      const cur = useStore.getState().renderJob;
      if (!cur) return;
      // Increment by tiny amounts until we hit ceiling. The visible CSS
      // transition smooths this even further so it never looks jerky.
      if (cur.progress < state.ceiling) {
        setRenderJob({ ...cur, progress: Math.min(state.ceiling, cur.progress + 0.35) });
      }
    };
    const interval = window.setInterval(tick, 350);
    return {
      update: ({ phase, progressFloor, ceilingProgress }: { phase?: string; progressFloor?: number; ceilingProgress?: number }) => {
        if (state.stopped) return;
        const cur = useStore.getState().renderJob;
        if (cur) {
          setRenderJob({
            ...cur,
            phase: phase || cur.phase,
            progress: Math.max(cur.progress, progressFloor || cur.progress)
          });
        }
        if (ceilingProgress != null) state.ceiling = ceilingProgress;
      },
      stop: () => {
        state.stopped = true;
        window.clearInterval(interval);
      }
    };
  }

  // v45.9: reconnect to an in-flight render after a refresh. Pairs with the
  // store's active-render persistence and App's boot routing. The first real
  // poll overwrites the placeholder phase/progress with server truth; if the
  // job finished while the tab was away, the poll lands on the completed
  // panel exactly as if we never left.
  useEffect(() => {
    if (useStore.getState().renderJob) return;
    try {
      const raw = localStorage.getItem("vistalia.active-render.v1");
      if (!raw) return;
      const saved = JSON.parse(raw) as { jobId?: string; engine?: string; startedAt?: number };
      const ageMs = Date.now() - (saved.startedAt || 0);
      // 35 min = worker's 25-min overall cap + polling slack. Older = stale key.
      if (!saved.jobId || ageMs > 35 * 60 * 1000) {
        localStorage.removeItem("vistalia.active-render.v1");
        return;
      }
      setRenderJob({
        jobId: saved.jobId,
        status: "rendering",
        phase: "Reconnecting to your render",
        progress: 15,
        engine: (saved.engine as typeof renderEngine) || renderEngine
      });
      pollUntilDone(saved.jobId);
    } catch {
      /* unparseable key — ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pollUntilDone = async (jobId: string) => {
    const startTime = Date.now();
    const maxMs = 26 * 60 * 1000; // worker's overall cap is 25 min (v31 audit) + 1 min slack
    let prevProgress = 0;
    let prevPhase = "";
    let lastProgressMovedAt = Date.now();
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;

    // Heartbeat-stuck threshold. If the WORKER's reported progress doesn't
    // advance for this long, we surface a clear "appears stuck" state with
    // retry options — instead of letting the user stare at a frozen bar
    // for the full 18-minute job timeout.
    //
    // v23 retune: bumped from 90s to 180s after Troy reported repeated
    // false positives at 81% — the stitch step legitimately takes 60-180s
    // on 24-clip renders even on Render Pro 4GB and emitted no progress
    // signals during that window. The worker now also emits a 25s
    // heartbeat ping during stitch (see runway-job.mjs near line 951),
    // so under normal operation the bar always moves at least every 25s
    // and this 180s threshold won't fire. Keeping it as a safety net
    // catches real hangs (worker crash, ffmpeg deadlock).
    const STUCK_THRESHOLD_MS = 180 * 1000;
    let stuckFlagged = false;

    let firstIteration = true;
    const POLL_INTERVAL_MS = 3000;

    while (Date.now() - startTime < maxMs) {
      if (!firstIteration) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      firstIteration = false;
      try {
        const status = await pollRender(jobId);
        consecutiveErrors = 0;

        const incomingProgress = Number(status.progress || 0);
        const safeProgress = Math.max(prevProgress, incomingProgress);
        if (safeProgress > prevProgress) {
          // Real movement — reset the stuck timer.
          lastProgressMovedAt = Date.now();
          stuckFlagged = false;
        }
        prevProgress = safeProgress;
        const safePhase = status.phase || prevPhase;
        prevPhase = safePhase;

        setRenderJob({
          ...status,
          jobId,
          progress: safeProgress,
          phase: safePhase,
          // v34.4: the status endpoint doesn't echo `engine`, so spreading
          // the response clobbered the client-set value with undefined on
          // the FIRST poll tick — every Veo render's status header flipped
          // to "Quick Reel · Ken Burns motion" two seconds in. Keep what
          // we know: response value if present, else previous, else the
          // engine this render was submitted with.
          engine: status.engine || useStore.getState().renderJob?.engine || renderEngine
        });

        if (status.status === "completed" || status.status === "failed") {
          // Bump the dashboard's usage counter so PlanStatusBanner re-fetches
          // and the meter / trial countdown reflects the just-finished render.
          if (status.status === "completed") {
            useStore.getState().bumpUsageRefresh();
            track(events.renderCompleted, { engine: renderEngine });
          }
          return;
        }

        // Stuck detection — console-only (launch: Troy 2026-07-12). The old
        // red banner ("worker may have crashed… check Render.com logs") fired
        // on every long stitch/sweep pause at ~81% and every render completed
        // anyway — a false alarm with a vendor name in it, shown to paying
        // customers at the most anxious moment. Real failures still surface
        // through status="failed" (refund-aware card) and the worker-restart
        // 404 → library recovery below. Keep the telemetry for us, show
        // nothing scary to the customer — the verification phases are SLOW
        // BY DESIGN and the ETA copy already says so.
        const stuckMs = Date.now() - lastProgressMovedAt;
        if (!stuckFlagged && stuckMs > STUCK_THRESHOLD_MS) {
          stuckFlagged = true;
          console.warn(
            `[render] no progress for ${Math.round(stuckMs / 1000)}s at ${Math.round(safeProgress)}% — assembly/verification phases run long; failure paths will surface via status if real.`
          );
        }
      } catch (err) {
        // SPECIAL CASE: the worker restarted while we were rendering. That
        // wipes its in-memory jobs Map → status returns 404. The render may
        // have actually FINISHED uploading to Supabase before the restart,
        // so check the library before declaring failure.
        if (err instanceof RenderJobMissingError) {
          const recovered = await tryRecoverFromLibrary(jobId, startTime);
          if (recovered) {
            // Map the library entry into renderJob state — UI will show the
            // completed-render panel exactly as if the poll finished.
            setRenderJob({
              jobId,
              status: "completed",
              phase: "Ready to download",
              progress: 100,
              mp4Url: recovered.mp4Url,
              thumbnailUrl: recovered.thumbnailUrl,
              engine: renderEngine
            });
            setToast(`Render finished — recovered from a worker restart.`);
            return;
          }
          // Couldn't recover. Surface a CLEAR restart-aware message instead
          // of the cryptic "Lost contact" — the user just needs to click
          // Generate again. Their photos + brand kit + safety settings are
          // all still in state.
          setError(
            `The render worker restarted before your video finished. Click Generate to retry — your photos, branding, and settings are still here.`
          );
          setRenderJob(null);
          return;
        }
        consecutiveErrors++;
        // v33 FREEZE FIX (test-8): NEVER abandon the poll on transient errors.
        // A worker crash-restart is a ~15-20s outage — five 3s polls — and the
        // old `return` here froze the UI at 15% while the pull queue recovered
        // and COMPLETED the render. Surface a soft warning, slow the poll, and
        // keep going; the loop still ends on completed/failed, true 404
        // (library recovery above), or the overall timeout.
        if (consecutiveErrors === maxConsecutiveErrors) {
          setError(
            `Having trouble reaching the render service — still trying. Your render is likely still running; the worker may be restarting.`
          );
        }
        if (consecutiveErrors >= maxConsecutiveErrors) {
          await new Promise((r) => setTimeout(r, 7000)); // back off to ~10s effective
        }
      }
    }
    setError("This render is taking longer than expected and timed out. Your credit hasn't been consumed by a failed render — check your Library in a few minutes in case it finished, or generate again. If this keeps happening, contact support@vistalia.ai.");
  };

  // After a 404 from the status endpoint, look at the library for a
  // freshly-completed entry that matches this render. The audit_log row's
  // job_id is the same value we just polled, so EXACT jobId match is the
  // reliable path. We only fall back to a time-window match when no jobId
  // match exists (covers very rare cases where the audit log was written
  // with a slightly different id — e.g., a worker hot-fix that munged the
  // id format).
  //
  // BUG FIX: previously this matched ONLY by createdAt window, which could
  // surface a different render's mp4Url if the user had multiple renders
  // going. Always prefer jobId equality.
  const tryRecoverFromLibrary = async (
    targetJobId: string,
    pollStartedAtMs: number
  ): Promise<{ mp4Url: string; thumbnailUrl: string } | null> => {
    try {
      const lib = await fetchLibrary({ limit: 25 });
      if (lib.status !== "ok" || !lib.library.length) return null;
      // 1) Exact jobId match — the safe path.
      const exact = lib.library.find(
        (entry) => entry.jobId === targetJobId && Boolean(entry.mp4Url)
      );
      if (exact) return { mp4Url: exact.mp4Url, thumbnailUrl: exact.thumbnailUrl };
      // 2) Fallback: time-window match (only if no jobId match found).
      // Tightened from 30 min to 10 min so we don't accidentally match
      // an unrelated earlier render.
      const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
      const cutoff = pollStartedAtMs - RECOVERY_WINDOW_MS;
      const fuzzy = lib.library.find((entry) => {
        const t = new Date(entry.createdAt).getTime();
        return Number.isFinite(t) && t >= cutoff && Boolean(entry.mp4Url);
      });
      if (!fuzzy) return null;
      return { mp4Url: fuzzy.mp4Url, thumbnailUrl: fuzzy.thumbnailUrl };
    } catch {
      return null;
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={generate}
        disabled={!canRender}
        className={cn(
          "btn-primary-em h-12 px-6 rounded-lg disabled:opacity-50 inline-flex items-center gap-2",
          canRender && !isComplete && "pulse-glow"
        )}
      >
        {isRendering ? (
          <>
            <span className="spinner" /> Rendering…
          </>
        ) : isComplete ? (
          "Render again"
        ) : (
          <>
            Generate video <span aria-hidden="true">→</span>
          </>
        )}
      </button>
      {photos.length < 3 && (
        <span className="text-sm text-ink-muted">
          Add at least 3 photos to render.
        </span>
      )}

      <PaywallModal
        open={showPaywall}
        onClose={() => setShowPaywall(false)}
        reason={paywallReason}
      />
    </div>
  );
}

/* ============================================================
   Render status panel — progress while rendering, video when done
   ============================================================ */
function RenderStatusPanel() {
  const renderJob = useStore((s) => s.renderJob);
  const goToScreen = useStore((s) => s.goToScreen);
  const projectTitle = useStore((s) => s.projectTitle);

  // v2.1: one-time confetti reward when a render lands successfully. Keyed on
  // jobId so it fires once per finished video, not on every re-render.
  const celebratedRef = useRef<string>("");
  const doneJobId = renderJob?.status === "completed" && renderJob.mp4Url ? renderJob.jobId : "";
  useEffect(() => {
    if (doneJobId && celebratedRef.current !== doneJobId) {
      celebratedRef.current = doneJobId;
      fireConfetti(0.5, 0.28);
    }
  }, [doneJobId]);

  if (!renderJob) return null;

  // Render completed but no master MP4 URL — a storage/delivery hiccup on
  // our side. Launch sweep: the old panel walked CUSTOMERS through the
  // Supabase dashboard; ops instructions belong in the runbook, not the UI.
  if (renderJob.status === "completed" && !renderJob.mp4Url) {
    return (
      <div className="bg-surface border border-amber-500/40 rounded-xl p-5 fade-up-in">
        <div className="flex items-start gap-3">
          <div className="grid place-items-center w-9 h-9 rounded-full bg-amber-500/15 text-amber-400 flex-shrink-0">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 8v4m0 4h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-amber-400">Your video rendered — delivery hit a snag</h3>
            <p className="text-xs text-ink-soft mt-1.5 leading-relaxed">
              The render finished, but the final file didn't make it to your library.
              This is on our side, not yours. Check your Library in a few minutes —
              it often lands after a short delay. If it doesn't, email{" "}
              <a href="mailto:support@vistalia.ai" className="text-gold underline">support@vistalia.ai</a>{" "}
              with this reference and we'll recover it: <code className="text-gold font-mono">{renderJob.jobId?.slice(-8) || "n/a"}</code>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (renderJob.status === "completed" && renderJob.mp4Url) {
    const formats = renderJob.formats || {};
    const verticalUrl = formats.vertical?.mp4Url || renderJob.mp4Url;
    const squareUrl = formats.square?.mp4Url || "";
    const wideUrl = formats.wide?.mp4Url || "";
    const shorts = renderJob.socialShorts || [];

    const formatPills: Array<{ label: string; sublabel: string; url: string; ratio: string }> = [
      { label: "9:16", sublabel: "Reels · TikTok · Shorts", url: verticalUrl, ratio: "9:16" }
    ];
    if (squareUrl) formatPills.push({ label: "1:1", sublabel: "Instagram feed", url: squareUrl, ratio: "1:1" });
    if (wideUrl)   formatPills.push({ label: "16:9", sublabel: "YouTube · Zillow · MLS", url: wideUrl, ratio: "16:9" });

    return (
      <div
        className="border border-gold/40 rounded-2xl p-5 sm:p-6 flex flex-col gap-5 fade-up-in"
        style={{ background: "radial-gradient(600px 200px at 50% -10%, rgba(199,167,108,0.10), transparent 60%), #18181C" }}
      >
        {/* v2 revamp: the reveal moment — the emotional peak that sells the
            next video. Cinematic Fraunces headline over the finished work. */}
        <div className="text-center pt-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-gold mb-2">Render complete</div>
          <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-tighter2 leading-tight">
            Your video's ready.
          </h2>
          <p className="text-ink-soft text-sm mt-2">Press play. Download every format below — or regenerate any scene that's not perfect.</p>
        </div>
        <video
          src={verticalUrl}
          controls
          playsInline
          poster={renderJob.thumbnailUrl}
          className="w-full max-h-[600px] rounded-xl bg-black ring-1 ring-edge"
          style={{ boxShadow: "0 30px 80px rgba(0,0,0,0.5), 0 0 60px rgba(199,167,108,0.08)" }}
        />

        {/* v27: Edit Studio — fix a single scene without re-rendering the whole video */}
        {Array.isArray(renderJob.scenes) && renderJob.scenes.length > 0 && (
          <button
            onClick={() => goToScreen("editStudio")}
            className="card-press w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-gold/30 bg-gold/[0.06] text-gold hover:bg-gold/[0.12] transition-colors text-sm font-semibold"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
            A scene not perfect? Open Edit Studio
          </button>
        )}

        {/* Format bundle — one render, every aspect ratio */}
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <h3 className="text-sm font-semibold tracking-tightish">Your full bundle</h3>
            <span className="text-xs text-ink-muted">All from one render.</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {formatPills.map((pill) => (
              <a
                key={pill.ratio}
                href={pill.url}
                onClick={(e) => {
                  // v33.3: `download` is ignored cross-origin (Supabase URLs),
                  // so clicks used to NAVIGATE to the mp4. Blob-force it.
                  e.preventDefault();
                  downloadVideo(pill.url, deliverableFilename(projectTitle || "listing", pill.ratio.replace(":", "x")));
                }}
                className="card-press flex items-center justify-between gap-3 p-3 bg-surface-input hover:bg-surface-raised border border-edge hover:border-gold rounded-lg transition-colors"
              >
                <div>
                  <div className="font-mono text-base font-semibold text-gold">{pill.label}</div>
                  <div className="text-xs text-ink-muted">{pill.sublabel}</div>
                </div>
                <span className="text-ink-muted group-hover:text-gold text-sm">↓</span>
              </a>
            ))}
          </div>
        </div>

        {/* Social shorts — Instagram Reels / TikTok ready */}
        {shorts.length > 0 && (
          <div>
            <div className="flex items-baseline justify-between mb-2.5">
              <h3 className="text-sm font-semibold tracking-tightish">Hero shorts</h3>
              <span className="text-xs text-ink-muted">{shorts.length} reel-ready cuts</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {shorts.map((short) => (
                <a
                  key={short.clipNumber}
                  href={short.mp4Url}
                  download
                  className="card-press group block bg-surface-input hover:bg-surface-raised border border-edge hover:border-gold rounded-lg overflow-hidden transition-colors"
                >
                  <div className="aspect-[9/16] bg-black grid place-items-center text-gold/60 text-xs font-mono uppercase tracking-wider relative">
                    <video
                      src={short.mp4Url}
                      muted
                      playsInline
                      preload="metadata"
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                    <span className="relative bg-paper/70 backdrop-blur-sm px-2 py-0.5 rounded text-[10px]">
                      {Math.round(short.durationSec)}s
                    </span>
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-medium capitalize">
                      Short {short.clipNumber}
                      {short.roomType && <span className="text-ink-muted ml-1">· {short.roomType}</span>}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Footer extras — thumbnail + render again */}
        <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-edge-soft">
          {renderJob.thumbnailUrl && (
            <a
              href={renderJob.thumbnailUrl}
              download
              className="text-xs text-ink-muted hover:text-gold transition-colors"
            >
              Download poster image
            </a>
          )}
        </div>
      </div>
    );
  }

  if (renderJob.status === "failed") {
    // Launch sweep: the legacy Runway daily-cap card (which linked customers
    // to runwayml.com pricing!) is gone — that vendor and its cap left the
    // pipeline at v25. One branded failure card, refund-aware, support CTA.
    const errorText = renderJob.error || "";
    const mentionsRefund = /refund/i.test(errorText);
    return (
      <div className="bg-surface border border-red-500/30 rounded-xl p-5 fade-up-in">
        <div className="flex items-start gap-3">
          <div className="grid place-items-center w-9 h-9 rounded-full bg-red-500/15 text-red-300 flex-shrink-0">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 8v4m0 4h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-red-200">This render didn't make it</h3>
            <p className="text-xs text-ink-soft mt-1.5 leading-relaxed">
              {errorText || "Something went wrong on our side. Try again — most hiccups are one-off."}
            </p>
            <p className="text-xs text-ink-muted mt-2 leading-relaxed">
              {mentionsRefund
                ? "Your credit is being returned automatically."
                : "If this repeats, a different photo set order or removing an unusual photo often clears it — or email "}
              {!mentionsRefund && (
                <a href="mailto:support@vistalia.ai" className="text-gold underline">support@vistalia.ai</a>
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <ActiveRenderPanel />;
}

/* ============================================================
   Active render panel — the in-progress visual.
   ============================================================
   This is the conversion-critical surface: agents decide whether to keep
   paying based on how this minute-or-two FEELS. Two design constraints:
     1. The bar must NEVER jump. We use requestAnimationFrame + a damped
        lerp toward a target, then mutate the DOM directly with refs so
        React isn't fighting the animation. 60fps continuous, never chunky.
     2. The copy must feel narrative, not technical. "Rendering scene 12
        of 24 — Kitchen" not "Render scenes 47%". Confident typography,
        big percentage, deliberate phase transitions.
*/
function ActiveRenderPanel() {
  const renderJob = useStore((s) => s.renderJob);

  // DOM refs — animation loop writes to these directly to avoid React
  // re-renders on every frame.
  const percentRef = useRef<HTMLSpanElement>(null);

  // Animation state lives in refs (not state) so updates don't trigger re-renders.
  // - target: where we WANT the bar to be (advances via creep + real updates)
  // - displayed: where the bar IS right now (smoothly lerps toward target)
  const targetRef = useRef<number>(2);
  const displayedRef = useRef<number>(2);
  const lastFrameMsRef = useRef<number>(0);
  const startedAtRef = useRef<number>(Date.now());

  // Phase title and ETA need to render reactively — those don't update at
  // 60fps, only when the job changes phase. Use plain state.
  const friendlyPhase = enrichPhase(renderJob);

  // When real progress arrives from the worker, advance our target to it.
  useEffect(() => {
    if (!renderJob) return;
    targetRef.current = Math.max(targetRef.current, renderJob.progress || 0);
  }, [renderJob?.progress]);

  // The animation loop. Runs at native frame rate (60 / 120Hz). Each tick:
  //   1. If active, advance target by a creep rate (per second, time-based
  //      so framerate independent), capped slightly above real progress.
  //   2. Lerp displayed toward target with a damped factor.
  //   3. Mutate DOM directly — bar width via scaleX (hardware-accelerated
  //      transform), percentage label via textContent.
  useEffect(() => {
    if (!renderJob) return;
    let raf = 0;
    lastFrameMsRef.current = performance.now();

    const tick = (now: number) => {
      const dtSec = Math.min(0.06, (now - lastFrameMsRef.current) / 1000);
      lastFrameMsRef.current = now;

      const job = useStore.getState().renderJob;
      if (!job) return;
      const isActive = job.status === "queued" || job.status === "rendering";
      const realProgress = job.progress || 0;

      // 1. Time-based creep (only while active and below ceiling). Slower
      //    at higher progress so we never overshoot real by more than ~3-4%.
      if (isActive && targetRef.current < 99) {
        const ceiling = Math.min(99, realProgress + 3.5);
        if (targetRef.current < ceiling) {
          const t = targetRef.current;
          // Creep rate per second: aggressive early, gentle late.
          const creepPerSec = t < 25 ? 1.4 : t < 60 ? 0.85 : t < 88 ? 0.45 : 0.2;
          targetRef.current = Math.min(ceiling, t + creepPerSec * dtSec);
        }
      } else if (!isActive) {
        // Render finished — race displayed up to 100 quickly.
        targetRef.current = Math.max(targetRef.current, 100);
      }

      // 2. Damped lerp displayed → target.
      // Use exponential damping: fraction = 1 - exp(-rate * dt). Frame-rate
      // independent and gives a natural "weighted" feel.
      const damping = 5.5; // higher = snappier
      const alpha = 1 - Math.exp(-damping * dtSec);
      const diff = targetRef.current - displayedRef.current;
      displayedRef.current += diff * alpha;
      // Snap when essentially there
      if (Math.abs(diff) < 0.05) displayedRef.current = targetRef.current;

      // 3. Write to DOM directly.
      const display = Math.max(2, Math.min(100, displayedRef.current));
      if (percentRef.current) {
        percentRef.current.textContent = String(Math.round(display));
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [renderJob?.status]);

  if (!renderJob) return null;

  const isRunway = isAiVideoEngine(renderJob.engine);
  // v26.11: label off the canonical helper (veo → "Cinematic AI") instead of a
  // stale `=== "runway"` check that mislabeled every Veo render as "Quick Reel".
  // Duration reflects the user's actual 30s/60s choice, not a hardcoded ~90s.
  const engineLabel = engineDisplayLabel(renderJob.engine);
  const targetSec = useStore.getState().targetDurationSec || 30;
  const engineSubLabel = `${isRunway ? "Cinematic motion" : "Photo Motion"} · 1080p · ~${targetSec}s`;

  // ETA — keep it stable. Recompute once a second, not on every frame.
  // Read displayed via ref so it doesn't trigger re-renders.
  const eta = useStableEta({ startedAt: startedAtRef.current, isRunway });

  return (
    <div className="render-panel relative overflow-hidden bg-surface border border-edge rounded-2xl px-6 py-7 sm:px-8 sm:py-8 fade-up-in">
      {/* Soft gradient backdrop for depth */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none opacity-60"
        style={{
          background: "radial-gradient(circle at 0% 0%, rgba(199,167,108,0.08), transparent 55%)"
        }}
      />

      <div className="relative flex flex-col gap-7">
        {/* Eyebrow */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="relative flex w-2 h-2">
              <span className="absolute inset-0 rounded-full bg-gold animate-ping opacity-50" />
              <span className="relative w-2 h-2 rounded-full bg-gold" />
            </span>
            <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-gold-light font-semibold">
              {engineLabel} · Rendering
            </span>
          </div>
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-ink-muted">
            {engineSubLabel}
          </span>
        </div>

        {/* Hero row: big percentage + phase title.
            v26: role=status + aria-live so screen readers hear phase
            transitions ("Directing your tour" → "Rendering scenes" → …)
            without having to re-scan the page. polite, not assertive —
            these fire every few seconds and must not interrupt. */}
        <div className="flex items-end justify-between gap-6" role="status" aria-live="polite">
          <div className="flex-1 min-w-0">
            <div className="font-display text-2xl sm:text-3xl font-semibold tracking-tighter2 text-ink leading-tight">
              {friendlyPhase.title}
            </div>
            {friendlyPhase.detail && (
              <div className="text-sm text-ink-muted mt-2 leading-relaxed">
                {friendlyPhase.detail}
              </div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="flex items-baseline gap-1 justify-end">
              <span
                ref={percentRef}
                className="font-display text-5xl sm:text-6xl font-semibold tracking-tighter2 text-gold leading-none tabular-nums"
                style={{ fontFeatureSettings: "'tnum'" }}
              >
                2
              </span>
              <span className="font-display text-2xl sm:text-3xl font-semibold text-gold-dim leading-none">%</span>
            </div>
            {eta && (
              <div className="text-[11px] text-ink-muted mt-2 font-mono uppercase tracking-wider">
                {eta}
              </div>
            )}
          </div>
        </div>

        {/* (Progress bar removed 7/8 per Troy — the animated percentage and
            phase title carry the status; the card stays clean.) */}
      </div>
    </div>
  );
}

// Map raw worker-phase strings to confident, narrative-style copy. The
// worker says "Rendering scene 9/24" — we display "Composing scene 9 of 24"
// with a subtitle that tells the user what's actually happening.
function enrichPhase(renderJob: { phase?: string; engine?: string; progress?: number } | null): { title: string; detail: string } {
  if (!renderJob) return { title: "Preparing", detail: "" };
  const raw = String(renderJob.phase || "").toLowerCase();
  const isRunway = isAiVideoEngine(renderJob.engine);

  if (raw.includes("direct") || raw.includes("tour")) {
    return {
      title: "Directing your cinematic tour",
      detail: "Our Motion Director is reviewing every photo and choreographing the cuts."
    };
  }
  if (raw.includes("send") && raw.includes("renderer")) {
    return {
      title: "Sending the cut to the renderer",
      detail: "Handing the storyboard to our render fleet."
    };
  }
  if (raw.includes("queued")) {
    return {
      title: "Queued at the front of the render fleet",
      detail: "Your job is up next — should start any second."
    };
  }
  if (raw.includes("submit") && raw.includes("clip")) {
    return {
      title: "Composing AI motion for every photo",
      detail: "Generating cinematic camera moves for each scene in parallel."
    };
  }
  // "Rendering scene N/M"
  const sceneMatch = raw.match(/scene\s*(\d+)\s*\/\s*(\d+)/);
  if (sceneMatch) {
    const [, n, total] = sceneMatch;
    return {
      title: `Composing scene ${n} of ${total}`,
      detail: isRunway
        ? "Each scene is its own AI-generated cinematic clip — this is the slowest step."
        : "Smoothing camera moves and pacing the cuts."
    };
  }
  if (raw.includes("stitch")) {
    return {
      title: "Stitching the master cut",
      detail: "Joining every scene into one continuous film with seamless transitions."
    };
  }
  if (raw.includes("voice") || raw.includes("narration") || raw.includes("synthes")) {
    return {
      title: "Adding voice narration",
      detail: "Synthesizing your narration script and ducking the music underneath."
    };
  }
  // v24+: aspect-variant + social-shorts steps removed (single 9:16
  // master per render). Phases below cover only the steps the worker
  // actually runs today.
  if (raw.includes("variant") || raw.includes("aspect") || raw.includes("finaliz")) {
    return {
      title: "Finalizing your formats",
      detail: "Packaging the 9:16 vertical and a true 1:1 square at 1080p."
    };
  }
  if (raw.includes("upload")) {
    return {
      title: "Uploading your video",
      detail: "Transferring the master MP4 to permanent storage."
    };
  }
  if (raw.includes("ready")) {
    return { title: "Ready for download", detail: "" };
  }
  // v45 launch sweep: the v43 final sweep re-verifies every scene on the
  // assembled master — that's the moat, so say it proudly instead of the
  // old generic "final touches".
  if (raw.includes("inspect") || raw.includes("verif")) {
    return {
      title: "Verifying every scene",
      detail: "A vision model is comparing each scene against your original photos before delivery."
    };
  }
  if (raw.includes("final")) {
    return { title: "Final touches", detail: "Color correction and audio normalization." };
  }
  // Fallback — use the raw phase but capitalize nicely
  const fallback = renderJob.phase || "Rendering your video";
  return {
    title: fallback.charAt(0).toUpperCase() + fallback.slice(1),
    detail: isRunway
      ? "Most cinematic renders finish in about ten minutes — every scene is generated, inspected, and stitched before delivery."
      : "Photo Motion typically completes in under 90 seconds."
  };
}

// Stable ETA — only recomputes once a second, never per-frame, so the label
// doesn't flicker. Driven by the rAF-mutated displayedRef indirectly via a
// time interval that reads from the store.
function useStableEta({ startedAt, isRunway }: { startedAt: number; isRunway: boolean }): string {
  const [label, setLabel] = useState("");
  useEffect(() => {
    // v45 launch sweep: with the v43 final sweep + QC retries in the path,
    // real renders land at 9-13 minutes (m-lux: 13.3 with two floors; m31:
    // 9.5). The old 400/520s estimates made the ETA read "1 min left" for
    // the last five minutes — worse than no ETA.
    const totalEstimateSec = isRunway
      ? (useStore.getState().includeSquare ? 780 : 620)
      : 75;
    const interval = window.setInterval(() => {
      const job = useStore.getState().renderJob;
      if (!job) { setLabel(""); return; }
      const real = job.progress || 0;
      if (real < 12 || real >= 96 || job.status === "completed" || job.status === "failed") {
        setLabel("");
        return;
      }
      const elapsed = (Date.now() - startedAt) / 1000;
      const fraction = real / 100;
      const projected = elapsed / Math.max(0.05, fraction);
      const remaining = Math.max(8, projected - elapsed);
      const capped = Math.min(remaining, totalEstimateSec * 1.5);
      const next = capped < 60
        ? `${Math.round(capped)}s left`
        : `${Math.round(capped / 60)} min left`;
      setLabel(next);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt, isRunway]);
  return label;
}

// (PhaseChips pipeline-stage pill strip removed 7/7 per Troy — the stage
// names were internal jargon and the progress bar + phase text already
// carry the status story.)
