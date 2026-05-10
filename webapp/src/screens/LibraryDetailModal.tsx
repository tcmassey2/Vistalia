import { useEffect, useState } from "react";
import type { LibraryEntry } from "../lib/types";

/**
 * Library detail modal — shown when an agent clicks a render in their
 * dashboard. Reinforces the "one render → full bundle" differentiator
 * by surfacing every deliverable: vertical/square/wide variants, three
 * social shorts, and the thumbnail. Each is downloadable individually.
 *
 * The card click on the dashboard previously opened the master MP4
 * directly. That hid the bundle from the agent. Now they see all six
 * files for every render with one click.
 */
export default function LibraryDetailModal({
  entry,
  onClose
}: {
  entry: LibraryEntry;
  onClose: () => void;
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
  const engineLabel = entry.engine === "runway" ? "Cinematic AI" : "Quick Reel";

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
              {engineLabel} · {dateLabel}
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
