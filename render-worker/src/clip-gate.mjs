// Vistalia — measured clip gate (v64.2). Node side of tools/clip-gate.py.
//
// The QC ladder's verdicts come from a vision model looking at four frames;
// it cannot see a 37% push, a wall morphing between samples, or exposure
// pumping. This gate measures those directly on every generated clip (~2–4 s
// of CPU at 540 px) and fails the clip the same way a VLM "hard" reason does,
// so the existing ladder handles it — and with PARALLAX_MODE set, the floor is
// the exact engine.
//
// v64.2 (Sep-22 smoke test): a single first→last flow could not follow
// Kling's 25–50% exterior pushes — it reported zoom ≈ 1.00 and a huge
// "residual" that was uncompensated camera motion, not morph. The Python now
// chains the flow over ~8 sampled frames (zoom = product of step scales,
// morph = worst PER-STEP residual), and the thresholds below are re-calibrated
// on the same bake-off clips:
//   static re-encode           zoom 1.00  step 0.000  lines 94%
//   synthetic 6% zoom          zoom 1.05  step 0.007  lines 81%
//   depth-parallax (v64)       zoom 1.07  step 0.012  lines 84–86%
//   Kling v3 Pro bath / pool   zoom 1.09 / 1.13   step 0.014 / 0.019   ← pass
//   Kling v3 Pro exterior      zoom 1.23  step 0.023                   ← passes the exterior budget
//   Kling v3 Pro great room    zoom 1.21  step 0.097  lines 61%        ← morph
//   Kling v3 Pro bedroom       zoom 1.38  step 0.032                   ← 4.7× the ask
//   Wan 3.0 bedroom / kitchen  step 0.056 / 0.059  flicker 1.75 / 1.15 ← boil
//   MiniMax H3 cam kitchen     zoom 0.94                               ← pull-back (v46: never)
//
// Budgets are room-aware: interiors ask for ~8% and a 20% push exposes
// disocclusion around furniture (GATE_ZOOM_MAX 1.16); exteriors ask for 4%
// but a 25–35% dolly on a house is a normal drone-ish move and hallucination
// pressure is lower there (GATE_ZOOM_MAX_EXTERIOR 1.35).
//
// Default: ON whenever PARALLAX_MODE is not "off" (the floor is then worth
// falling to); MEASURED_GATE=1|0 forces it either way. Fails OPEN on any
// tool error (a broken Python must never fail a healthy clip).

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = path.join(HERE, "..", "tools", "clip-gate.py");
const PYTHON = process.env.PARALLAX_PYTHON || "python3";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v != null ? n : d; };

export function gateEnabled() {
  const explicit = String(process.env.MEASURED_GATE || "").trim().toLowerCase();
  if (explicit === "1" || explicit === "true" || explicit === "on") return true;
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  return String(process.env.PARALLAX_MODE || "off").toLowerCase().trim() !== "off";
}

export function gateThresholds() {
  return {
    zoomMin: num(process.env.GATE_ZOOM_MIN, 1.01),                    // must actually move forward (v60.5 near-still, v46 no pull-outs)
    zoomMax: num(process.env.GATE_ZOOM_MAX, 1.16),                    // interiors: ~2× the 8% ask
    zoomMaxExterior: num(process.env.GATE_ZOOM_MAX_EXTERIOR, 1.35),   // exteriors/pools/twilights: a dolly on a house
    rigidStepMax: num(process.env.GATE_RIGID_MAX, 0.04),              // worst per-step flow residual; morph/boil
    linesMin: num(process.env.GATE_LINES_MIN, 50),                    // % of frame-0 straight edges surviving
    flickerMax: num(process.env.GATE_FLICKER_MAX, 1.5)                // gray levels per step; gross exposure pumping
  };
}

const EXTERIOR_RE = /exterior|outdoor|backyard|front|yard|patio|pool|garden|deck|twilight|aerial|drone|street|view|balcony|courtyard/i;
export function isExteriorRoom(roomType = "") {
  return EXTERIOR_RE.test(String(roomType || ""));
}

/** Pure: turn a measurement into reasons. Exported for tests. */
export function gateVerdict(m, thresholds = gateThresholds(), { roomType = "" } = {}) {
  if (!m || m.ok === false) return { pass: true, checked: false, reasons: [], measured: m || null };
  const t = thresholds;
  const zoomMax = isExteriorRoom(roomType) ? t.zoomMaxExterior : t.zoomMax;
  const reasons = [];
  if (Number.isFinite(m.zoom)) {
    if (m.zoom < t.zoomMin) reasons.push(m.zoom < 0.995 ? `measured_pullback:${m.zoom}` : `measured_static:${m.zoom}`);
    else if (m.zoom > zoomMax) reasons.push(`measured_overpush:${m.zoom}`);
  }
  // v64.2: per-step residual (rigid_step) is the morph signal; rigid_last is
  // the v64.1 single-flow number, only present in old outputs.
  const rigid = Number.isFinite(m.rigid_step) ? m.rigid_step : (Number.isFinite(m.rigid_last) ? m.rigid_last : null);
  if (rigid != null && rigid > t.rigidStepMax) reasons.push(`measured_morph:${rigid}`);
  if (Number.isFinite(m.line_persist_pct) && m.line_persist_pct < t.linesMin) reasons.push(`measured_lines:${m.line_persist_pct}%`);
  if (Number.isFinite(m.lum_flicker) && m.lum_flicker > t.flickerMax) reasons.push(`measured_flicker:${m.lum_flicker}`);
  return { pass: reasons.length === 0, checked: true, reasons, measured: m };
}

/** True when a verdict failed ONLY on camera travel (over-push / pull-back /
 *  static). Those are properties of the engine on this photo, not of the
 *  prompt — the Sep-22 smoke test went 1.23 → 1.48 → 1.35 across three
 *  different prompts — so the ladder floors them instead of re-rolling. */
export function motionBudgetOnly(verdict) {
  const r = verdict?.reasons || [];
  return Boolean(verdict?.checked) && !verdict.pass && r.length > 0 && r.every((x) => /^measured_(overpush|pullback|static)/.test(String(x)));
}

export function parseGateOutput(stdout = "") {
  const lines = String(stdout).split(/\r?\n/).filter((l) => l.startsWith("[gate] {"));
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1].slice("[gate] ".length)); } catch { return null; }
}

/** Run the Python measurement. Resolves to the parsed JSON or {ok:false,error}. Never throws. */
export function measureClip(clipPath, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", child;
    try {
      child = spawn(PYTHON, [TOOL_PATH, "--clip", clipPath], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({ ok: false, error: `gate timed out after ${timeoutMs}ms` }); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseGateOutput(stdout);
      if (parsed) return resolve(parsed);
      resolve({ ok: false, error: `gate exited ${code}: ${stderr.trim().split("\n").pop() || "no output"}` });
    });
  });
}

/**
 * Merge a VLM verdict ({pass, reasons, checked}) with the measured gate.
 * Measured reasons are "hard" (they don't start with "motion"), so the
 * ladder treats them like an object artifact, not a motion-only flag.
 */
export async function gateClip(vlmVerdict, clipPath, { sceneIndex = 0, roomType = "", label = "" } = {}) {
  if (!gateEnabled()) return vlmVerdict;
  const m = await measureClip(clipPath);
  const g = gateVerdict(m, gateThresholds(), { roomType });
  if (!g.checked) {
    console.warn(`[gate] scene ${sceneIndex + 1}${label}: measurement unavailable (${m?.error || "?"}) — VLM verdict only.`);
    return vlmVerdict;
  }
  console.info(
    `[gate] scene ${sceneIndex + 1}${label}${roomType ? ` (${roomType})` : ""}: zoom ${m.zoom} (chained flow ${m.zoom_flow ?? "-"}, orb ${m.zoom_orb ?? "-"}/${m.orb_inliers ?? 0}${m.flow_ok === false ? ", flow suspect" : ""}), ` +
    `morph step ${m.rigid_step ?? m.rigid_last ?? "-"} (total ${m.rigid_total ?? "-"}), lines ${m.line_persist_pct ?? "-"}%, flicker ${m.lum_flicker}, travel ${m.travel_px}px → ${g.pass ? "PASS" : "FAIL " + g.reasons.join(", ")}`
  );
  const base = vlmVerdict || { pass: true, reasons: [], checked: false };
  return {
    ...base,
    checked: true,
    pass: Boolean(base.pass) && g.pass,
    reasons: [...(base.reasons || []), ...g.reasons],
    measured: m
  };
}
