import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { fetchLibrary } from "../lib/api";
import { buildSamplePhotos, SAMPLE_LISTING, SAMPLE_PROJECT_TITLE } from "../lib/samples";
import type { LibraryEntry } from "../lib/types";
import { engineLabel } from "../lib/engine-labels";
import LibraryDetailModal from "./LibraryDetailModal";
import PlanStatusBanner from "../components/PlanStatusBanner";

export default function DashboardScreen() {
  const newProject = useStore((s) => s.newProject);
  const session = useStore((s) => s.session);
  const setListing = useStore((s) => s.setListing);
  const addPhotos = useStore((s) => s.addPhotos);
  const setProjectTitle = useStore((s) => s.setProjectTitle);

  // Library — past renders, fetched from the audit log on mount.
  const [library, setLibrary] = useState<LibraryEntry[] | null>(null);
  const [libraryNote, setLibraryNote] = useState<string>("");
  const [libraryError, setLibraryError] = useState<string>("");
  const [libraryLoading, setLibraryLoading] = useState(true);
  // Selected entry for the detail modal — null means closed.
  const [selectedEntry, setSelectedEntry] = useState<LibraryEntry | null>(null);

  // Refresh the library list. Used on mount AND after a per-scene regen
  // completes — the modal calls back via onUpdated so the new master URL
  // (and updated scenes array) shows up everywhere immediately.
  const reloadLibrary = async () => {
    try {
      const result = await fetchLibrary({ limit: 50 });
      if (result.status === "failed") {
        setLibraryError(result.error || "Couldn't load your library.");
        setLibrary([]);
      } else {
        setLibrary(result.library);
        if (result.note) setLibraryNote(result.note);
        // If the modal is currently open, swap its entry to the freshly-loaded
        // version so the user sees the new master video without reopening.
        setSelectedEntry((current) => {
          if (!current) return current;
          const updated = result.library.find((e) => e.jobId === current.jobId);
          return updated || current;
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't load your library.";
      setLibraryError(msg);
      setLibrary([]);
    } finally {
      setLibraryLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      await reloadLibrary();
      if (!alive) return;
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefer the real name from OAuth/profile metadata (Google sign-in supplies
  // full_name/name); fall back to the email local-part, then "there". Capitalize
  // so we never greet someone with a bare lowercase handle.
  const meta = (session?.user?.user_metadata ?? {}) as {
    first_name?: string;
    full_name?: string;
    name?: string;
  };
  const metaFirst = (meta.first_name || meta.full_name || meta.name || "").trim().split(/\s+/)[0];
  const rawName = metaFirst || (session?.user?.email || "").split("@")[0] || "there";
  const firstName = rawName === "there" ? rawName : rawName.charAt(0).toUpperCase() + rawName.slice(1);

  const startWithSample = () => {
    newProject();
    setListing(SAMPLE_LISTING);
    setProjectTitle(SAMPLE_PROJECT_TITLE);
    addPhotos(buildSamplePhotos());
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6 mb-10">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-gold mb-2.5 font-mono">Your work</p>
          <h1 className="font-display text-4xl sm:text-5xl font-semibold tracking-tighter2 leading-[1.05]">
            Welcome back, {firstName}.
          </h1>
          <p className="text-ink-muted text-sm mt-2">
            Start a new listing video — or pick up where you left off.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          <button
            onClick={startWithSample}
            className="btn-secondary-em h-11 px-4 rounded-lg text-sm"
          >
            Try with sample listing
          </button>
          <button
            onClick={newProject}
            className="btn-primary-em h-11 px-5 rounded-lg inline-flex items-center gap-2"
          >
            <span className="text-lg leading-none">+</span> New listing video
          </button>
        </div>
      </div>

      {/* Plan / trial status — surfaces tier, quota, and trial countdown.
          On expired trial, this becomes the primary upgrade prompt. */}
      <PlanStatusBanner />

      {/* Loading state */}
      {libraryLoading && (
        // Skeleton trio. Same dimensions as a real library card so the
        // layout doesn't reflow when content arrives. Better perceived
        // performance than a centered spinner.
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="bg-surface border border-edge rounded-xl overflow-hidden animate-pulse"
              style={{ animationDelay: `${i * 120}ms` }}
            >
              <div className="aspect-video bg-surface-input" />
              <div className="p-4">
                <div className="h-4 w-3/4 bg-edge rounded mb-2" />
                <div className="h-3 w-1/2 bg-edge rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {!libraryLoading && libraryError && (
        <div className="border border-red-500/30 bg-red-500/10 rounded-2xl px-6 py-5 text-sm text-red-300">
          {libraryError}
        </div>
      )}

      {/* Migration hint — when audit table is missing */}
      {!libraryLoading && libraryNote && (
        <div className="border border-amber-500/30 bg-amber-500/10 rounded-2xl px-6 py-5 text-sm text-amber-200 mb-6">
          <strong className="text-amber-100">Library setup needed:</strong> {libraryNote}
        </div>
      )}

      {/* Empty state — first-time users land here. Three-step preview
          gives them the shape of the workflow before they commit, then
          two CTAs (start fresh OR try sample) lower the barrier. */}
      {!libraryLoading && !libraryError && library && library.length === 0 && !libraryNote && (
        <div className="border border-edge rounded-2xl bg-surface overflow-hidden">
          <div className="px-8 pt-12 pb-8 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-gradient-to-br from-gold/30 to-gold/5 grid place-items-center mb-6 ring-1 ring-gold/20">
              <svg viewBox="0 0 24 24" className="w-7 h-7 text-gold" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none" />
              </svg>
            </div>
            <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-tighter2 mb-3 leading-tight">
              Your first cinematic listing video, in three minutes.
            </h2>
            <p className="text-ink-muted text-sm sm:text-base max-w-md mx-auto mb-8 leading-relaxed">
              Upload your MLS photos, pick a style, and Vistalia directs the
              motion, music, and pacing — then hands you every aspect ratio at once.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 mb-2">
              <button onClick={newProject} className="btn-primary-em h-12 px-6 rounded-lg pulse-glow">
                <span className="text-lg leading-none mr-1.5">+</span>
                Create your first video
              </button>
              <button onClick={startWithSample} className="btn-secondary-em h-12 px-5 rounded-lg">
                Try with sample listing
              </button>
            </div>
            <p className="text-xs text-ink-dim mt-3">
              Free for 7 days · 1 free video · No credit card
            </p>
          </div>

          {/* "How it works" strip — three illustrated micro-steps so the
              workflow doesn't feel like a black box. Subtle alternating
              background tints separate it from the CTA above. */}
          <div className="border-t border-edge-soft bg-surface-input/40 px-6 sm:px-10 py-8">
            <p className="text-[10px] uppercase tracking-widest text-gold mb-5 font-mono text-center">
              How it works
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div className="text-center sm:text-left">
                <div className="font-mono text-[11px] text-gold mb-2">01</div>
                <h3 className="text-sm font-semibold mb-1.5 tracking-tightish">Upload photos</h3>
                <p className="text-xs text-ink-muted leading-relaxed">
                  Drop in 8–24 listing photos. Drag the tiles to set the tour order.
                </p>
              </div>
              <div className="text-center sm:text-left">
                <div className="font-mono text-[11px] text-gold mb-2">02</div>
                <h3 className="text-sm font-semibold mb-1.5 tracking-tightish">Pick a style</h3>
                <p className="text-xs text-ink-muted leading-relaxed">
                  Cinematic Luxury, Modern Social, MLS Clean, or Investor Tour. Each has its own grade and music.
                </p>
              </div>
              <div className="text-center sm:text-left">
                <div className="font-mono text-[11px] text-gold mb-2">03</div>
                <h3 className="text-sm font-semibold mb-1.5 tracking-tightish">Hit Generate</h3>
                <p className="text-xs text-ink-muted leading-relaxed">
                  Your cinematic video is ready in about three minutes. Review every scene, then download.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Library grid */}
      {!libraryLoading && library && library.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {library.map((entry) => (
            <LibraryCard
              key={entry.id}
              entry={entry}
              onOpen={() => setSelectedEntry(entry)}
            />
          ))}
        </div>
      )}

      {/* Detail modal — shows the full bundle when a card is clicked */}
      {selectedEntry && (
        <LibraryDetailModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onUpdated={reloadLibrary}
        />
      )}
    </div>
  );
}

function LibraryCard({ entry, onOpen }: { entry: LibraryEntry; onOpen: () => void }) {
  const date = new Date(entry.createdAt);
  const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const labelText = engineLabel(entry.engine);
  const heading = entry.listingAddress || entry.projectTitle || "Untitled listing";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="card-press group block bg-surface border border-edge hover:border-gold rounded-xl overflow-hidden transition-colors text-left w-full"
    >
      <div className="aspect-video bg-surface-input relative overflow-hidden">
        {entry.thumbnailUrl ? (
          <img
            src={entry.thumbnailUrl}
            alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-ink-dim text-xs">
            No preview
          </div>
        )}
        <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded-md bg-paper/85 text-[10px] font-mono uppercase tracking-wider text-ink-soft border border-edge">
          {labelText}
        </span>
        {entry.narrationApplied && (
          <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-md bg-gold/90 text-paper text-[10px] font-bold tracking-wider">
            NARRATED
          </span>
        )}
        {/* Bundle hint pill — bottom right */}
        <span className="absolute bottom-2.5 right-2.5 px-2 py-0.5 rounded-md bg-paper/85 text-[10px] font-medium text-ink-soft border border-edge">
          {entry.formatsCount + entry.socialShortCount} files
        </span>
      </div>
      <div className="p-4">
        <h3 className="font-medium tracking-tightish truncate">{heading}</h3>
        <p className="text-xs text-ink-muted mt-1 flex items-center gap-2">
          <span>{dateLabel}</span>
          <span className="text-ink-dim">·</span>
          <span>{entry.formatsCount} format{entry.formatsCount === 1 ? "" : "s"}</span>
          {entry.socialShortCount > 0 && (
            <>
              <span className="text-ink-dim">·</span>
              <span>{entry.socialShortCount} short{entry.socialShortCount === 1 ? "" : "s"}</span>
            </>
          )}
        </p>
      </div>
    </button>
  );
}
