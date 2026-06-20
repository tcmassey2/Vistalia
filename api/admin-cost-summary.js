// Vistalia — /api/admin-cost-summary
//
// Daily Runway + Replicate + OpenAI cost rollup, restricted to admin
// users (defined by the ADMIN_USER_IDS env var, comma-separated Supabase
// user IDs).
//
// Cost model — estimated, not invoiced:
//   Runway Gen-4 Turbo ≈ $0.05 / generated second.
//     - Quick Reel: 0 (no Runway calls)
//     - Cinematic AI: avg 5s per scene × scenes_count → seconds × $0.05
//   Depth engine (Replicate, Phase 1):
//     depth-anything-v2 Large: ~$0.003 per scene (DEPTH_DOLLARS_PER_SCENE)
//   Depth engine (Replicate, Phase 2 inpaint, when enabled):
//     LaMa per-frame: ~$0.00015 × ~80 frames after gap-skip filter
//     ≈ $0.012 per scene → DEPTH_INPAINT_DOLLARS_PER_SCENE
//   OpenAI gpt-4.1-mini Vision: ~$0.002 per low-detail image. Each render
//     uses ~12 images for the edit plan + ~50 for AI curation (when used).
//     Approximate at $0.05 per render.
//
// Returns last 30 days bucketed by date, plus a current-month total
// and the configured monthly budget for an at-a-glance % consumption.

const RUNWAY_DOLLARS_PER_SECOND = 0.05;
const SECONDS_PER_RUNWAY_SCENE = 5;
const OPENAI_DOLLARS_PER_RENDER = 0.05;
const DEPTH_DOLLARS_PER_SCENE = 0.003;
const DEPTH_INPAINT_DOLLARS_PER_SCENE = 0.012;

export default async function handler(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "GET") return response.status(405).json({ error: "Use GET." });

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return response.status(503).json({ error: "Cost summary not configured." });
  }

  // Admin gate.
  const userId = await verifyUserId(request, supabaseUrl, anonKey);
  if (!userId) return response.status(401).json({ error: "Sign in required." });
  const adminIds = (process.env.ADMIN_USER_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!adminIds.includes(userId)) {
    return response.status(403).json({ error: "Admin only." });
  }

  // Pull the last 30 days of audit-log rows. We aggregate in-process
  // because the dataset is small (a busy month is ~3,000 rows max).
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const auditRes = await fetch(
    `${supabaseUrl}/rest/v1/render_audit_log?created_at=gte.${encodeURIComponent(cutoff)}&select=created_at,engine,scenes`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  if (!auditRes.ok) {
    const detail = await auditRes.text().catch(() => "");
    return response.status(500).json({ error: "Audit fetch failed", detail: detail.slice(0, 200) });
  }
  const rows = await auditRes.json().catch(() => []);

  const byDay = {};
  let totalRunwayCents = 0;
  let totalDepthCents = 0;
  let totalOpenAiCents = 0;
  let totalRenders = 0;
  let runwayRenders = 0;
  let depthRenders = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const day = String(row.created_at || "").slice(0, 10); // YYYY-MM-DD
    if (!day) continue;
    const sceneCount = Array.isArray(row.scenes) ? row.scenes.length : 0;
    const aiSceneCount = Array.isArray(row.scenes)
      ? row.scenes.filter((s) => !s.wasFallback).length // wasFallback=true → Ken Burns, not AI
      : sceneCount;

    let runwayCost = 0;
    let depthCost = 0;
    if (row.engine === "runway") {
      runwayCost = aiSceneCount * SECONDS_PER_RUNWAY_SCENE * RUNWAY_DOLLARS_PER_SECOND;
    } else if (row.engine === "depth") {
      // depth-anything-v2 fires per AI scene (skipped for flat-depth Ken Burns
      // fallback scenes). If any audit row's enginePhase indicates inpaint
      // we add the per-scene LaMa cost on top.
      depthCost = aiSceneCount * DEPTH_DOLLARS_PER_SCENE;
      if (row.scenes?.some?.((s) => String(s.enginePhase || "").includes("inpaint"))) {
        depthCost += aiSceneCount * DEPTH_INPAINT_DOLLARS_PER_SCENE;
      }
    }
    const openAiCost = OPENAI_DOLLARS_PER_RENDER;

    if (!byDay[day]) byDay[day] = { date: day, renders: 0, runwayCents: 0, depthCents: 0, openAiCents: 0 };
    byDay[day].renders++;
    byDay[day].runwayCents += Math.round(runwayCost * 100);
    byDay[day].depthCents += Math.round(depthCost * 100);
    byDay[day].openAiCents += Math.round(openAiCost * 100);

    totalRenders++;
    if (row.engine === "runway") runwayRenders++;
    if (row.engine === "depth") depthRenders++;
    totalRunwayCents += Math.round(runwayCost * 100);
    totalDepthCents += Math.round(depthCost * 100);
    totalOpenAiCents += Math.round(openAiCost * 100);
  }

  const today = new Date().toISOString().slice(0, 10);
  const startOfMonth = today.slice(0, 8) + "01";
  const monthRows = Object.values(byDay).filter((d) => d.date >= startOfMonth);
  const monthRunwayCents = monthRows.reduce((s, d) => s + d.runwayCents, 0);
  const monthDepthCents = monthRows.reduce((s, d) => s + d.depthCents, 0);
  const monthOpenAiCents = monthRows.reduce((s, d) => s + d.openAiCents, 0);
  const monthBudgetCents = Number(process.env.MONTHLY_COST_BUDGET_CENTS || 50_000); // $500 default
  const monthSpentCents = monthRunwayCents + monthDepthCents + monthOpenAiCents;

  return response.status(200).json({
    summary: {
      windowDays: 30,
      totalRenders,
      runwayRenders,
      depthRenders,
      kenBurnsRenders: totalRenders - runwayRenders - depthRenders,
      totalRunwayCents,
      totalDepthCents,
      totalOpenAiCents,
      totalCents: totalRunwayCents + totalDepthCents + totalOpenAiCents
    },
    currentMonth: {
      monthStart: startOfMonth,
      runwayCents: monthRunwayCents,
      depthCents: monthDepthCents,
      openAiCents: monthOpenAiCents,
      spentCents: monthSpentCents,
      budgetCents: monthBudgetCents,
      pctOfBudget: Math.round((monthSpentCents / Math.max(1, monthBudgetCents)) * 100)
    },
    daily: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
    note: "Estimates. Runway: $0.05/generated-second. Depth: $0.003/scene + $0.012/scene if inpainted. OpenAI: ~$0.05/render. Reconcile with the actual Runway + Replicate + OpenAI dashboards monthly."
  });
}

async function verifyUserId(request, supabaseUrl, anonKey) {
  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return "";
  const token = auth.slice(7);
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return "";
  const data = await res.json().catch(() => ({}));
  return data?.id || "";
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
