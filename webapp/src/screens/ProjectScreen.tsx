import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { useStore } from "../lib/store";
import { uploadListingPhoto, photoFromUpload, readImageDimensions, uploadAgentHeadshot, uploadBrokerageLogo } from "../lib/supabase";
import { createEditPlan, submitRender, pollRender, lookupProperty, fetchLibrary, fetchUsage, RenderJobMissingError, type RenderManifest } from "../lib/api";
import { events, track } from "../lib/analytics";
import type { Photo, RenderEngine, StyleId } from "../lib/types";
import { cn } from "../lib/cn";
import { resolveTrack } from "../lib/music-catalog";
import { isAiVideoEngine } from "../lib/engine-labels";
import MusicSelector from "../components/MusicSelector";

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
          className="bg-transparent border-0 outline-none text-3xl sm:text-4xl font-semibold tracking-tighter2 text-ink placeholder:text-ink-dim w-full"
        />
        <p className="text-sm text-ink-muted leading-relaxed">
          Tell us about the listing, drop in your photos, pick a style — Quick Reel finishes in 90 seconds, Cinematic AI in 3–5 minutes.
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

      {/* Render — one canonical pipeline. Pick the engine, pick the
          hallucination-protection level, click Generate. Everything else
          (narration, music, brand kit, output formats) is automatic and
          tier-determined. */}
      <Section title="Render" subtitle="Pick your engine, pick a length, hit Generate.">
        <div className="flex flex-col gap-5">
          <EngineToggle engine={renderEngine} onChange={setEngine} />
          <LengthToggle value={targetDurationSec} onChange={setTargetDuration} />
          <RenderQualityPanel />
          <RenderSafetyControl />
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

/* v23.1: Render Quality Panel — single source of truth for which AI engine
   and resolution this render will use. Tier-aware:

     - Cinematic AI 4K ($299): Gen-4.5 + 4K (with togglable 4K)
     - Cinematic AI ($149):    Gen-4 Turbo + 1080p (locked)
     - Quick Reel ($79):       Ken Burns motion + 1080p (locked)
     - Trial:                  Same as Quick Reel + clear upgrade CTA

   Replaces the implicit-config approach where users had no idea which
   model their render was using. Now everyone sees explicitly what they
   get for their tier, and 4K-tier subscribers get a single toggle to
   downgrade resolution for faster preview renders.
*/
function RenderQualityPanel() {
  const renderEngine = useStore((s) => s.renderEngine);
  const [tier, setTier] = useState<string>("trial");
  const [tierLoading, setTierLoading] = useState(true);

  // Fetch the user's tier on mount. Cached for the panel's lifetime —
  // the tier only changes via Stripe checkout which navigates away.
  useEffect(() => {
    let alive = true;
    fetchUsage()
      .then((u) => { if (alive && u?.tier) setTier(String(u.tier)); })
      .catch(() => { /* keep default 'trial' */ })
      .finally(() => { if (alive) setTierLoading(false); });
    return () => { alive = false; };
  }, []);

  if (tierLoading) {
    return (
      <div className="rounded-xl border border-edge-soft bg-surface-input p-4 animate-pulse">
        <div className="h-4 w-32 bg-edge rounded mb-2" />
        <div className="h-3 w-48 bg-edge rounded" />
      </div>
    );
  }

  // Resolve what THIS render will actually use — mirrors the worker's
  // resolveRunwayModel() logic so the user can trust what they see.
  const isQuickReel = renderEngine === "remotion";
  const is4KTier = tier === "cinematic_4k";
  const isCinematicTier = tier === "cinematic_ai" || tier === "cinematic_4k";

  const engineLabel = isQuickReel
    ? "Ken Burns motion (Quick Reel)"
    : is4KTier
      ? "Runway Gen-4.5"
      : "Runway Gen-4 Turbo";

  const engineSublabel = isQuickReel
    ? "Cinematic camera moves applied to your photos. Fastest, no AI hallucinations."
    : is4KTier
      ? "Premium image-to-video model — best architectural fidelity in the industry."
      : "Image-to-video AI. Strong, fast, with content-aware safety guards.";

  // v23.2: 4K is currently disabled across all tiers because Gen-4.5 + 4K
  // crashed the worker every time. Returns when we provision a larger
  // worker class. Resolution row is now informational, not interactive.
  const resolutionLabel = "1080p HD";

  return (
    <div className="rounded-xl border border-edge bg-surface p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-sm font-semibold tracking-tightish">Render quality</div>
          <div className="text-xs text-ink-muted mt-0.5">
            What this render will actually use, based on your plan.
          </div>
        </div>
        <span className={cn(
          "text-[9px] font-bold tracking-widest px-2 py-0.5 rounded uppercase",
          is4KTier
            ? "bg-gold text-paper"
            : isCinematicTier
              ? "bg-gold/20 text-gold-light border border-gold/40"
              : "bg-surface-input text-ink-muted border border-edge"
        )}>
          {is4KTier ? "Cinematic 4K" : isCinematicTier ? "Cinematic AI" : tier === "quick_reel" ? "Quick Reel" : "Trial"}
        </span>
      </div>

      {/* AI engine row */}
      <div className="rounded-lg border border-edge-soft bg-surface-input p-3 flex items-start gap-3">
        <div className="text-lg" aria-hidden>{isQuickReel ? "🎞️" : "✨"}</div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-widest text-ink-dim font-mono mb-1">
            AI Engine
          </div>
          <div className="text-sm font-semibold tracking-tightish flex items-center gap-2 flex-wrap">
            {engineLabel}
            {is4KTier && !isQuickReel && (
              <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-gold text-paper">
                PREMIUM
              </span>
            )}
          </div>
          <div className="text-xs text-ink-muted mt-1 leading-relaxed">{engineSublabel}</div>
        </div>
      </div>

      {/* Resolution row — informational only. 1080p across all tiers
          until larger worker can handle 4K + Gen-4.5. */}
      <div className="rounded-lg border border-edge-soft bg-surface-input p-3 flex items-start gap-3">
        <div className="text-lg" aria-hidden>🖥️</div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-widest text-ink-dim font-mono mb-1">
            Output resolution
          </div>
          <div className="text-sm font-semibold tracking-tightish">
            {resolutionLabel}
          </div>
          <div className="text-xs text-ink-muted mt-1 leading-relaxed">
            Vertical 9:16 + square 1:1 + wide 16:9 from one render.
          </div>
        </div>
      </div>
    </div>
  );
}

/* TwilightToggle removed — Day-to-Dusk diffusion produced unpredictable
   results on real listings without justifying the per-render cost.
   Will return as a backend-only premium add-on once we have data. */

/* v23.2 REMOVED: CrossfadeToggle. Was an OOM trap that crashed renders on
   anything below Render Pro 4GB, and even there it added 3-5 minutes for
   marginal visual benefit. Hard cuts between scenes are cleaner and
   reliably ship. The store still exposes crossfadesEnabled for backwards
   compat, but the worker now hard-forces it false regardless of manifest
   value (see runway-job.mjs / stitch). */

/* Render Safety — the only hallucination-protection control the user sees.
   Replaces what used to be three overlapping toggles (Compliance Mode,
   Protect High-Risk Rooms, and Hallucination Guard) with one three-way
   segmented picker. The manifest builder maps the chosen level to the
   worker's legacy fields so the rendering pipeline doesn't change. */
function RenderSafetyControl() {
  const level = useStore((s) => s.renderSafety);
  const setLevel = useStore((s) => s.setRenderSafety);

  const options: Array<{
    id: "off" | "smart" | "max";
    label: string;
    badge?: string;
    description: string;
  }> = [
    {
      id: "off",
      label: "Full AI",
      description:
        "Cinematic AI motion on every scene. Highest impact, but kitchens and appliance-heavy rooms can hallucinate (split counters, phantom fans). Use when flair beats faithfulness."
    },
    {
      id: "smart",
      label: "Smart",
      badge: "RECOMMENDED",
      description:
        "AI motion on safe rooms, Ken Burns photo motion on risky ones (kitchens, bathrooms, anywhere with appliances or parallel surfaces). Best balance for almost every listing."
    },
    {
      id: "max",
      label: "MLS-Safe",
      description:
        "Ken Burns photo motion on every scene. Zero AI hallucination, no Runway credits used, faster renders. The right choice for MLS-required compliance."
    }
  ];

  const active = options.find((o) => o.id === level) ?? options[1];

  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl bg-surface border border-edge">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold tracking-tightish">Render safety</div>
        <span className="text-[10px] uppercase tracking-widest text-ink-soft font-mono">
          Hallucination control
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-surface-input border border-edge">
        {options.map((opt) => {
          const isActive = opt.id === level;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setLevel(opt.id)}
              className={cn(
                "card-press relative px-3 py-2 rounded text-xs font-semibold tracking-tightish transition-colors",
                isActive
                  ? "bg-gold text-paper shadow-sm"
                  : "text-ink-muted hover:text-ink"
              )}
            >
              {opt.label}
              {isActive && opt.badge && (
                <span className="absolute -top-1.5 -right-1 text-[8px] font-bold tracking-widest px-1 py-0.5 rounded bg-paper text-gold border border-gold">
                  {opt.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-ink-muted leading-relaxed">{active.description}</p>
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
    if (!file.type.startsWith("image/")) {
      setError("Headshot must be an image (JPG, PNG, or WebP).");
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
    <div className="bg-surface border border-edge rounded-xl p-5 sm:p-6 flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-5 items-start">
        {/* Headshot uploader */}
        <div className="flex flex-col items-center gap-2">
          <label
            className={cn(
              "card-press relative w-28 h-28 rounded-full overflow-hidden border-2 border-dashed cursor-pointer grid place-items-center bg-surface-input transition-colors",
              uploading
                ? "border-gold"
                : branding.headshotUrl
                ? "border-edge-strong hover:border-gold"
                : "border-edge-strong hover:border-gold hover:bg-gold/5"
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
              <img
                src={branding.headshotUrl}
                alt="Agent headshot"
                className="w-full h-full object-cover"
              />
            ) : uploading ? (
              <span className="spinner" />
            ) : (
              <div className="text-[10px] text-ink-muted text-center px-2 leading-tight">
                Add<br />headshot
              </div>
            )}
          </label>
          {branding.headshotUrl && (
            <button
              type="button"
              onClick={() => setBranding({ headshotUrl: "" })}
              className="text-[11px] text-ink-muted hover:text-red-300 transition-colors"
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
              placeholder="EstateMotion Realty"
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
                "card-press relative w-32 h-20 rounded-lg overflow-hidden border-2 border-dashed cursor-pointer grid place-items-center bg-surface-input transition-colors",
                uploadingLogo
                  ? "border-gold"
                  : branding.brokerageLogoUrl
                  ? "border-edge-strong hover:border-gold"
                  : "border-edge-strong hover:border-gold hover:bg-gold/5"
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
                <img
                  src={branding.brokerageLogoUrl}
                  alt="Brokerage logo"
                  className="max-w-[90%] max-h-[80%] object-contain"
                />
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

      {/* Voice clone — the differentiator. Reel-e.ai ships silent reels.
          EstateMotion narrates every video in the agent's actual voice. */}
      <div className="pt-5 border-t border-edge-soft">
        <VoiceCloneCard />
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

function VoiceCloneCard() {
  const branding = useStore((s) => s.branding);
  const setBranding = useStore((s) => s.setBranding);
  const setError = useStore((s) => s.setError);
  const setToast = useStore((s) => s.setToast);

  // Mode state — drives which UI we show.
  const initialMode: VoiceMode = branding.voiceId ? "cloned" : "idle";
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

    const tick = () => {
      analyser.getByteFrequencyData(dataArray);
      // Sample 32 evenly-spaced bins from the FFT for our 32 bars.
      for (let i = 0; i < 32; i++) {
        const binIndex = Math.floor((i / 32) * dataArray.length);
        const value = dataArray[binIndex] / 255;
        // Apply a slight curve so quiet sounds still register.
        const scaled = Math.max(0.06, Math.pow(value, 0.7));
        const bar = barRefs.current[i];
        if (bar) bar.style.transform = `scaleY(${scaled})`;
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          fileName: `${branding.fullName.split(/\s+/)[0] || "agent"}-voice.${ext}`,
          contentType: recordedBlob.type || "audio/webm",
          voiceLabel: branding.fullName.split(/\s+/)[0] || branding.fullName
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `Voice clone failed (${res.status}).`);
      setBranding({
        voiceId: payload.voiceId,
        voiceLabel: payload.voiceLabel || branding.fullName.split(/\s+/)[0] || ""
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
        headers: { "Content-Type": "application/json" },
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
        voiceLabel: payload.voiceLabel || branding.fullName.split(/\s+/)[0] || ""
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
    if (!branding.voiceId) return;
    setPreviewLoading(true);
    try {
      const text = `Hi, I'm ${branding.voiceLabel || branding.fullName.split(/\s+/)[0] || "your agent"}. This is how I'll sound on every EstateMotion video.`;
      const res = await fetch("/api/synthesize-narration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId: branding.voiceId, text })
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
    setBranding({ voiceId: "", voiceLabel: "" });
    setMode("idle");
    setToast("Voice clone removed");
  };

  /* -----------------------------------------------------------------
     RENDER
     ----------------------------------------------------------------- */
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const maxLabel = `${Math.floor(MAX_DURATION_SEC / 60)}:${String(MAX_DURATION_SEC % 60).padStart(2, "0")}`;

  // Cloned state — clean, confident "ready" card
  if (mode === "cloned" && branding.voiceId) {
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
            ElevenLabs is fingerprinting your speech. About 30 seconds. Don't refresh.
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
      const res = await fetch("/api/clone-voice?diagnose=1");
      const payload = await res.json().catch(() => ({}));
      if (payload.ok && payload.canCloneVoice) {
        setToast(`✓ Connected to ElevenLabs (${payload.tierDisplay}). Voice cloning is available.`);
      } else if (payload.ok && !payload.canCloneVoice) {
        setError(`Connected to ElevenLabs (${payload.tierDisplay}) — but voice cloning is NOT included on your plan. Upgrade to Creator ($22/mo) or higher at elevenlabs.io.`);
      } else {
        setError(payload.message || "Could not reach ElevenLabs. Check ELEVENLABS_API_KEY in Vercel env vars.");
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
        title="Quick Reel"
        description="Smooth Ken Burns camera motion on your photos. Fast, reliable, zero AI artifacts. Best for any listing — always works."
        meta="~90 seconds • every plan"
        onClick={() => onChange("remotion")}
      />
      <EngineCard
        active={engine === "runway"}
        title="Cinematic AI"
        proTag
        description="Real AI camera motion via Runway Gen-4 Turbo. Kitchens + bathrooms auto-fall back to camera motion to avoid AI artifacts. Best for hero exteriors and living spaces."
        meta="2–4 minutes • Cinematic AI plan"
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
  const musicEnabled = useStore((s) => s.musicEnabled);
  const setMusicEnabled = useStore((s) => s.setMusicEnabled);
  const musicVolume = useStore((s) => s.musicVolume);
  const setMusicVolume = useStore((s) => s.setMusicVolume);

  const volumePct = Math.round(musicVolume * 100);

  return (
    <div className="flex flex-col gap-4">
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
function LengthToggle({ value, onChange }: { value: 30 | 60; onChange: (v: 30 | 60) => void }) {
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
          onClick={() => onChange(60)}
          className={cn(
            "card-press text-left p-3 rounded-lg bg-surface border",
            value === 60
              ? "border-gold bg-surface-raised card-selected"
              : "border-edge hover:border-edge-strong"
          )}
        >
          <div className="text-sm font-semibold tracking-tightish mb-0.5">60 seconds</div>
          <div className="text-xs text-ink-muted">Longer tour · Zillow · listing site</div>
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
  const setError = useStore((s) => s.setError);
  const setLoading = useStore((s) => s.setLoading);
  const setEditPlan = useStore((s) => s.setEditPlan);
  const setToast = useStore((s) => s.setToast);

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
      engine: renderEngine
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
      const styleLabel = STYLES.find((s) => s.id === selectedStyleId)?.engineLabel || "Cinematic Luxury";
      const planResult = await createEditPlan({
        photos,
        listing,
        selectedStyle: styleLabel,
        exportFormat: "vertical",
        engine: renderEngine,
        brandKit: branding,
        targetDurationSec
      });
      if (!planResult.editPlan) {
        throw new Error(planResult.reason || "We couldn't draft an edit plan. Try again in a moment.");
      }
      setEditPlan(planResult.editPlan);

      // 2. Build manifest
      phaseCreep.update({ phase: "Sending the cut to the renderer", progressFloor: 10, ceilingProgress: 14 });
      const manifest: RenderManifest = {
        app: "EstateMotion",
        engine: renderEngine,
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
        // Translate the single "Render safety" picker into the worker's
        // existing fields. Worker code is unchanged; only the UI consolidated.
        //   off   → pure AI (no protection)
        //   smart → balanced Hallucination Guard (default)
        //   max   → Compliance Mode (every scene Ken Burns)
        complianceMode: renderSafety === "max",
        protectHighRiskRooms: renderSafety === "smart",
        hallucinationGuard:
          renderSafety === "off" ? "off" :
          renderSafety === "max" ? "strict" :
          "balanced"
      };

      // 3. Submit
      const submitted = await submitRender(manifest);
      if (submitted.upgradeRequired) {
        phaseCreep.stop();
        setRenderJob(null); // clear the panel — error message takes over
        setError(submitted.error || "Cinematic AI needs the $149 plan or higher. Upgrade to unlock real AI motion.");
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
      setToast(renderEngine === "runway"
        ? "Cinematic AI render started — this takes 3 to 5 minutes."
        : "Quick Reel render started — under 90 seconds.");

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

  const pollUntilDone = async (jobId: string) => {
    const startTime = Date.now();
    const maxMs = 18 * 60 * 1000; // matches worker's overall job timeout
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
          phase: safePhase
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

        // Stuck detection — fire ONCE when threshold first crossed.
        const stuckMs = Date.now() - lastProgressMovedAt;
        if (!stuckFlagged && stuckMs > STUCK_THRESHOLD_MS) {
          stuckFlagged = true;
          const stuckSec = Math.round(stuckMs / 1000);
          setError(
            `Render appears stuck at ${Math.round(safeProgress)}% (no progress for ${stuckSec}s). The worker may have crashed or hit a slow step. Check Render.com logs, or hit Generate again to retry.`
          );
          // Don't return — keep polling. If the worker recovers we'll
          // clear the error on the next progress update.
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
        if (consecutiveErrors >= maxConsecutiveErrors) {
          const msg = err instanceof Error ? err.message : "Status check failed.";
          setError(`Lost contact with the render worker: ${msg}`);
          return;
        }
      }
    }
    setError("Render exceeded the 18-minute hard timeout. The worker may have crashed silently — check Render.com logs.");
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
    </div>
  );
}

/* ============================================================
   Render status panel — progress while rendering, video when done
   ============================================================ */
function RenderStatusPanel() {
  const renderJob = useStore((s) => s.renderJob);
  if (!renderJob) return null;

  // Render completed but no master MP4 URL — almost always a Supabase
  // Storage size-limit rejection. Show actionable error rather than
  // leaving the user staring at "in progress."
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
            <h3 className="text-sm font-semibold text-amber-400">Render finished, but upload was rejected</h3>
            <p className="text-xs text-ink-soft mt-1.5 leading-relaxed">
              Your video rendered successfully, but Supabase Storage rejected the master MP4 — usually because the bucket's file-size limit is too small. A 2-minute video is typically 80–150MB.
            </p>
            <div className="mt-3 p-3 bg-surface-input rounded-lg border border-edge text-xs leading-relaxed">
              <strong className="text-ink">To fix it:</strong>
              <ol className="text-ink-muted mt-2 ml-4 list-decimal space-y-1">
                <li>Open Supabase dashboard → Storage → click <code className="text-gold font-mono">generated-videos</code> bucket</li>
                <li>Click "Configuration" or the gear icon</li>
                <li>Bump <strong>File Size Limit</strong> to <strong>500MB</strong> (or 1GB for headroom)</li>
                <li>Save, then hit Generate again</li>
              </ol>
            </div>
            {renderJob.thumbnailUrl && (
              <div className="mt-3 text-xs text-ink-muted">
                The thumbnail and short clips uploaded fine — only the main MP4 was over the limit.
              </div>
            )}
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
      <div className="bg-surface border border-gold/40 rounded-xl p-4 flex flex-col gap-5">
        <video
          src={verticalUrl}
          controls
          playsInline
          poster={renderJob.thumbnailUrl}
          className="w-full max-h-[600px] rounded-lg bg-black"
        />

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
                download
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
    // Detect Runway daily-cap errors from the worker so we can show a
    // proper upgrade card instead of a scary red error box. The worker
    // surfaces this with the literal phrase "daily render cap".
    const errorText = renderJob.error || "";
    const isRunwayDailyCap = /daily render cap|daily.*(task|limit|cap|quota)|429/i.test(errorText) && /runway|cinematic ai/i.test(errorText);

    if (isRunwayDailyCap) {
      return (
        <div className="bg-surface border border-gold/40 rounded-xl p-5 fade-up-in">
          <div className="flex items-start gap-3">
            <div className="grid place-items-center w-9 h-9 rounded-full bg-gold/15 text-gold flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 8v4m0 4h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-gold-light">Cinematic AI is at its daily cap</h3>
              <p className="text-xs text-ink-soft mt-1 leading-relaxed">
                Your Runway plan ran out of tasks for today. Upgrade to Runway Unlimited
                ($95/mo) to remove the daily cap and run uncapped renders. Or wait until
                tomorrow — Runway's daily limit resets at midnight UTC.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <a
                  href="https://runwayml.com/pricing"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary-em h-9 px-4 rounded-lg text-xs inline-flex items-center"
                >
                  Upgrade Runway →
                </a>
                <button
                  type="button"
                  onClick={() => useStore.getState().setEngine("remotion")}
                  className="btn-secondary-em h-9 px-4 rounded-lg text-xs"
                >
                  Switch to Quick Reel
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="bg-surface border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
        <strong className="text-red-200">Render failed.</strong>{" "}
        {errorText || "Try again or contact support."}
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
  const barFillRef = useRef<HTMLDivElement>(null);
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
      if (barFillRef.current) {
        barFillRef.current.style.transform = `scaleX(${display / 100})`;
      }
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
  const isDepth = String(renderJob.engine || "").toLowerCase() === "depth";
  const engineLabel = isDepth ? "Cinematic Depth" : (renderJob.engine === "runway" ? "Cinematic AI" : "Quick Reel");
  const engineSubLabel = isDepth
    ? "Depth parallax · ~3 min"
    : renderJob.engine === "runway"
      ? "Runway · 4K · ~3 min"
      : "Cinematic motion · ~90 sec";

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

        {/* Hero row: big percentage + phase title */}
        <div className="flex items-end justify-between gap-6">
          <div className="flex-1 min-w-0">
            <div className="text-2xl sm:text-3xl font-semibold tracking-tighter2 text-ink leading-tight">
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
                className="text-5xl sm:text-6xl font-bold tracking-tighter2 text-gold leading-none tabular-nums"
                style={{ fontFeatureSettings: "'tnum'" }}
              >
                2
              </span>
              <span className="text-2xl sm:text-3xl font-semibold text-gold-dim leading-none">%</span>
            </div>
            {eta && (
              <div className="text-[11px] text-ink-muted mt-2 font-mono uppercase tracking-wider">
                {eta}
              </div>
            )}
          </div>
        </div>

        {/* The bar — DOM mutation drives it, never re-renders. */}
        <div className="relative">
          <div className="h-1.5 bg-edge rounded-full overflow-hidden">
            <div
              ref={barFillRef}
              className="h-full origin-left"
              style={{
                transform: "scaleX(0.02)",
                background: "linear-gradient(90deg, #8B6F3D 0%, #C7A76C 50%, #E0C896 100%)",
                boxShadow: "0 0 12px rgba(199,167,108,0.35)",
                willChange: "transform"
              }}
            />
          </div>
          {/* Continuous shimmer overlay — sits on top of the bar */}
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 right-0 overflow-hidden pointer-events-none rounded-full"
          >
            <div
              className="absolute inset-y-0 w-32 -left-32"
              style={{
                background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent)",
                animation: "render-shimmer 2.4s linear infinite",
                mixBlendMode: "overlay"
              }}
            />
          </div>
        </div>

        {/* Pipeline stages — confidence signal that this is a multi-step process */}
        <PhaseChips renderJob={renderJob} barFillRef={barFillRef} />
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
  if (raw.includes("variant") || raw.includes("aspect")) {
    return {
      title: "Preparing every aspect ratio",
      detail: "Deriving 1:1 and 16:9 versions from the master so you can post anywhere."
    };
  }
  if (raw.includes("short") || raw.includes("cutting")) {
    return {
      title: "Cutting your hero shorts",
      detail: "Selecting your three best scenes for Reels, TikTok, and Shorts."
    };
  }
  if (raw.includes("upload")) {
    return {
      title: "Uploading your bundle",
      detail: "Transferring your full deliverable set to permanent storage."
    };
  }
  if (raw.includes("ready")) {
    return { title: "Ready for download", detail: "" };
  }
  if (raw.includes("final")) {
    return { title: "Final touches", detail: "Color correction and audio normalization." };
  }
  // Fallback — use the raw phase but capitalize nicely
  const fallback = renderJob.phase || "Rendering your video";
  return {
    title: fallback.charAt(0).toUpperCase() + fallback.slice(1),
    detail: isRunway
      ? "Cinematic AI typically completes in 3 to 5 minutes."
      : "Quick Reel typically completes in under 90 seconds."
  };
}

// Stable ETA — only recomputes once a second, never per-frame, so the label
// doesn't flicker. Driven by the rAF-mutated displayedRef indirectly via a
// time interval that reads from the store.
function useStableEta({ startedAt, isRunway }: { startedAt: number; isRunway: boolean }): string {
  const [label, setLabel] = useState("");
  useEffect(() => {
    const totalEstimateSec = isRunway ? 240 : 75;
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

function PhaseChips({ renderJob, barFillRef }: { renderJob: { engine?: string; progress?: number; status?: string }; barFillRef: RefObject<HTMLDivElement> }) {
  const isRunway = isAiVideoEngine(renderJob.engine);
  const stages = isRunway
    ? [
        { label: "Direct", endsAt: 14 },
        { label: "Compose AI motion", endsAt: 76 },
        { label: "Voice", endsAt: 84 },
        { label: "Bundle", endsAt: 94 },
        { label: "Upload", endsAt: 100 }
      ]
    : [
        { label: "Direct", endsAt: 14 },
        { label: "Render", endsAt: 78 },
        { label: "Voice", endsAt: 86 },
        { label: "Bundle", endsAt: 94 },
        { label: "Upload", endsAt: 100 }
      ];

  // The active chip should match what the BAR shows (which lerps), not the
  // raw progress (which can be jumpy). We poll barFillRef every 200ms.
  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => {
      let displayedPct = 0;
      const el = barFillRef.current;
      if (el) {
        // Read scaleX off the element to derive the current display percent.
        const transform = el.style.transform;
        const match = transform.match(/scaleX\(([\d.]+)\)/);
        displayedPct = match ? parseFloat(match[1]) * 100 : 0;
      }
      const idx = stages.findIndex((s) => displayedPct < s.endsAt);
      setActiveIdx(idx === -1 ? stages.length - 1 : idx);
    }, 200);
    return () => window.clearInterval(interval);
  }, [stages, barFillRef]);

  const isDone = renderJob.status === "completed";

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {stages.map((stage, idx) => {
        const stageDone = idx < activeIdx || isDone;
        const stageActive = idx === activeIdx && !isDone;
        return (
          <div
            key={stage.label}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium tracking-tight whitespace-nowrap border transition-all duration-300",
              stageDone
                ? "bg-gold/10 text-gold-light border-gold/25"
                : stageActive
                ? "bg-gold/15 text-gold border-gold/45 shadow-[0_0_12px_rgba(199,167,108,0.18)]"
                : "bg-surface-input text-ink-muted border-edge"
            )}
          >
            {stageDone ? (
              <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M2 6l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : stageActive ? (
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inset-0 rounded-full bg-gold animate-ping opacity-60" />
                <span className="relative w-1.5 h-1.5 rounded-full bg-gold" />
              </span>
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40" />
            )}
            {stage.label}
          </div>
        );
      })}
    </div>
  );
}
