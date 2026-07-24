// Vistalia — canary render (v56).
//
// "Every time we fix one thing it breaks 2 other things" — because
// customers sometimes saw a deploy before we did (Jeff got m67 before
// anyone had watched a v50b render). This module closes that gap: on the
// FIRST boot of a new deploy, the worker fires exactly one internal
// render of the fixed p1-signature photoset through the entire live
// chain — planner (verify + polish + floor), Veo, QC, sweep, stitch,
// mixer, captions — and emails the founder a [CANARY] link to gate
// before real traffic exercises the new code.
//
// Design constraints, in order:
//   1. NEVER break boot. Everything is fail-open behind one try/catch;
//      a canary failure is a warning log, not a worker outage.
//   2. Exactly once per deploy. Keyed on RENDER_GIT_COMMIT (set by the
//      Render platform) against the single-row canary_state table
//      (migration 33). The claim is an atomic conditional PATCH, so two
//      workers booting the same commit race safely; daily SIGTERM
//      restarts of the SAME commit never re-fire.
//   3. Zero customer surface. manifest.internal=true → audit row marked
//      internal (founder metrics exclude it), notify email goes to the
//      founder with a [CANARY] subject, no watermark/tier machinery runs
//      (the job is enqueued directly, not through /api/render).
//
// Env:
//   CANARY_ENABLED   default on; "false" disables.
//   RENDER_GIT_COMMIT provided by Render; absent locally → no-op.
//   CRON_SECRET      shared secret for the planner call (x-canary-secret).
//   CANARY_USER_ID   optional profile to attribute the render to.

const APP_URL = process.env.APP_URL || "https://vistalia.ai";

const CANARY_PHOTOS = [
  "01-exterior-twilight", "02-entry-loggia", "03-great-room", "04-kitchen",
  "05-dining", "06-primary-bedroom", "07-primary-bath", "08-study",
  "09-courtyard", "10-pool-twilight", "11-ramada", "12-hallway"
].map((name, i) => {
  // v58.3: showcase/photosets/**/*.png is GITIGNORED (107MB of masters) so
  // those URLs 404 in production — the first live canary died on it, every
  // scene "Download failed (404)". showcase/canary/*.jpg is the deployable
  // web-weight copy (~9MB total, committed).
  const url = `${APP_URL}/showcase/canary/${name}.jpg`;
  return {
    id: `canary-${String(i + 1).padStart(2, "0")}`,
    publicUrl: url,
    durableUrl: url,
    fileName: `${name}.jpg`,
    width: 2400,
    height: 1792,
    category: ""
  };
});

const CANARY_LISTING = {
  address: "1000 Canary Court",
  city: "Scottsdale, AZ",
  price: "",
  beds: 4,
  baths: 3,
  squareFeet: 3800,
  hook: ""
};

function restHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

// Atomic once-per-commit claim. Returns true only for the one invocation
// that flips canary_state.last_commit to this commit.
async function claimCommit(supabaseUrl, commit) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/canary_state?id=eq.1&or=(last_commit.is.null,last_commit.neq.${encodeURIComponent(commit)})`,
    {
      method: "PATCH",
      headers: { ...restHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ last_commit: commit, updated_at: new Date().toISOString() })
    }
  );
  if (!res.ok) {
    // 404/400 most likely means migration 33 hasn't run — say so once.
    console.warn(`[canary] claim failed HTTP ${res.status} — has migration 33 run?`);
    return false;
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function fetchCanaryPlan() {
  const res = await fetch(`${APP_URL}/api/create-edit-plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-canary-secret": process.env.CRON_SECRET || ""
    },
    body: JSON.stringify({
      photos: CANARY_PHOTOS,
      listingDetails: CANARY_LISTING,
      selectedStyle: "Cinematic Luxury",
      exportFormat: "vertical",
      engine: "veo",
      targetDurationSec: 30,
      musicTrack: "luxury-poradovskyi.mp3"
    })
  });
  if (!res.ok) throw new Error(`planner HTTP ${res.status}`);
  const payload = await res.json().catch(() => ({}));
  if (!payload?.editPlan?.scenes?.length) throw new Error(payload?.reason || "planner returned no scenes");
  // v60.1 (m77): a fallback plan would false-green the deploy gate — the
  // canary must validate the REAL planning path, not the template. Abort
  // loudly; a missing [CANARY] email after a deploy is itself the signal.
  if (payload?.status === "fallback") {
    throw new Error(`planner FELL BACK (${payload?.errorCategory || "?"}) — canary aborted, deploy gate not validated`);
  }
  return payload.editPlan;
}

// Mirrors the webapp's plan→manifest mapping (ProjectScreen ~2312) minus
// user-specific toggles. If that mapping grows a field the canary lacks,
// the render exercises the worker's defaults — which is itself signal.
function buildCanaryManifest(editPlan, commit) {
  const projectId = `canary-${commit.slice(0, 8)}`;
  return {
    app: "Vistalia",
    engine: "veo",
    exportFormat: "vertical",
    internal: true,
    project: {
      id: projectId,
      userId: process.env.CANARY_USER_ID || null,
      title: "Canary — p1-signature",
      ...CANARY_LISTING
    },
    scenes: editPlan.scenes.map((scene) => {
      const photo = CANARY_PHOTOS.find((p) => p.id === scene.photoId) || null;
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
    orderedPhotos: CANARY_PHOTOS,
    promptVersion: editPlan.promptVersion || null,
    introCard: editPlan.introCard,
    outroCard: editPlan.outroCard,
    narrationScript: editPlan.narrationScript || "",
    // v62 VOICE-FIRST: the canary is the deploy gate for the inversion —
    // it must carry the monologue so [voice-first] lines appear in its log.
    narration: editPlan.narration || null,
    musicMood: editPlan.musicMood,
    musicTrack: "luxury-poradovskyi.mp3",
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

export async function runCanaryOnBoot() {
  try {
    if (String(process.env.CANARY_ENABLED || "").toLowerCase() === "false") return;
    const commit = String(process.env.RENDER_GIT_COMMIT || "").trim();
    const supabaseUrl = process.env.SUPABASE_URL || "";
    if (!commit || !supabaseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
    if (!process.env.CRON_SECRET) {
      console.warn("[canary] CRON_SECRET unset — cannot call planner; canary disabled.");
      return;
    }

    const claimed = await claimCommit(supabaseUrl, commit);
    if (!claimed) return; // same commit already canary'd (restart), or raced

    console.info(`[canary] new deploy ${commit.slice(0, 8)} — firing canary render (p1-signature, 12 photos).`);
    const editPlan = await fetchCanaryPlan();
    const manifest = buildCanaryManifest(editPlan, commit);
    const jobId = `${manifest.project.id}-${Date.now()}`;

    const res = await fetch(`${supabaseUrl}/rest/v1/render_jobs`, {
      method: "POST",
      headers: { ...restHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({
        job_id: jobId,
        user_id: process.env.CANARY_USER_ID || null,
        status: "queued",
        phase: "Queued",
        progress: 3,
        manifest: { userId: process.env.CANARY_USER_ID || undefined, manifest },
        attempts: 0,
        error: null
      })
    });
    if (!res.ok) throw new Error(`enqueue HTTP ${res.status}`);
    console.info(`[canary] enqueued ${jobId} — polish=${editPlan.narrationPolish || "?"} guard=${JSON.stringify(editPlan.narrationGuard || {})}`);
  } catch (err) {
    console.warn(`[canary] failed open: ${err.message} — deploy proceeds without a canary.`);
  }
}
