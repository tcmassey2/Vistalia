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
// double-render. Every failure marks auto_render_status and leaves the
// lead in the normal nudge flow — fail-open, never fail-loud.
//
// Env: CRON_SECRET (shared internal secret), APP_URL, SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY. AUTO_RENDER_ENABLED=false disables.

const APP_URL = process.env.APP_URL || "https://vistalia.ai";
const TICK_MS = 90_000;
const IMPORT_TIMEOUT_MS = 60_000;
const PLAN_TIMEOUT_MS = 75_000;

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

// Mirrors the webapp's plan→manifest mapping (ProjectScreen ~2312) with
// the lead's identity and imported listing. Deliberately shares the shape
// with canary.mjs — if the webapp mapping changes, update all three.
function buildManifest({ userId, projectId, address, facts, photos, editPlan }) {
  return {
    app: "Vistalia",
    engine: "veo",
    exportFormat: "vertical",
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
    narrationScript: editPlan.narrationScript || "",
    musicMood: editPlan.musicMood,
    musicTrack: "",
    skipMusic: false,
    musicBedLevel: 0.22,
    selectedStyle: "Cinematic Luxury",
    runwayConfig: { ...(editPlan.runwayConfig || {}), useCrossfades: true },
    brandKit: null,
    organizationId: null,
    skipNarration: false,
    hallucinationGuard: "balanced",
    includeSquare: false,
    captionsEnabled: true,
    finishOptions: { blueHourCorrection: true }
  };
}

async function processOne() {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const secret = process.env.CRON_SECRET || "";
  if (!supabaseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY || !secret) return;

  // One pending lead: has a listing link, has an account, never attempted.
  const listRes = await fetch(
    `${supabaseUrl}/rest/v1/meta_leads?select=lead_id,email,user_id,listing_url` +
      `&listing_url=not.is.null&user_id=not.is.null&auto_render_at=is.null&order=created_time.asc&limit=1`,
    { headers: rest() }
  );
  if (!listRes.ok) {
    const detail = await listRes.text().catch(() => "");
    if (/listing_url|auto_render/i.test(detail)) {
      console.warn("[auto-render] columns missing — run migration 34.");
    }
    return;
  }
  const rows = await listRes.json().catch(() => []);
  const lead = Array.isArray(rows) ? rows[0] : null;
  if (!lead) return;

  // Claim first — a failed attempt is marked and never retried blindly
  // (a stuck retry loop would burn Veo money on a broken listing page).
  const claimRes = await fetch(
    `${supabaseUrl}/rest/v1/meta_leads?lead_id=eq.${encodeURIComponent(lead.lead_id)}&auto_render_at=is.null`,
    {
      method: "PATCH",
      headers: { ...rest(), Prefer: "return=representation" },
      body: JSON.stringify({ auto_render_at: new Date().toISOString(), auto_render_status: "claimed" })
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
    // 1. Import: address + facts + photos into THEIR storage.
    const imp = await fetchJson(`${APP_URL}/api/import-listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ url: lead.listing_url, projectId, onBehalfOfUserId: lead.user_id })
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
    const photos = (Array.isArray(imp.json?.photos) ? imp.json.photos : []).map((p, i) => ({
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
    if (!imp.ok || imp.json?.status !== "ok" || photos.length < 4) {
      await markStatus(supabaseUrl, lead.lead_id, { auto_render_status: `failed:import(${imp.json?.status || imp.status},${photos.length}p)` });
      console.warn(`[auto-render] import failed for ${lead.lead_id}: ${imp.json?.status || imp.status}, ${photos.length} photos — lead stays in the normal nudge flow.`);
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
        targetDurationSec: 30
      })
    }, PLAN_TIMEOUT_MS);
    if (!plan.ok || !plan.json?.editPlan?.scenes?.length) {
      await markStatus(supabaseUrl, lead.lead_id, { auto_render_status: `failed:plan(${plan.status})` });
      console.warn(`[auto-render] plan failed for ${lead.lead_id}: HTTP ${plan.status}`);
      return;
    }
    // v60.1 (m77): a fallback plan is a stock-narration template that can
    // render every scene from the hero photo. A lead's FIRST impression
    // must never be that — better no auto-video (normal nudge flow) than
    // a template. Not retried blindly; the claim stands.
    if (plan.json?.status === "fallback") {
      await markStatus(supabaseUrl, lead.lead_id, { auto_render_status: "failed:plan(fallback)" });
      console.warn(`[auto-render] plan FELL BACK for ${lead.lead_id} (${plan.json?.errorCategory || "?"}) — not rendering a template; lead stays in the nudge flow.`);
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
      await markStatus(supabaseUrl, lead.lead_id, { auto_render_status: `failed:submit(${sub.status},${String(sub.json?.error || "").slice(0, 60)})` });
      console.warn(`[auto-render] submit failed for ${lead.lead_id}: HTTP ${sub.status} ${sub.json?.error || ""}`);
      return;
    }

    await markStatus(supabaseUrl, lead.lead_id, {
      auto_render_status: "submitted",
      auto_render_job_id: String(sub.json.jobId)
    });
    console.info(`[auto-render] lead ${lead.lead_id} → job ${sub.json.jobId} (${photos.length} photos, ${plan.json.editPlan.scenes.length} scenes). Render-complete email will deliver it.`);
  } catch (err) {
    await markStatus(supabaseUrl, lead.lead_id, { auto_render_status: `failed:${String(err.message).slice(0, 60)}` });
    console.warn(`[auto-render] failed open for ${lead.lead_id}: ${err.message}`);
  }
}

export function startAutoRenderClock() {
  if (String(process.env.AUTO_RENDER_ENABLED || "").toLowerCase() === "false") return;
  if (!process.env.SUPABASE_URL || !process.env.CRON_SECRET) return;
  console.info(`[auto-render] listing-link clock ON → every ${Math.round(TICK_MS / 1000)}s`);
  setInterval(() => { processOne().catch((e) => console.warn(`[auto-render] tick error: ${e.message}`)); }, TICK_MS).unref();
}
