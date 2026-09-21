// Vistalia — measured clip gate (v64). Node side of tools/clip-gate.py.
//
// The QC ladder's verdicts come from a vision model looking at four frames;
// it cannot see a 37% push, a wall morphing between samples, or exposure
// pumping. This gate measures those directly on every generated clip (~1–3 s
// of CPU at 540 px) and fails the clip the same way a VLM "hard" reason does,
// so the existing ladder (constrained regen → gentle re-roll → floor) handles
// it — and with PARALLAX_MODE set, the floor is the exact engine.
//
// Thresholds (env-overridable) come from the Sep-20/21 bake-off:
//   static re-encode           zoom 1.00  rigid 0.00  lines 94%
//   synthetic 6% zoom          zoom 1.06  rigid 0.04  lines 84%
//   depth-parallax (v64)       zoom 1.07  rigid 0.05  lines 85%
//   Kling v3 Pro, bath         zoom 1.09  rigid 0.05  lines 87%   ← passes
//   Kling v3 Pro, great room   zoom 1.15  rigid 0.34  lines 44%   ← morph
//   Kling v3 Pro, bedroom      zoom 1.38  rigid 0.18  lines 77%   ← 4.7× the ask
//   MiniMax H3 cam, kitchen    zoom 0.94  (pull-back — v46: never)
//   Wan 3.0, bedroom           zoom 1.27  rigid 0.25
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
    zoomMin: num(process.env.GATE_ZOOM_MIN, 1.01),   // must actually move forward (v60.5 near-still, v46 no pull-outs)
    zoomMax: num(process.env.GATE_ZOOM_MAX, 1.16),   // ~2× the 8% ask; Kling's 1.09–1.15 passes, its 1.38 does not
    rigidMax: num(process.env.GATE_RIGID_MAX, 0.15), // flow-compensated residual; morph/boil
    linesMin: num(process.env.GATE_LINES_MIN, 50),   // % of frame-0 straight edges surviving
    flickerMax: num(process.env.GATE_FLICKER_MAX, 3.0) // gray levels; only gross exposure pumping
  };
}

/** Pure: turn a measurement into reasons. Exported for tests. */
export function gateVerdict(m, thresholds = gateThresholds()) {
  if (!m || m.ok === false) return { pass: true, checked: false, reasons: [], measured: m || null };
  const t = thresholds;
  const reasons = [];
  if (Number.isFinite(m.zoom)) {
    if (m.zoom < t.zoomMin) reasons.push(m.zoom < 0.995 ? `measured_pullback:${m.zoom}` : `measured_static:${m.zoom}`);
    else if (m.zoom > t.zoomMax) reasons.push(`measured_overpush:${m.zoom}`);
  }
  if (Number.isFinite(m.rigid_last) && m.rigid_last > t.rigidMax) reasons.push(`measured_morph:${m.rigid_last}`);
  if (Number.isFinite(m.line_persist_pct) && m.line_persist_pct < t.linesMin) reasons.push(`measured_lines:${m.line_persist_pct}%`);
  if (Number.isFinite(m.lum_flicker) && m.lum_flicker > t.flickerMax) reasons.push(`measured_flicker:${m.lum_flicker}`);
  return { pass: reasons.length === 0, checked: true, reasons, measured: m };
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
export async function gateClip(vlmVerdict, clipPath, { sceneIndex = 0, label = "" } = {}) {
  if (!gateEnabled()) return vlmVerdict;
  const m = await measureClip(clipPath);
  const g = gateVerdict(m);
  if (!g.checked) {
    console.warn(`[gate] scene ${sceneIndex + 1}${label}: measurement unavailable (${m?.error || "?"}) — VLM verdict only.`);
    return vlmVerdict;
  }
  console.info(
    `[gate] scene ${sceneIndex + 1}${label}: zoom ${m.zoom} (orb ${m.zoom_orb ?? "-"}/flow ${m.zoom_flow ?? "-"}), ` +
    `rigid ${m.rigid_last}, lines ${m.line_persist_pct ?? "-"}%, flicker ${m.lum_flicker}, travel ${m.travel_px}px → ${g.pass ? "PASS" : "FAIL " + g.reasons.join(", ")}`
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
