import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { fetchLibrary, sendDesktopLink, importListing, curatePhotos } from "../lib/api";
import { buildSamplePhotos, SAMPLE_LISTING, SAMPLE_PROJECT_TITLE } from "../lib/samples";
import type { LibraryEntry, Photo } from "../lib/types";
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

      {/* v52: listing-URL import — the phone-first path. Leads arrive from
          Instagram on phones where their MLS photos aren't; a listing link
          is the one asset every agent has in hand. Server pulls address,
          facts, and (best-effort) the photos straight into the project. */}
      <ImportListingBand />

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
              Your first listing video, <em className="italic text-gold-light">directed like film.</em>
            </h2>
            <p className="text-ink-muted text-sm sm:text-base max-w-md mx-auto mb-8 leading-relaxed">
              Upload your MLS photos, pick a style, and Vistalia directs the motion,
              narration, and pacing — narrated in your voice, captions included,
              ready the same hour.
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

          {/* Mobile → desktop handoff. Instant Form leads arrive on their
              phones, but listing photos live on their computers — every
              signed-in-no-render lead we've inspected stalled exactly here.
              Small screens get a one-tap "email me a link for my desk" plus
              an example video so the phone visit still pays off. */}
          <DesktopHandoffBand email={session?.user?.email || ""} />

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
                  Every scene is directed, verified, and narrated — review the cut, then download and post.
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

/* v52: paste-a-listing-link import. Generates the projectId up front so the
   server stores photos under the same path the project will use, probes
   image dimensions client-side (the server doesn't decode), and drops the
   user straight into a photo-ready project. Every failure path still lands
   somewhere useful: address-only → prefilled project + "add photos". */
function ImportListingBand() {
  const beginImportedProject = useStore((s) => s.beginImportedProject);
  const setToast = useStore((s) => s.setToast);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // v62.4 progress: the import now runs three real client-side phases
  // (server import → dimension probe → AI curation), each up to tens of
  // seconds — a silent spinner read as "hung". The bar eases toward each
  // phase's ceiling (always moving, never claiming done) and jumps on real
  // phase boundaries.
  const [progress, setProgress] = useState(0);
  const [phaseLabel, setPhaseLabel] = useState("");
  const progressRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const stopTicker = () => {
    if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; }
  };
  const setPct = (v: number) => { progressRef.current = v; setProgress(v); };
  const startPhase = (label: string, ceiling: number) => {
    setPhaseLabel(label);
    stopTicker();
    timerRef.current = window.setInterval(() => {
      const cur = progressRef.current;
      const next = Math.min(ceiling, cur + Math.max(0.12, (ceiling - cur) * 0.055));
      setPct(next);
    }, 250);
  };
  useEffect(() => stopTicker, []);

  // v62.6: probe dimensions AND paper-likeness in one decode. Floor plans,
  // site plans, and document sheets are overwhelmingly white paper — a
  // near-white pixel fraction over half the frame at 48×48 is decisive,
  // deterministic, and free, catching the colored-site-plan class that
  // low-detail Vision misreads as an "aerial rendering". Real photos —
  // even bright white kitchens — rarely exceed ~35% near-white; plans run
  // 55-85%. Fail-open: any canvas/CORS error reports paperLike=false.
  const probePhoto = (src: string) =>
    new Promise<{ width: number; height: number; paperLike: boolean }>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const done = (w: number, h: number, paperLike: boolean) =>
        resolve({ width: w || 1024, height: h || 1365, paperLike });
      const timer = setTimeout(() => done(0, 0, false), 8000);
      img.onload = () => {
        clearTimeout(timer);
        let paperLike = false;
        try {
          const S = 48;
          const canvas = document.createElement("canvas");
          canvas.width = S;
          canvas.height = S;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(img, 0, 0, S, S);
            const d = ctx.getImageData(0, 0, S, S).data;
            let white = 0;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i] > 228 && d[i + 1] > 228 && d[i + 2] > 228) white++;
            }
            paperLike = white / (S * S) > 0.5;
          }
        } catch { /* tainted canvas or decode issue → treat as a photo */ }
        done(img.naturalWidth, img.naturalHeight, paperLike);
      };
      img.onerror = () => { clearTimeout(timer); done(0, 0, false); };
      img.src = src;
    });

  const handleImport = async () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    setPct(3);
    startPhase("Reading the listing page…", 52);
    try {
      const projectId = `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await importListing(trimmed, projectId);
      if (result.status === "failed") {
        setError(result.error || "Import failed — try again or start manually.");
        return;
      }
      if (result.status === "not_found") {
        setError(result.message || "We couldn't read that link — paste the listing page URL.");
        return;
      }
      const imported = result.photos || [];
      setPct(56);
      startPhase(`Preparing ${imported.length} photo${imported.length === 1 ? "" : "s"}…`, 64);
      const probes = await Promise.all(imported.map((p) => probePhoto(p.publicUrl)));
      // v62.6: paper-like sheets (floor plans, site plans, documents) are
      // dropped HERE, deterministically, before curation ever sees them —
      // "we can't pull anything that is not actual photos of the house."
      const planDropped = imported.filter((_, i) => probes[i].paperLike).length;
      if (planDropped > 0) {
        console.info(`[import] dropped ${planDropped} plan/document image(s) — paper-white background detected.`);
      }
      const photos: Photo[] = imported
        .map((p, i) => ({ p, probe: probes[i], i }))
        .filter(({ probe }) => !probe.paperLike)
        .map(({ p, probe }, i) => ({
          id: `imported-${projectId}-${i}`,
          fileName: p.fileName,
          publicUrl: p.publicUrl,
          durableUrl: p.publicUrl,
          storagePath: p.storagePath,
          bucket: p.bucket,
          width: probe.width,
          height: probe.height,
          size: p.size,
          order: i,
          uploadedAt: new Date().toISOString()
        }));

      // v62.4 DIVERSITY PASS (Troy: "It imports the same photo several
      // times. There needs to be diversity."): portal galleries repeat
      // near-identical shots (builder renders, burst angles) that URL-level
      // dedupe can't see. The long-orphaned /api/curate-photos endpoint is
      // exactly this filter — Vision scores every photo, drops lookalikes,
      // caps per-room counts, and returns a professional tour order.
      // Fail-open at every exit: any non-ok status keeps ALL imported
      // photos exactly as before.
      let finalPhotos = photos;
      let curatedNote = "";
      if (photos.length >= 8) {
        setPct(66);
        startPhase("Hand-picking the most diverse shots…", 93);
        try {
          const cur = await curatePhotos({
            photos: photos.map((p) => ({ id: p.id, durableUrl: p.durableUrl, fileName: p.fileName }))
          });
          if (cur.status === "ok" && Array.isArray(cur.curated) && cur.curated.length >= 6) {
            const byId = new Map(photos.map((p) => [p.id, p]));
            const picked = [...cur.curated]
              .sort((a, b) => a.order - b.order)
              .map((c, i) => {
                const p = byId.get(c.photoId);
                return p ? { ...p, order: i } : null;
              })
              .filter((p): p is Photo => Boolean(p));
            if (picked.length >= 6) {
              finalPhotos = picked;
              curatedNote = ` — kept the ${picked.length} most diverse in tour order`;
            }
          }
        } catch { /* curation is a bonus, never a blocker */ }
      }

      setPct(96);
      setPhaseLabel("Opening your project…");
      const addr = result.address;
      const facts = result.facts || {};
      beginImportedProject({
        projectId,
        title: addr?.line || "Imported listing",
        listing: {
          address: addr?.line || "",
          city: [addr?.city, addr?.state].filter(Boolean).join(" "),
          price: facts.price ? String(facts.price) : "",
          beds: facts.beds != null ? String(facts.beds) : "",
          baths: facts.baths != null ? String(facts.baths) : "",
          squareFeet: facts.sqft != null ? String(facts.sqft) : ""
        },
        photos: finalPhotos
      });
      setPct(100);
      const planNote = planDropped > 0
        ? ` (${planDropped} plan/document sheet${planDropped === 1 ? "" : "s"} excluded)`
        : "";
      setToast(
        finalPhotos.length > 0
          ? `Imported ${photos.length} photo${photos.length === 1 ? "" : "s"}${curatedNote}${planNote} — review and render.`
          : "Listing details imported — add your photos and render."
      );
    } catch {
      setError("Import failed — try again or start manually.");
    } finally {
      stopTicker();
      setBusy(false);
      setPct(0);
      setPhaseLabel("");
    }
  };

  return (
    <div className="border border-edge rounded-xl bg-surface px-4 py-3.5 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
        <div className="flex-none sm:pr-1">
          <span className="block text-sm font-semibold tracking-tightish">Have the listing link?</span>
          <span className="block text-xs text-ink-muted">Zillow, Redfin, or Realtor.com — we'll pull the details</span>
        </div>
        <input
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") handleImport(); }}
          placeholder="https://www.zillow.com/homedetails/…"
          inputMode="url"
          autoComplete="off"
          className="flex-1 h-11 rounded-lg bg-surface-input border border-edge px-3 text-sm placeholder:text-ink-dim focus:border-gold outline-none min-w-0"
        />
        <button
          onClick={handleImport}
          disabled={busy || !url.trim()}
          className="btn-primary-em h-11 px-5 rounded-lg text-sm flex-none disabled:opacity-50"
        >
          {busy ? "Importing…" : "Import listing"}
        </button>
      </div>
      {busy && (
        <div className="mt-3" aria-live="polite">
          <div className="h-1.5 rounded-full bg-surface-input overflow-hidden">
            <div
              className="h-full rounded-full bg-gold transition-[width] duration-300 ease-out"
              style={{ width: `${Math.round(progress)}%` }}
            />
          </div>
          <p className="text-xs text-ink-muted mt-1.5">{phaseLabel}</p>
        </div>
      )}
      {error && <p className="text-xs text-red-300 mt-2">{error}</p>}
    </div>
  );
}

/* Mobile-only band inside the empty state. Detects small screens via
   matchMedia (SSR-safe: defaults false, resolves on mount) and offers a
   one-tap handoff: POST /api/send-desktop-link mails the signed-in user a
   fresh 24h magic link for their computer. States: idle → sending → sent
   (terminal for the session) with a soft error path that allows retry. */
function DesktopHandoffBand({ email }: { email: string }) {
  const [isSmallScreen, setIsSmallScreen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const update = () => setIsSmallScreen(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (!isSmallScreen) return null;

  const send = async () => {
    if (phase === "sending" || phase === "sent") return;
    setPhase("sending");
    setErrorMsg("");
    const result = await sendDesktopLink();
    if (result.ok) {
      setPhase("sent");
    } else {
      setPhase("error");
      setErrorMsg(result.error || "Couldn't send the link. Try again.");
    }
  };

  return (
    <div className="border-t border-gold/20 bg-gold/5 px-6 py-7 text-center">
      <p className="text-[10px] uppercase tracking-widest text-gold mb-2 font-mono">
        On your phone?
      </p>
      <p className="text-sm text-ink-muted leading-relaxed max-w-sm mx-auto mb-4">
        Your listing photos probably live on your computer — MLS downloads,
        your photographer&rsquo;s folder. Email yourself a one-tap sign-in link
        and finish there in about a minute.
      </p>
      {phase === "sent" ? (
        <div className="inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-gold/15 border border-gold/30 text-sm text-gold-light">
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Sent{email ? ` to ${email}` : ""} — open it at your desk
        </div>
      ) : (
        <button
          onClick={send}
          disabled={phase === "sending"}
          className="btn-secondary-em h-11 px-5 rounded-lg text-sm disabled:opacity-60"
        >
          {phase === "sending" ? "Sending…" : "Email me a link for my computer"}
        </button>
      )}
      {phase === "error" && errorMsg && (
        <p className="text-xs text-red-300 mt-2">{errorMsg}</p>
      )}
      <p className="text-xs mt-3">
        <a
          href="/examples"
          target="_blank"
          rel="noreferrer"
          className="text-ink-muted underline decoration-gold/40 underline-offset-4 hover:text-gold-light"
        >
          Meanwhile — watch a 30-second example
        </a>
      </p>
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
        {/* Format hint pill — customer vocabulary, not a file count */}
        <span className="absolute bottom-2.5 right-2.5 px-2 py-0.5 rounded-md bg-paper/85 text-[10px] font-mono text-ink-soft border border-edge">
          {entry.formatsCount >= 2 ? "9:16 + 1:1" : "9:16"}
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
