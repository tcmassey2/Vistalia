// Vistalia — listing-link auto-render (v57).
//
// The activation wall, measured Jul 23: ~190 leads → ~20 renders. Phone
// leads don't do desktop photo work. For leads who answered the Instant
// Form's "link to your current listing" question, this pass does the work
// for them: import the listing (address + photos, v52), plan it, and
// submit their FREE video on their behalf — through /api/render with the
// internal secret, so the tier machinery (watermark, 30s cap, trial
// accounting) runs exactly as if they clicked Generate. Their first
// Vistalia experience becomes "your video is ready," not "please upload."
//
// Runs on the worker (long-lived process — the import+plan sequence takes
// 30-70s, which no serverless budget tolerates). One lead per tick,
// claim-first on auto_render_at so restarts and concurrent workers never
// double-render.
//
// v62.63 RETRY-WITH-BACKOFF (Troy: "a system that recovers like that is
// important"). The Jul 27 ScraperAPI outage proved the old policy wrong:
// "a failed attempt is marked and never retried blindly" meant every lead
// that arrived during a 3-hour supplier outage was PERMANENTLY dead — the
// exact hours an ad campaign delivers leads are the hours a one-shot
// pipeline quietly buries them. Failures now split into two classes:
//   TRANSIENT (import came up short, plan fell back or 5xx'd, submit
//   5xx'd, any network exception) → retried up to 3 times at +15m, +1h,
//   +4h — a span sized to outlive a real supplier incident. Each retry
//   re-runs the WHOLE pipeline under a fresh projectId.
//   SEMANTIC (submit rejected 4xx: tier exhausted, validation) → terminal
//   immediately, exactly as before.
// Money guard unchanged: a render is only ever submitted after a live
// (non-fallback) plan, so retries re-spend import credits and plan
// tokens, never Veo money on a broken listing. Needs migration 38
// (auto_render_attempts + auto_render_next_at); without it the code
// detects the missing columns and degrades to the old one-shot behavior.
//
// Env: CRON_SECRET (shared internal secret), APP_URL, SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY. AUTO_RENDER_ENABLED=false disables.

const APP_URL = process.env.APP_URL || "https://vistalia.ai";
const TICK_MS = 90_000;
const IMPORT_TIMEOUT_MS = 60_000;
const PLAN_TIMEOUT_MS = 75_000;
// Backoff per retry number. Sized to a real outage: the Jul 27 ScraperAPI
// incident ran 3+ hours — +15m catches a blip, +1h a rough patch, +4h a
// full incident.
const RETRY_BACKOFF_MIN = [15, 60, 240];
const MAX_RETRIES = RETRY_BACKOFF_MIN.length;
// v62.93 (Teri Kelly / 4320 Floramar): trial URL renders ship MUSIC-ONLY
// by default — the visual pipeline is verified scene-by-scene, but the
// narration engine still invents features ("panoramic water views" over a
// washer/dryer kitchen), and one wrong sentence costs more agent trust
// than no voice at all. Default ON; set LEAD_RENDERS_VOICELESS=0 on the
// worker to restore narration the moment the quality bar is met.
const LEAD_RENDERS_VOICELESS = String(process.env.LEAD_RENDERS_VOICELESS || "1") === "1";
let retryColumnsMissing = false; // set on first PGRST error naming them

function rest() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function markStatus(supabaseUrl, leadId, patch) {
  await fetch(`${supabaseUrl}/rest/v1/meta_leads?lead_id=eq.${encodeURIComponent(leadId)}`, {
    method: "PATCH",
    headers: { ...rest(), Prefer: "return=minimal" },
    body: JSON.stringify(patch)
  }).catch(() => {});
}

// v62.63: like markStatus, but reports success — the retry mark must know
// whether it landed (migration 38 columns may not exist yet).
async function markStatusChecked(supabaseUrl, leadId, patch) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/meta_leads?lead_id=eq.${encodeURIComponent(leadId)}`, {
      method: "PATCH",
      headers: { ...rest(), Prefer: "return=minimal" },
      body: JSON.stringify(patch)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (/auto_render_attempts|auto_render_next_at/i.test(detail)) retryColumnsMissing = true;
    }
    return res.ok;
  } catch {
    return false;
  }
}

/* v62.63: one exit for every failure. Transient failures schedule a
   bounded retry; semantic rejections (and exhausted retries) go terminal
   with the same failed:* statuses the nudge flow has always seen. If the
   migration-38 columns are missing, the retry mark fails, we say so once,
   and the lead goes terminal — byte-for-byte the pre-retry behavior. */
async function failOrRetry(supabaseUrl, lead, reason, { retryable }) {
  const attempts = Number(lead.auto_render_attempts || 0);
  const shortReason = String(reason).slice(0, 70);
  if (retryable && !retryColumnsMissing && attempts < MAX_RETRIES) {
    const delayMin = RETRY_BACKOFF_MIN[attempts];
    const ok = await markStatusChecked(supabaseUrl, lead.lead_id, {
      auto_render_status: `retry:${shortReason}`,
      auto_render_attempts: attempts + 1,
      auto_render_next_at: new Date(Date.now() + delayMin * 60_000).toISOString()
    });
    if (ok) {
      console.warn(`[auto-render] ${lead.lead_id} ${shortReason} — transient; retry ${attempts + 1}/${MAX_RETRIES} in ${delayMin}m.`);
      return;
    }
    if (retryColumnsMissing) console.warn("[auto-render] retry columns missing — run migration 38; falling back to one-shot behavior.");
  }
  await markStatus(supabaseUrl, lead.lead_id, { auto_render_status: `failed:${shortReason}` });
  console.warn(
    `[auto-render] ${lead.lead_id} ${shortReason} — terminal` +
    (retryable && attempts > 0 ? ` after ${attempts} retr${attempts === 1 ? "y" : "ies"}` : "") +
    `; lead stays in the normal nudge flow.`
  );
}

// Mirrors the webapp's plan→manifest mapping (ProjectScreen ~2312) with
// the lead's identity and imported listing. Deliberately shares the shape
// with canary.mjs — if the webapp mapping changes, update all three.
function buildManifest({ userId, projectId, address, facts, photos, editPlan }) {
  return {
    app: "Vistalia",
    engine: "veo",
    exportFormat: "vertical",
    // v62.37 (audit): lead renders are 30s by design; without the field the
    // worker's duration contract can't hold them to it.
    targetDurationSec: 30,
    autoRendered: true,
    project: {
      id: projectId,
      userId,
      title: address?.display || address?.line || "Your listing",
      address: address?.line || "",
      city: [address?.city, address?.state].filter(Boolean).join(", "),
      price: facts?.price || "",
      beds: facts?.beds ?? null,
      baths: facts?.baths ?? null,
      squareFeet: facts?.squareFeet ?? null,
      hook: ""
    },
    scenes: editPlan.scenes.map((scene) => {
      const photo = photos.find((p) => p.id === scene.photoId) || null;
      return {
        photoId: scene.photoId,
        type: "photo",
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
        veoPrompt: scene.veoPrompt,
        narrationLine: scene.narrationLine || ""
      };
    }),
    orderedPhotos: photos,
    promptVersion: editPlan.promptVersion || null,
    introCard: editPlan.introCard,
    outroCard: editPlan.outroCard,
    // v62.80 — THE MISSING SPINE. buildManifest copied the plan field by
    // field and simply never carried `narration`, so every auto-rendered
    // lead video reached the worker without a monologue and logged
    // "[voice-first] manifest carries no narration.monologue (pre-v62
    // plan) — legacy voice path." Two visible consequences, both reported
    // by Troy on the Jul 31 batch: (1) THE ADDRESS WAS NEVER SPOKEN — the
    // v62 plan prompt mandates the street address as the monologue's
    // opening sentence ("the spoken address is the one sentence every
    // listing video must carry"), and that sentence lives ONLY in the
    // monologue; the legacy per-scene narrationLine path has no such
    // requirement. (2) THE VOICE SOUNDED STRANGE — the legacy path speaks
    // disconnected per-scene fragments (18-37 words against a ~74-word
    // 30s budget) with no arc, no connective transitions and no [warm]/
    // [pause] delivery tags, so it reads as clipped and robotic.
    // The plan endpoint was building the monologue correctly the whole
    // time; the manifest just dropped it on the floor.
    // v62.93 voiceless default: null narration + skipNarration keep the
    // worker on the music-only master; captions derive from narration so
    // they go dark together. The v62.80 spine still carries the monologue
    // whenever LEAD_RENDERS_VOICELESS=0 flips voice back on.
    narration: LEAD_RENDERS_VOICELESS ? null : (editPlan.narration || null),
    narrationScript: LEAD_RENDERS_VOICELESS ? "" : (editPlan.narrationScript || ""),
    musicMood: editPlan.musicMood,
    musicTrack: "",
    skipMusic: false,
    musicBedLevel: 0.22,
    selectedStyle: "Cinematic Luxury",
    runwayConfig: { ...(editPlan.runwayConfig || {}), useCrossfades: true },
    brandKit: null,
    organizationId: null,
    skipNarration: LEAD_RENDERS_VOICELESS,
    hallucinationGuard: "balanced",
    includeSquare: false,
    captionsEnabled: !LEAD_RENDERS_VOICELESS,
    finishOptions: { blueHourCorrection: true }
  };
}

async function processOne() {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const secret = process.env.CRON_SECRET || "";
  if (!supabaseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY || !secret) return;

  // One pending lead: fresh first (has a listing link, has an account,
  // never attempted), else the earliest DUE retry (v62.63).
  const attemptsCol = retryColumnsMissing ? "" : ",auto_render_attempts";
  let listRes = await fetch(
    `${supabaseUrl}/rest/v1/meta_leads?select=lead_id,email,user_id,listing_url${attemptsCol}` +
      `&listing_url=not.is.null&user_id=not.is.null&auto_render_at=is.null&order=created_time.asc&limit=1`,
    { headers: rest() }
  );
  if (!listRes.ok) {
    const detail = await listRes.text().catch(() => "");
    if (/auto_render_attempts/i.test(detail)) {
      // Migration 38 not applied — remember, and re-run the legacy select.
      retryColumnsMissing = true;
      console.warn("[auto-render] retry columns missing — run migration 38; one-shot behavior until then.");
      listRes = await fetch(
        `${supabaseUrl}/rest/v1/meta_leads?select=lead_id,email,user_id,listing_url` +
          `&listing_url=not.is.null&user_id=not.is.null&auto_render_at=is.null&order=created_time.asc&limit=1`,
        { headers: rest() }
      );
      if (!listRes.ok) return;
    } else {
      if (/listing_url|auto_render/i.test(detail)) {
        console.warn("[auto-render] columns missing — run migration 34.");
      }
      return;
    }
  }
  const rows = await listRes.json().catch(() => []);
  let lead = Array.isArray(rows) ? rows[0] : null;
  let claiming = null; // the claim predicate that must still hold

  if (lead) {
    claiming = `auto_render_at=is.null`;
  } else if (!retryColumnsMissing) {
    // v62.63: no fresh lead — pick the earliest retry whose clock has run.
    const dueRes = await fetch(
      `${supabaseUrl}/rest/v1/meta_leads?select=lead_id,email,user_id,listing_url,auto_render_attempts,auto_render_status` +
        `&auto_render_status=like.retry:*&auto_render_next_at=lte.${encodeURIComponent(new Date().toISOString())}` +
        `&order=auto_render_next_at.asc&limit=1`,
      { headers: rest() }
    );
    if (dueRes.ok) {
      const due = await dueRes.json().catch(() => []);
      lead = Array.isArray(due) ? due[0] : null;
      // Claim only if the status is still the exact retry:* we read —
      // a concurrent worker that claimed first changes it and our PATCH
      // matches zero rows.
      if (lead) claiming = `auto_render_status=eq.${encodeURIComponent(lead.auto_render_status)}`;
    }
  }
  if (!lead) return;

  // Claim first — concurrent workers and restarts can never double-run a
  // lead. (v62.63: retries are DELIBERATE now — bounded, backed off, and
  // only for transient failures; the old "never retried blindly" money
  // guard survives as the 4xx-is-terminal rule + the non-fallback plan
  // gate below, which is what actually protects Veo spend.)
  const claimRes = await fetch(
    `${supabaseUrl}/rest/v1/meta_leads?lead_id=eq.${encodeURIComponent(lead.lead_id)}&${claiming}`,
    {
      method: "PATCH",
      headers: { ...rest(), Prefer: "return=representation" },
      body: JSON.stringify({
        auto_render_at: new Date().toISOString(),
        auto_render_status: "claimed",
        ...(retryColumnsMissing ? {} : { auto_render_next_at: null })
      })
    }
  );
  const claimed = claimRes.ok ? await claimRes.json().catch(() => []) : [];
  if (!Array.isArray(claimed) || claimed.length === 0) return;

  console.info(`[auto-render] processing lead ${lead.lead_id} (${lead.email}) — ${lead.listing_url}`);
  // v58.3: MUST start with "project-" — import-listing validates
  // /^project-[A-Za-z0-9-]{6,64}$/ and 400s anything else. The original
  // "lead-…" ids made every auto-render import die in ~300ms (log:
  // "failed, 0 photos" with a sub-second turnaround = validation reject,
  // the proxy was never even reached).
  const projectId = `project-lead-${String(lead.lead_id).slice(-10)}-${Date.now()}`;

  try {
    // 0. v62.95 FREE-TEXT RESOLVE: a listing_url without a scheme is a
    // typed address or MLS number (meta-leads-sync now promotes those).
    // Turn it into a real listing URL via the fail-closed resolver before
    // the importer sees it. fetch_failed is transient (scraper flake —
    // retry lane); not_found is terminal (the address won't get better) —
    // the lead stays in the normal nudge/manual flow, exactly as today.
    let listingUrl = String(lead.listing_url || "").trim();
    if (listingUrl && !/^https?:\/\//i.test(listingUrl)) {
      const resv = await fetchJson(`${APP_URL}/api/resolve-listing`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify({ query: listingUrl })
      }, IMPORT_TIMEOUT_MS);
      if (resv.ok && resv.json?.status === "ok" && resv.json?.url) {
        console.info(`[auto-render] ${lead.lead_id} resolved "${listingUrl.slice(0, 50)}" → ${resv.json.url}`);
        listingUrl = resv.json.url;
      } else if (resv.ok && resv.json?.status === "fetch_failed") {
        await failOrRetry(supabaseUrl, lead, "resolve(fetch_failed)", { retryable: true });
        return;
      } else {
        await failOrRetry(supabaseUrl, lead, `resolve(${resv.json?.status || resv.status})`, { retryable: false });
        return;
      }
    }

    // 1. Import: address + facts + photos into THEIR storage.
    const imp = await fetchJson(`${APP_URL}/api/import-listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ url: listingUrl, projectId, onBehalfOfUserId: lead.user_id })
    }, IMPORT_TIMEOUT_MS);
    // v58.4: the import response photos are raw storage objects
    // ({fileName, publicUrl, storagePath, bucket, size}) — no id, no
    // durableUrl, no order. The planner keys scenes to photo.id and
    // render.js validates scenes against orderedPhotos by id + urls; the
    // WEBAPP assigns all of that client-side (DashboardScreen ~297).
    // Without the same mapping here, the first two leads that ever got
    // past import (Jul 23) died at submit: "scene 1 is not present in
    // orderedPhotos … 24 more issues". Mirror the webapp shape; dims use
    // the webapp's own probe-failure fallback (1024×1365) since the
    // worker has no cheap way to probe 20 remote images.
    let photos = (Array.isArray(imp.json?.photos) ? imp.json.photos : []).map((p, i) => ({
      id: `imported-${projectId}-${i}`,
      fileName: p.fileName,
      publicUrl: p.publicUrl,
      durableUrl: p.publicUrl,
      storagePath: p.storagePath,
      bucket: p.bucket,
      width: 1024,
      height: 1365,
      size: p.size,
      order: i,
      uploadedAt: new Date().toISOString()
    }));
    // v62.93 THUMBNAIL FILTER (Pryor: three of six scenes generated from
    // 576×432 thumbnails — every one of them burned QC retries and shipped
    // soft). Some scrapes return a mix of full-res photos and tiny
    // thumbnails; a <40KB JPEG is thumbnail-class and makes a mushy scene.
    // Drop small files ONLY when enough real photos remain — fail-open on
    // missing sizes and thin galleries.
    {
      const MIN_BYTES = Number(process.env.LEAD_PHOTO_MIN_BYTES || 40000);
      const sized = photos.filter((p) => Number(p.size) > 0);
      const large = photos.filter((p) => Number(p.size) >= MIN_BYTES);
      if (sized.length === photos.length && large.length >= 6 && large.length < photos.length) {
        console.info(`[auto-render] ${lead.lead_id} photo filter: dropped ${photos.length - large.length} thumbnail-class photo(s) (<${Math.round(MIN_BYTES / 1000)}KB) — ${large.length} full-res remain.`);
        photos = large.map((p, i) => ({ ...p, order: i }));
      }
    }
    if (!imp.ok || imp.json?.status !== "ok" || photos.length < 4) {
      // v62.63: the canonical transient — a proxy outage, a bot-wall loss,
      // a thin page. The Jul 27 evening was ALL this class.
      await failOrRetry(supabaseUrl, lead, `import(${imp.json?.status || imp.status},${photos.length}p)`, { retryable: true });
      return;
    }
    await markStatus(supabaseUrl, lead.lead_id, { auto_render_status: "imported" });

    // 2. Plan (live verify + polish + floor).
    const plan = await fetchJson(`${APP_URL}/api/create-edit-plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-canary-secret": secret,
        "x-on-behalf-user": lead.user_id
      },
      body: JSON.stringify({
        photos,
        listingDetails: {
          address: imp.json?.address?.line || "",
          city: [imp.json?.address?.city, imp.json?.address?.state].filter(Boolean).join(", "),
          ...(imp.json?.facts || {})
        },
        selectedStyle: "Cinematic Luxury",
        exportFormat: "vertical",
        engine: "veo",
        targetDurationSec: 30,
        // v62.93 (Troy, after the Floramar/Teri Kelly feedback): trial URL
        // renders default to MUSIC-ONLY until the narration quality bar is
        // met — an invented "panoramic water views" line costs more trust
        // than no voice at all. Flip LEAD_RENDERS_VOICELESS=0 on the worker
        // to restore narration with no deploy.
        includeNarration: !LEAD_RENDERS_VOICELESS
      })
    }, PLAN_TIMEOUT_MS);
    if (!plan.ok || !plan.json?.editPlan?.scenes?.length) {
      // 5xx/network = the plan service was down (transient). A 4xx means
      // the request itself is wrong — retrying replays the same rejection.
      await failOrRetry(supabaseUrl, lead, `plan(${plan.status})`, { retryable: !(plan.status >= 400 && plan.status < 500) });
      return;
    }
    // v60.1 (m77): a fallback plan is a stock-narration template that can
    // render every scene from the hero photo. A lead's FIRST impression
    // must never be that — better no auto-video (normal nudge flow) than
    // a template. v62.63: but a fallback is almost always a TRANSIENT
    // plan-side event (OpenAI 429/timeout, photo probe blip) — the plan is
    // free to retry (v60.1's own words); it's the RENDER that isn't. Retry
    // the pipeline; never render the template.
    if (plan.json?.status === "fallback") {
      await failOrRetry(supabaseUrl, lead, `plan-fallback(${plan.json?.errorCategory || "?"})`, { retryable: true });
      return;
    }

    // 3. Submit through the front door — tier machinery runs as the lead.
    const manifest = buildManifest({
      userId: lead.user_id,
      projectId,
      address: imp.json?.address,
      facts: imp.json?.facts,
      photos,
      editPlan: plan.json.editPlan
    });
    const sub = await fetchJson(`${APP_URL}/api/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ manifest })
    }, 30_000);
    if (!sub.ok || !sub.json?.jobId) {
      // A 4xx here is SEMANTIC — tier exhausted, free render already used,
      // manifest rejected — and retrying would replay the same rejection
      // (or worse, double-spend a freshly-freed credit). Terminal. 5xx and
      // network failures are the queue having a moment; those retry.
      await failOrRetry(
        supabaseUrl, lead,
        `submit(${sub.status},${String(sub.json?.error || "").slice(0, 40)})`,
        { retryable: !(sub.status >= 400 && sub.status < 500) }
      );
      return;
    }

    await markStatus(supabaseUrl, lead.lead_id, {
      auto_render_status: "submitted",
      auto_render_job_id: String(sub.json.jobId)
    });
    console.info(`[auto-render] lead ${lead.lead_id} → job ${sub.json.jobId} (${photos.length} photos, ${plan.json.editPlan.scenes.length} scenes${LEAD_RENDERS_VOICELESS ? ", VOICELESS — music-only" : ""}). Render-complete email will deliver it.`);
  } catch (err) {
    // Exceptions here are aborts and network deaths — transient by nature.
    await failOrRetry(supabaseUrl, lead, `exception(${String(err.message).slice(0, 40)})`, { retryable: true });
  }
}

// Test seam: the retry state machine, without the pipeline around it.
export const __testFailOrRetry = failOrRetry;
export const __testRetrySchedule = { RETRY_BACKOFF_MIN, MAX_RETRIES };

export function startAutoRenderClock() {
  if (String(process.env.AUTO_RENDER_ENABLED || "").toLowerCase() === "false") return;
  if (!process.env.SUPABASE_URL || !process.env.CRON_SECRET) return;
  console.info(`[auto-render] listing-link clock ON → every ${Math.round(TICK_MS / 1000)}s`);
  setInterval(() => { processOne().catch((e) => console.warn(`[auto-render] tick error: ${e.message}`)); }, TICK_MS).unref();
}
