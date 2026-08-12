// Vistalia — paste-a-listing-link import, shared (v62.46).
//
// v52 built this inside DashboardScreen; v62.46 extracts it so the render
// setup screen (ProjectScreen) gets the same URL import — Troy: "lets put
// the URL to photos option within the render setup (its only in the
// library right now)". Two modes:
//   default        — Dashboard: creates a fresh project (beginImportedProject)
//   intoProject    — ProjectScreen: appends photos to the CURRENT project and
//                    fills only the listing fields the agent left empty.
// The probe pipeline (dimension decode, paper-plan drop, low-res gate) and
// the off-critical-path curation kick are identical in both modes; in
// intoProject mode curation only runs when the imported set IS the whole
// photo set (never reorders a mixed hand-picked set).

import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { importListing, curatePhotos, resolveListing, radarAutocomplete, radarConfigured } from "../lib/api";
import type { Photo } from "../lib/types";

// v62.96: the band accepts free text now, not just URLs. URL-ish input
// (scheme, or a bare known-portal domain) imports directly; anything else
// goes through the fail-closed server resolver (Zillow search + address
// verification) first. Mirrors the server's own promotion rules.
const isUrlish = (v: string) =>
  /^https?:\/\/\S+$/i.test(v) || /^(www\.)?(zillow|redfin|realtor|homes|trulia|compass|kw|exp)\S*\.\S+/i.test(v);

export default function ListingLinkImport({ intoProject = false }: { intoProject?: boolean }) {
  const storeProjectId = useStore((s) => s.projectId);
  const listingNow = useStore((s) => s.listing);
  const setListing = useStore((s) => s.setListing);
  const addPhotos = useStore((s) => s.addPhotos);
  const beginImportedProject = useStore((s) => s.beginImportedProject);
  const setToast = useStore((s) => s.setToast);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // v62.96 address typeahead (Radar, free tier). Only engages on non-URL
  // input when the publishable key is configured; without it the band is
  // the same plain field as before.
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const suggestTimer = useRef<number | null>(null);
  const suppressSuggest = useRef(false);
  useEffect(() => {
    if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current);
    const q = url.trim();
    if (suppressSuggest.current) {
      suppressSuggest.current = false; // one-shot: set when a suggestion was just picked
      setSuggestions([]);
      return;
    }
    if (busy || !radarConfigured() || q.length < 5 || isUrlish(q)) {
      setSuggestions([]);
      return;
    }
    let stale = false;
    suggestTimer.current = window.setTimeout(async () => {
      const list = await radarAutocomplete(q);
      if (!stale) setSuggestions(list);
    }, 280);
    return () => {
      stale = true;
      if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current);
    };
  }, [url, busy]);
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
    new Promise<{ width: number; height: number; paperLike: boolean; measured: boolean }>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      // v62.17: `measured` distinguishes a real decode from the 1024x1365
      // placeholder. Without it a slow gallery on mobile (8s timeout) fed
      // fabricated dimensions into the low-res median — which could either
      // mask a genuinely small photo or, if enough probes timed out, make
      // the median itself fictional and drop good photos.
      const done = (w: number, h: number, paperLike: boolean) =>
        resolve({ width: w || 1024, height: h || 1365, paperLike, measured: w > 0 && h > 0 });
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
    setSuggestions([]);
    setPct(3);
    // v62.52: gate the render button while the import is mid-flight — a
    // "Generate video" click during the import would render whatever subset
    // of the tray existed before the imported photos landed.
    useStore.getState().adjustMediaBusy(+1);
    // v62.96: typed-address path. Resolve free text to the listing URL
    // before the importer sees it — same fail-closed server resolver the
    // lead auto-render uses. A miss is a clear message, never a guess.
    let importInput = trimmed;
    if (!isUrlish(trimmed)) {
      startPhase("Finding the listing…", 18);
      const resv = await resolveListing(trimmed);
      if (resv.status === "ok" && resv.url) {
        importInput = resv.url;
      } else {
        stopTicker();
        setError(
          resv.status === "not_a_query"
            ? "Add a bit more — the full address with city and state (or paste the listing URL)."
            : resv.status === "not_found"
              ? "We couldn't find that listing — double-check the address, or paste the listing page URL."
              : "The listing search is having a moment — try again, or paste the listing URL."
        );
        useStore.getState().adjustMediaBusy(-1);
        setBusy(false);
        setPct(0);
        setPhaseLabel("");
        return;
      }
    } else if (!/^https?:\/\//i.test(importInput)) {
      importInput = `https://${importInput}`;
    }
    // v62.24: the ceilings used to be weighted for a flow whose last step
    // was a 50-90s Vision call — reading the page got 3-52 and curation got
    // 66-93, so the bar crawled through the 80s for a minute and read as
    // stuck. With curation moved off the critical path, the server round
    // trip (page fetch + 24 downloads + 24 uploads, ~11-15s measured) IS
    // the long pole and gets the bar to match.
    startPhase("Reading the listing page…", 74);
    try {
      // intoProject: photos store under the CURRENT project's path and ids.
      const projectId = intoProject
        ? storeProjectId
        : `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await importListing(importInput, projectId);
      if (result.status === "failed") {
        setError(result.error || "Import failed — try again or start manually.");
        return;
      }
      if (result.status === "not_found") {
        setError(result.message || "We couldn't read that link — paste the listing page URL.");
        return;
      }
      const imported = result.photos || [];
      setPct(78);
      // Each probe decodes a full-size photo in the browser, so this scales
      // with the gallery: ~24 images is a real few seconds, not instant.
      startPhase(`Checking ${imported.length} photo${imported.length === 1 ? "" : "s"}…`, 94);
      const probes = await Promise.all(imported.map((p) => probePhoto(p.publicUrl)));
      // v62.6: paper-like sheets (floor plans, site plans, documents) are
      // dropped HERE, deterministically, before curation ever sees them —
      // "we can't pull anything that is not actual photos of the house."
      const planDropped = imported.filter((_, i) => probes[i].paperLike).length;
      if (planDropped > 0) {
        console.info(`[import] dropped ${planDropped} plan/document image(s) — paper-white background detected.`);
      }
      // v62.15 LOW-RES GATE (Troy: "a low res example snuck in"). The
      // importer only ever checked BYTE size — an 800x600 thumbnail passes
      // the 8KB floor comfortably. Pixels are what matter, and doubly so
      // now that v62.10 crops the photo to the delivery aspect (9:16 or, as
      // of v62.18, 1:1) before generation: a small
      // source gets cropped AND upscaled, so one weak photo reads as a
      // visibly soft scene next to sharp ones. Two rules: a hard floor for
      // genuinely unusable images, and a relative rule that catches the odd
      // one out in an otherwise good set (the case Troy actually saw).
      // Median is built from MEASURED photos only — a fabricated dimension
      // must never define what "normal size" means for this set.
      const areas = probes.filter((pr) => !pr.paperLike && pr.measured).map((pr) => pr.width * pr.height).sort((a, b) => a - b);
      const medianArea = areas.length >= 3 ? areas[Math.floor(areas.length / 2)] : 0;
      const isLowRes = (pr: { width: number; height: number; measured: boolean }) => {
        if (!pr.measured) return false;                                     // never judge a photo we couldn't decode
        const shortSide = Math.min(pr.width, pr.height);
        if (shortSide < 512) return true;                                   // unusable outright
        if (medianArea > 0 && pr.width * pr.height < medianArea * 0.4 && shortSide < 900) return true; // the odd one out
        return false;
      };
      const lowResDropped = probes.filter((pr, i) => !probes[i].paperLike && isLowRes(pr)).length;
      if (lowResDropped > 0) {
        console.info(`[import] dropped ${lowResDropped} low-resolution photo(s) — too small to hold up beside the rest of the set.`);
      }
      const photos: Photo[] = imported
        .map((p, i) => ({ p, probe: probes[i], i }))
        .filter(({ probe }) => !probe.paperLike && !isLowRes(probe))
        .map(({ p, probe }, i) => ({
          id: `imported-${projectId}-${Date.now().toString(36)}-${i}`,
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
      /* v62.24: CURATION NO LONGER BLOCKS THE IMPORT.
         This awaited a Vision pass over every imported photo, and
         curate-photos.js documents its own latency: "scoring 25 photos at
         gpt-4.1-mini Vision (low detail) regularly takes 50-90s". Nobody
         noticed until v62.23, because the gate is `photos.length >= 8` and
         imports had been landing at five — the fix that recovered the
         gallery switched on a minute-long step that had never once run.
         The photos are already stored and already gated by then; curation
         only reorders and prunes. So the project opens immediately and the
         pass lands afterwards, turning a 90-second wait into ~15 seconds.
         It is applied ONLY if the user hasn't touched the set in the
         meantime — reordering photos under someone's cursor is worse than
         not curating at all. */
      const finalPhotos = photos;
      const curatedNote = "";

      setPct(96);
      setPhaseLabel("Opening your project…");
      const addr = result.address;
      const facts = result.facts || {};
      if (intoProject) {
        // Fill ONLY the fields the agent left empty — never clobber typed
        // values. Photos append after whatever is already in the tray.
        setListing({
          address: listingNow.address || addr?.line || "",
          city: listingNow.city || [addr?.city, addr?.state].filter(Boolean).join(" "),
          price: listingNow.price || (facts.price ? String(facts.price) : ""),
          beds: listingNow.beds || (facts.beds != null ? String(facts.beds) : ""),
          baths: listingNow.baths || (facts.baths != null ? String(facts.baths) : ""),
          squareFeet: listingNow.squareFeet || (facts.sqft != null ? String(facts.sqft) : ""),
          // v62.96: the page's agent remarks feed the voiceover's selling
          // points (v62.94 MINE THE REMARKS). Same never-clobber rule.
          remarks: listingNow.remarks || (facts.remarks ? String(facts.remarks) : "")
        });
        addPhotos(finalPhotos);
      } else {
        beginImportedProject({
          projectId,
          title: addr?.line || "Imported listing",
          listing: {
            address: addr?.line || "",
            city: [addr?.city, addr?.state].filter(Boolean).join(" "),
            price: facts.price ? String(facts.price) : "",
            beds: facts.beds != null ? String(facts.beds) : "",
            baths: facts.baths != null ? String(facts.baths) : "",
            squareFeet: facts.sqft != null ? String(facts.sqft) : "",
            remarks: facts.remarks ? String(facts.remarks) : ""
          },
          photos: finalPhotos
        });
      }
      setPct(100);
      const excluded: string[] = [];
      if (planDropped > 0) excluded.push(`${planDropped} plan/document sheet${planDropped === 1 ? "" : "s"}`);
      if (lowResDropped > 0) excluded.push(`${lowResDropped} low-res photo${lowResDropped === 1 ? "" : "s"}`);
      const planNote = excluded.length ? ` (${excluded.join(" and ")} excluded)` : "";
      // v62.20: the server's warnings were being thrown away. api/import-
      // listing.js has pushed a `warnings` array since v58.2 — proxy tier
      // failures, transfer failures, and as of v62.19 the shortfall line
      // ("This listing has 73 photos but the page only exposed 5") — and
      // this screen never read the field. That is why a five-of-seventy-
      // three import looked exactly like a five-photo listing: the app HAD
      // the explanation and dropped it on the floor. The shortfall is the
      // one the customer can act on, so it leads.
      const serverWarnings = (result.warnings || []).filter((w) => typeof w === "string" && w.trim());
      // v62.58: the Zillow address rescue note rides the same slot — when
      // photos came from the sister listing, the agent should know.
      const shortfallNote = serverWarnings.find((w) => /only exposed|Zillow listing at this address/i.test(w)) || "";
      if (serverWarnings.length > 0) {
        console.info(`[import] server warnings: ${serverWarnings.join(" | ")}`);
      }
      // v62.56 (Via Del Arbor zero-photo import): the response also says
      // WHERE things came from — log it so a failed import is diagnosable
      // from the browser alone, without the Vercel black-box line.
      console.info(
        `[import] photos=${(result.photos || []).length} photoSource=${result.photoSource || "?"} factsSource=${result.factsSource || "?"}`
      );
      // v62.17: when EVERY imported image was excluded, say why. The old
      // zero-case message ("add your photos") read as "we found nothing",
      // which is a different and more alarming thing than "we found only
      // floor plans and thumbnails and left them out".
      // v62.56: and when the SERVER already said why the photos are missing
      // (proxy failure, transfer failure), the toast says it too — the
      // warnings are written as user-facing sentences; the plan-banner
      // lesson (v62.52) applied here: never blame a generic cause when the
      // response names the real one.
      // v62.60: an account-level verdict (credits gone, concurrency
      // saturated) outranks the per-tier symptom it caused.
      const failNote = serverWarnings.find((w) => /CREDITS EXHAUSTED|concurrency saturated/.test(w)) || serverWarnings[0] || "";
      setToast(
        finalPhotos.length > 0
          ? shortfallNote
            ? `Imported ${photos.length} photo${photos.length === 1 ? "" : "s"}${planNote}. ${shortfallNote}`
            : `Imported ${photos.length} photo${photos.length === 1 ? "" : "s"}${curatedNote}${planNote} — review and render.`
          : planNote
            ? `Listing details imported${planNote} — no usable photos, so add your own and render.`
            : failNote
              ? `Listing details imported, but the photos didn't make it: ${failNote}`
              : "Listing details imported — add your photos and render."
      );

      // v62.24: the diversity pass, off the critical path. Deliberately not
      // awaited — the import is already finished and the user is already
      // looking at their photos.
      // v62.46 intoProject: only curate when the imported set IS the whole
      // set — reordering a hand-mixed tray under the agent is worse than
      // not curating (and the staleness guards below already assume it).
      const importedIsWholeSet = useStore.getState().photos.map((p) => p.id).join(",") ===
        finalPhotos.map((p) => p.id).join(",");
      if (finalPhotos.length >= 8 && importedIsWholeSet) {
        const idsAtStart = finalPhotos.map((p) => p.id).join(",");
        const curation = curatePhotos({
          photos: finalPhotos.map((p) => ({ id: p.id, durableUrl: p.durableUrl, fileName: p.fileName }))
        })
          .then((cur) => {
            const s = useStore.getState();
            // v62.37 (audit): a render that started while we were resolving
            // CONSUMES the gate (ProjectScreen nulls pendingCuration after
            // its await) — applying the order now would reshuffle the grid
            // under an active render whose plan was already built. Gone or
            // replaced means someone else owns the photos now; drop it.
            if (s.pendingCuration !== curation) return;
            // Three ways this result is stale, and all of them mean drop it:
            // the user opened a different project, they changed the photo set
            // themselves, or the model gave us too little to be worth acting on.
            if (s.projectId !== projectId) return;
            if (s.photos.map((p) => p.id).join(",") !== idsAtStart) return;
            if (cur.status !== "ok" || !Array.isArray(cur.curated)) return;
            const keep = new Set(finalPhotos.map((p) => p.id));
            const order = [...cur.curated]
              .sort((a, b) => a.order - b.order)
              .map((c) => c.photoId)
              .filter((id) => keep.has(id));
            if (order.length < 6 || order.length === finalPhotos.length) return;
            // reorderPhotos takes a subset: it prunes and reorders in one
            // pass, and invalidates the edit plan so narration re-syncs.
            s.reorderPhotos(order);
            const dropped = finalPhotos.length - order.length;
            s.setToast(
              `Tour order set — kept the ${order.length} strongest` +
              (dropped > 0 ? `, set aside ${dropped} near-duplicate${dropped === 1 ? "" : "s"}.` : ".")
            );
          })
          .catch(() => { /* curation is a bonus, never a blocker */ })
          // v62.32: release the render gate whatever happened.
          .finally(() => {
            if (useStore.getState().pendingCuration === curation) useStore.getState().setPendingCuration(null);
          });
        // v62.32: renders started in the next ~60s wait on this.
        useStore.getState().setPendingCuration(curation);
      }
    } catch {
      setError("Import failed — try again or start manually.");
    } finally {
      useStore.getState().adjustMediaBusy(-1);
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
          <span className="block text-sm font-semibold tracking-tightish">Listing link — or just the address?</span>
          <span className="block text-xs text-ink-muted">{intoProject ? "Paste a Zillow/Redfin/Realtor link or type the address — everything lands in this project" : "Paste a Zillow/Redfin/Realtor link or type the address — we\u2019ll find the listing"}</span>
        </div>
        <div className="relative flex-1 min-w-0">
          <input
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") { setSuggestions([]); handleImport(); } }}
            placeholder="Listing link — or 4320 Floramar Terrace, New Port Richey FL"
            inputMode="text"
            autoComplete="off"
            className="w-full h-11 rounded-lg bg-surface-input border border-edge px-3 text-sm placeholder:text-ink-dim focus:border-gold outline-none"
          />
          {/* v62.96: address typeahead (Radar free tier). Renders only when
              results exist; picking one fills the field and closes the list.
              No key configured: this never renders and the band stays a
              plain field. */}
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-[46px] z-20 rounded-lg border border-edge bg-surface shadow-xl overflow-hidden">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    suppressSuggest.current = true;
                    setUrl(s);
                    setSuggestions([]);
                  }}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-surface-input text-ink-soft"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
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
