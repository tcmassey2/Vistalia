// Diagnostic endpoint for Vistalia deployment readiness.
// Hit GET /api/health on the deployed site to see exactly which subsystems are
// configured. Designed to be the first thing you check when something looks broken.
//
// Returns JSON with three sections:
//   - mode: which MOCK flags are currently active
//   - subsystems: per-subsystem readiness with the specific env var that's missing
//   - workerCheck: live HEAD probe of RENDER_WORKER_URL/health if set
//
// Never leaks secret values. Reports presence/absence only.

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Allow-Origin", "*");

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";
  const renderWorkerUrl = process.env.RENDER_WORKER_URL || process.env.RENDER_ENDPOINT || "";
  const renderSecret = process.env.RENDER_WEBHOOK_SECRET || process.env.RENDER_WORKER_SECRET || "";
  const stripeKey = process.env.STRIPE_SECRET_KEY || "";
  const runwayKey = process.env.RUNWAY_API_KEY || "";

  const subsystems = {
    supabase: {
      ready: Boolean(supabaseUrl && supabaseAnonKey),
      missing: missingList({ SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: supabaseAnonKey }),
      note: supabaseServiceKey ? "Service role key present (worker uploads enabled)." : "SUPABASE_SERVICE_ROLE_KEY not set on Vercel — that's normal; it's only required on the render worker host."
    },
    openaiMotionDirector: {
      ready: Boolean(openaiKey),
      missing: openaiKey ? [] : ["OPENAI_API_KEY"],
      note: openaiKey ? "OpenAI Vision available for live edit-plan generation." : "Without this key, /api/create-edit-plan falls back to deterministic plans."
    },
    renderWorker: {
      ready: Boolean(renderWorkerUrl),
      missing: missingList({ RENDER_WORKER_URL: renderWorkerUrl }),
      secretConfigured: Boolean(renderSecret),
      url: renderWorkerUrl ? maskUrl(renderWorkerUrl) : "",
      note: renderWorkerUrl ? "Worker URL is configured." : "No render worker URL — /api/render will return 'rendering not connected'."
    },
    runway: {
      ready: Boolean(runwayKey),
      missing: runwayKey ? [] : ["RUNWAY_API_KEY"],
      note: runwayKey ? "Runway image-to-video tier available." : "Cinematic AI tier disabled until RUNWAY_API_KEY is set on the render worker host."
    },
    stripe: {
      ready: Boolean(stripeKey),
      missing: stripeKey ? [] : ["STRIPE_SECRET_KEY"],
      note: stripeKey ? "Stripe billing configured." : "Paid tiers disabled until Stripe is configured."
    }
  };

  const mode = {
    MOCK_AI: !subsystems.openaiMotionDirector.ready || isExplicitlyMocked("MOCK_AI"),
    MOCK_RENDERING: !subsystems.renderWorker.ready || isExplicitlyMocked("MOCK_RENDERING"),
    MOCK_SUPABASE: !subsystems.supabase.ready || isExplicitlyMocked("MOCK_SUPABASE"),
    MOCK_STRIPE: !subsystems.stripe.ready || isExplicitlyMocked("MOCK_STRIPE")
  };

  let workerCheck = { attempted: false };
  if (renderWorkerUrl) {
    workerCheck = await probeWorkerHealth(renderWorkerUrl);
  }

  const productionReady =
    subsystems.supabase.ready &&
    subsystems.openaiMotionDirector.ready &&
    subsystems.renderWorker.ready &&
    workerCheck.ok !== false;

  const summary = productionReady
    ? "All required subsystems configured. Live rendering should work."
    : describeBlockers(subsystems, workerCheck);

  response.status(200).json({
    productionReady,
    summary,
    mode,
    subsystems,
    workerCheck,
    runtime: {
      node: process.version,
      vercelEnv: process.env.VERCEL_ENV || "unknown",
      region: process.env.VERCEL_REGION || "unknown",
      timestamp: new Date().toISOString()
    }
  });
}

function missingList(map) {
  return Object.entries(map)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function isExplicitlyMocked(key) {
  const value = process.env[key];
  if (value === undefined || value === null || value === "") return false;
  return value === "true" || value === "1";
}

function maskUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "[unparsable URL]";
  }
}

async function probeWorkerHealth(url) {
  const base = url.endsWith("/") ? url.slice(0, -1) : url;
  const probeUrl = base.endsWith("/render") ? `${base.replace(/\/render$/, "")}/health` : `${base}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(probeUrl, { method: "GET", signal: controller.signal });
    clearTimeout(timeout);
    return {
      attempted: true,
      ok: res.ok,
      status: res.status,
      probedUrl: probeUrl
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      attempted: true,
      ok: false,
      error: error.message || "Worker health probe failed.",
      probedUrl: probeUrl,
      hint: "If this says 'fetch failed' or times out, the render worker is not reachable. Check that it's deployed and that RENDER_WORKER_URL points to its public hostname."
    };
  }
}

function describeBlockers(subsystems, workerCheck) {
  const blockers = [];
  if (!subsystems.supabase.ready) blockers.push(`Supabase missing: ${subsystems.supabase.missing.join(", ")}`);
  if (!subsystems.openaiMotionDirector.ready) blockers.push("OPENAI_API_KEY not set");
  if (!subsystems.renderWorker.ready) blockers.push("RENDER_WORKER_URL not set");
  if (subsystems.renderWorker.ready && workerCheck && workerCheck.ok === false) {
    blockers.push(`Render worker unreachable at ${workerCheck.probedUrl} (${workerCheck.error || `HTTP ${workerCheck.status}`})`);
  }
  return blockers.length ? `Blocked: ${blockers.join("; ")}.` : "Configuration valid.";
}
