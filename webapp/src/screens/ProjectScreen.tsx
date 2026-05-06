import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../lib/store";
import { uploadListingPhoto, photoFromUpload, readImageDimensions, uploadAgentHeadshot } from "../lib/supabase";
import { createEditPlan, submitRender, pollRender, lookupProperty, type RenderManifest } from "../lib/api";
import type { Photo, RenderEngine, StyleId } from "../lib/types";
import { cn } from "../lib/cn";

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
          Listing details, photos, and a style — render takes about three minutes.
        </p>
      </header>

      {error && (
        <div className="px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-300/70 hover:text-red-300 text-lg leading-none">×</button>
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

      {/* Agent brand kit — drives the outro card on every video */}
      <Section
        title="Your branding"
        subtitle="Appears on the closing card of every video. Saved between projects."
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

      {/* Render */}
      <Section title="Render" subtitle="Choose your speed, then generate the MP4.">
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
              <div className="text-sm font-medium">Drop your listing photos here</div>
              <div className="text-xs text-ink-muted">Or click to browse · JPG, PNG, or WebP · 8–25 photos</div>
            </>
          )}
        </div>
      </label>

      {photos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {photos.map((photo, idx) => (
            <div
              key={photo.id}
              className="card-press group relative aspect-[4/3] rounded-lg overflow-hidden bg-surface-input border border-edge hover:border-edge-strong"
            >
              <img src={photo.publicUrl} alt={photo.fileName} className="w-full h-full object-cover" />
              {/* Order pill */}
              <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-paper/80 backdrop-blur-sm text-[10px] font-mono font-semibold text-gold-light border border-edge">
                {String(idx + 1).padStart(2, "0")}
              </div>
              {/* Reorder + remove controls */}
              <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => movePhoto(photo.id, -1)}
                  disabled={idx === 0}
                  className="w-7 h-7 grid place-items-center rounded bg-paper/80 backdrop-blur-sm text-ink hover:text-gold text-xs disabled:opacity-30"
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => movePhoto(photo.id, 1)}
                  disabled={idx === photos.length - 1}
                  className="w-7 h-7 grid place-items-center rounded bg-paper/80 backdrop-blur-sm text-ink hover:text-gold text-xs disabled:opacity-30"
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
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
  const fileInput = useRef<HTMLInputElement>(null);
  const voiceFileInput = useRef<HTMLInputElement>(null);
  const [cloning, setCloning] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

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

  const handleVoiceSample = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setError("Voice sample must be an audio file (MP3, M4A, or WAV).");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("Voice sample must be under 8MB. Trim it to about 60–90 seconds.");
      return;
    }
    if (!branding.fullName.trim()) {
      setError("Add your full name first — it labels the cloned voice.");
      return;
    }
    setCloning(true);
    try {
      const audioBase64 = await fileToBase64(file);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Voice clone failed";
      setError(msg);
    } finally {
      setCloning(false);
      if (voiceFileInput.current) voiceFileInput.current.value = "";
    }
  };

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
    setToast("Voice clone removed");
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

      {/* Voice clone — the differentiator. Reel-e.ai gives silent reels.
          EstateMotion narrates every video in the agent's actual voice. */}
      <div className="pt-5 border-t border-edge-soft">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tightish flex items-center gap-2">
              Voice clone
              <span className="text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded bg-gold text-paper">PRO</span>
            </h3>
            <p className="text-xs text-ink-muted mt-0.5">
              Every video gets narrated in your voice. Record 60–90 seconds of clear speech, upload, done.
            </p>
          </div>
        </div>

        {branding.voiceId ? (
          <div className="flex flex-wrap items-center gap-3 p-3 bg-surface-input border border-gold/30 rounded-lg">
            <div className="grid place-items-center w-9 h-9 rounded-full bg-gold/15 text-gold">
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 2v6m0 8v6M5 12h14" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {branding.voiceLabel || "Your voice"} — ready
              </div>
              <div className="text-xs text-ink-muted">Used on every future render.</div>
            </div>
            <button
              type="button"
              onClick={previewVoice}
              disabled={previewLoading}
              className="btn-secondary-em h-9 px-3 rounded-lg text-xs disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {previewLoading ? <span className="spinner" /> : "▸"} Preview
            </button>
            <button
              type="button"
              onClick={removeVoice}
              className="text-xs text-ink-muted hover:text-red-300 transition-colors"
            >
              Remove
            </button>
          </div>
        ) : (
          <label
            className={cn(
              "block cursor-pointer rounded-lg border-[1.5px] border-dashed transition-colors p-4 text-center",
              cloning ? "border-gold bg-gold/5" : "border-edge-strong hover:border-gold hover:bg-gold/5"
            )}
          >
            <input
              ref={voiceFileInput}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => handleVoiceSample(e.target.files)}
              disabled={cloning}
            />
            <div className="flex items-center justify-center gap-3">
              <div className="grid place-items-center w-10 h-10 rounded-full bg-gold/10 text-gold">
                {cloning ? <span className="spinner" /> : (
                  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <rect x="9" y="3" width="6" height="12" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
                  </svg>
                )}
              </div>
              <div className="text-left">
                <div className="text-sm font-medium">
                  {cloning ? "Cloning your voice…" : "Upload a voice sample"}
                </div>
                <div className="text-xs text-ink-muted">
                  {cloning
                    ? "ElevenLabs is fingerprinting your speech. About 30 seconds."
                    : "MP3, M4A, or WAV. 60–90 seconds of clear speech in a quiet room."}
                </div>
              </div>
            </div>
          </label>
        )}
      </div>
    </div>
  );
}

// Helper — convert a File to base64 for the clone endpoint. We use FileReader
// instead of Blob.arrayBuffer() so we can show progress on slow connections
// later if needed.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      // result is "data:audio/mpeg;base64,XXXX" — strip the prefix
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
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
        description="Cinematic camera moves on your photos. Fast, reliable, zero AI artifacts."
        meta="~90 seconds • included with every plan"
        onClick={() => onChange("remotion")}
      />
      <EngineCard
        active={engine === "runway"}
        title="Cinematic AI"
        proTag
        description="Real image-to-video motion. Light shifts, parallax depth, the works — powered by Runway."
        meta="3–5 minutes • Cinematic AI plan or higher"
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
        brandKit: branding
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
        introCard: planResult.editPlan.introCard,
        outroCard: planResult.editPlan.outroCard,
        musicMood: planResult.editPlan.musicMood,
        selectedStyle: styleLabel,
        runwayConfig: planResult.editPlan.runwayConfig,
        brandKit: branding,
        organizationId: organization?.id || null
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
    const maxMs = 12 * 60 * 1000; // 12 min hard cap
    let prevProgress = 0;
    let prevPhase = "";
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5; // worker may briefly restart — tolerate it

    // KEY FIX #3: poll IMMEDIATELY on the first iteration instead of waiting
    // 4 seconds. The worker has already started by the time we get here,
    // so there's real progress to display right now.
    let firstIteration = true;
    const POLL_INTERVAL_MS = 3000; // was 4000 — tighter feedback loop

    while (Date.now() - startTime < maxMs) {
      if (!firstIteration) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      firstIteration = false;
      try {
        const status = await pollRender(jobId);
        consecutiveErrors = 0;

        // Progress monotonicity — never let the bar go backward.
        const incomingProgress = Number(status.progress || 0);
        const safeProgress = Math.max(prevProgress, incomingProgress);
        prevProgress = safeProgress;
        const safePhase = status.phase || prevPhase;
        prevPhase = safePhase;

        setRenderJob({
          ...status,
          jobId,
          progress: safeProgress,
          phase: safePhase
        });

        if (status.status === "completed" || status.status === "failed") return;
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          const msg = err instanceof Error ? err.message : "Status check failed.";
          setError(`Lost contact with the render worker: ${msg}`);
          return;
        }
        // Otherwise keep polling — worker may be briefly restarting
      }
    }
    setError("Render timed out after 12 minutes.");
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
   Lives as its own component so it can hold local UI state for the
   smooth-creep + ETA tracking without re-rendering the rest of the page.
   ============================================================ */
function ActiveRenderPanel() {
  const renderJob = useStore((s) => s.renderJob);

  // The "display progress" is what the bar actually shows. It tracks the
  // real progress (from the worker / generate flow) but creeps forward
  // smoothly between updates so the bar always feels alive — even during
  // a long Runway scene that takes 90 seconds without status changes.
  const [displayProgress, setDisplayProgress] = useState<number>(renderJob?.progress ?? 0);
  // Time we first saw a non-zero progress — used to compute an ETA.
  const [renderStartedAt] = useState<number>(() => Date.now());

  // Whenever the real progress jumps, snap display forward (never back).
  useEffect(() => {
    if (!renderJob) return;
    setDisplayProgress((prev) => Math.max(prev, renderJob.progress || 0));
  }, [renderJob?.progress]);

  // Soft creep: between real updates, advance the display progress by a
  // tiny amount every 250ms so the bar never sits still during long phases.
  // Capped so we never overshoot real progress by more than ~5 percentage
  // points — that way when a real update arrives we don't have to rubber-band.
  useEffect(() => {
    if (!renderJob) return;
    if (renderJob.status === "completed" || renderJob.status === "failed") return;
    const interval = window.setInterval(() => {
      setDisplayProgress((prev) => {
        const realProgress = useStore.getState().renderJob?.progress ?? prev;
        const ceiling = Math.min(99, realProgress + 5);
        if (prev >= ceiling) return prev;
        // Slower creep at high progress (we're closer to "real" than at low)
        const creepRate = prev < 30 ? 0.35 : prev < 70 ? 0.22 : 0.12;
        return Math.min(ceiling, prev + creepRate);
      });
    }, 250);
    return () => window.clearInterval(interval);
  }, [renderJob?.status]);

  if (!renderJob) return null;

  const clampedDisplay = Math.max(2, Math.min(100, displayProgress));
  const isRunway = renderJob.engine === "runway";
  const totalEstimateSec = isRunway ? 240 : 75; // 4 min vs 75 s

  // ETA — only show after we've seen real forward motion, otherwise the
  // first reading is meaningless ("about an hour left" before we even begin).
  const elapsedSec = Math.max(0, (Date.now() - renderStartedAt) / 1000);
  const showEta = clampedDisplay >= 12 && clampedDisplay < 95;
  let etaLabel = "";
  if (showEta) {
    // Linear extrapolation against the chosen total estimate, with a floor
    // so we never show "about 0 seconds left" for the last 5%.
    const fractionDone = clampedDisplay / 100;
    const projectedTotal = elapsedSec / Math.max(0.05, fractionDone);
    const remaining = Math.max(8, projectedTotal - elapsedSec);
    // Use the heuristic estimate as a sanity cap so a slow first poll
    // doesn't extrapolate into "12 minutes left."
    const capped = Math.min(remaining, totalEstimateSec * 1.5);
    etaLabel = capped < 60
      ? `about ${Math.round(capped)}s left`
      : `about ${Math.round(capped / 60)} min left`;
  }

  return (
    <div className="bg-surface border border-edge rounded-xl p-5 flex flex-col gap-4 fade-up-in">
      {/* Header row: phase + percentage */}
      <div className="flex items-center gap-3">
        <div className="grid place-items-center w-8 h-8 rounded-full bg-gold/15 text-gold flex-shrink-0">
          <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold tracking-tightish truncate">
            {renderJob.phase || "Rendering"}
          </div>
          <div className="text-[11px] text-ink-muted mt-0.5">
            {isRunway ? "Cinematic AI · Runway image-to-video" : "Quick Reel · Ken Burns motion"}
            {etaLabel && <span> · {etaLabel}</span>}
          </div>
        </div>
        <div className="font-mono text-sm font-semibold text-gold tabular-nums">
          {Math.round(clampedDisplay)}%
        </div>
      </div>

      {/* The bar itself — CSS transition does the smoothing between frames */}
      <div className="h-2 bg-edge rounded-full overflow-hidden relative">
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-gold-dim via-gold to-gold-light rounded-full"
          style={{
            width: `${clampedDisplay}%`,
            transition: "width 0.45s cubic-bezier(0.22, 1, 0.36, 1)"
          }}
        />
        {/* Shimmer pass */}
        <div
          className="absolute inset-y-0 w-24 bg-gradient-to-r from-transparent via-white/20 to-transparent pointer-events-none"
          style={{
            animation: "render-shimmer 1.8s linear infinite",
            mixBlendMode: "overlay"
          }}
        />
      </div>

      {/* Phase chips — visualizes the multi-stage pipeline */}
      <PhaseChips currentProgress={clampedDisplay} engine={renderJob.engine} />
    </div>
  );
}

function PhaseChips({ currentProgress, engine }: { currentProgress: number; engine?: "remotion" | "runway" }) {
  // Each chip shows a stage of the pipeline. The frontier (last "active"
  // chip) pulses subtly to draw the eye to where we are right now.
  const stages = engine === "runway"
    ? [
        { label: "Direct", endsAt: 10 },
        { label: "Render scenes", endsAt: 76 },
        { label: "Voice + mix", endsAt: 86 },
        { label: "Variants + shorts", endsAt: 94 },
        { label: "Upload", endsAt: 100 }
      ]
    : [
        { label: "Direct", endsAt: 12 },
        { label: "Render frames", endsAt: 78 },
        { label: "Voice + mix", endsAt: 86 },
        { label: "Variants + shorts", endsAt: 94 },
        { label: "Upload", endsAt: 100 }
      ];

  // Find the current stage (the first one whose endsAt is ahead of progress)
  const currentIndex = stages.findIndex((s) => currentProgress < s.endsAt);
  const activeIdx = currentIndex === -1 ? stages.length - 1 : currentIndex;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5">
      {stages.map((stage, idx) => {
        const isDone = idx < activeIdx;
        const isActive = idx === activeIdx;
        return (
          <div
            key={stage.label}
            className={cn(
              "flex-shrink-0 px-2.5 py-1 rounded-md text-[10px] font-medium tracking-tightish whitespace-nowrap border transition-colors",
              isDone
                ? "bg-gold/15 text-gold-light border-gold/30"
                : isActive
                ? "bg-gold/10 text-gold border-gold/40 animate-pulse"
                : "bg-surface-input text-ink-muted border-edge"
            )}
          >
            {isDone && <span className="mr-1">✓</span>}
            {stage.label}
          </div>
        );
      })}
    </div>
  );
}
