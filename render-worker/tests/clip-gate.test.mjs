// v64.2 — measured clip gate: chained-flow thresholds, room-aware budgets,
// the motion-budget shortcut, verdict merge. Pure Node. Run from render-worker/:
//   node tests/clip-gate.test.mjs
import { gateVerdict, gateEnabled, gateThresholds, parseGateOutput, motionBudgetOnly, isExteriorRoom } from "../src/clip-gate.mjs";

let pass = 0;
const failures = [];
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { failures.push(name); console.error(`  FAIL: ${name} ${detail}`); }
};
const reasonsOf = (m, roomType = "") => gateVerdict(m, gateThresholds(), { roomType }).reasons.map((r) => r.split(":")[0]);
const M = (zoom, step, lines, flicker) => ({ ok: true, zoom, rigid_step: step, line_persist_pct: lines, lum_flicker: flicker });

console.log("== enablement");
delete process.env.MEASURED_GATE; delete process.env.PARALLAX_MODE;
ok(gateEnabled() === false, "off by default (v63 behaviour)");
process.env.PARALLAX_MODE = "interior";
ok(gateEnabled() === true, "on when PARALLAX_MODE is set (the floor is worth falling to)");
process.env.MEASURED_GATE = "0";
ok(gateEnabled() === false, "MEASURED_GATE=0 forces off");
process.env.MEASURED_GATE = "1"; delete process.env.PARALLAX_MODE;
ok(gateEnabled() === true, "MEASURED_GATE=1 forces on");

console.log("== calibration clips pass (Sep-21 bake-off, chained flow)");
ok(gateVerdict(M(1.054, 0.007, 81.4, 0.13)).pass, "synthetic 6% zoom passes");
ok(gateVerdict(M(1.071, 0.012, 83.6, 0.127)).pass, "depth-parallax r6 passes");
ok(gateVerdict(M(1.092, 0.014, 85.2, 0.117), gateThresholds(), { roomType: "bathroom" }).pass, "Kling v3 Pro bath (clean) passes");
ok(gateVerdict(M(1.134, 0.019, 97.3, 0.136), gateThresholds(), { roomType: "pool patio" }).pass, "Kling v3 Pro pool passes (exterior budget)");
ok(gateVerdict(M(1.228, 0.023, 82.1, 0.338), gateThresholds(), { roomType: "exterior twilight" }).pass, "Kling v3 Pro exterior 1.23 passes the exterior budget");
ok(gateVerdict(M(1.068, 0.027, 79.9, 0.632), gateThresholds(), { roomType: "exterior" }).pass, "MiniMax exterior passes");

console.log("== bake-off failures fail for the right reason");
ok(reasonsOf(M(1.214, 0.097, 61.3, 1.72), "kitchen").join() === "measured_overpush,measured_morph,measured_flicker", "Kling great room (interior): overpush + morph + flicker", reasonsOf(M(1.214, 0.097, 61.3, 1.72), "kitchen").join());
ok(reasonsOf(M(1.38, 0.032, 77.6, 0.394), "bedroom").join() === "measured_overpush", "Kling bedroom: 4.7× the ask, otherwise clean");
ok(reasonsOf(M(0.935, 0.02, 81.4, 0.948), "kitchen").join() === "measured_pullback", "MiniMax kitchen: pull-back (v46: never)");
ok(reasonsOf(M(1.0, 0.0, 93.5, 0.001)).join() === "measured_static", "static clip: near-still (v60.5)");
ok(reasonsOf(M(1.348, 0.056, 76.6, 1.75), "bedroom").join() === "measured_overpush,measured_morph,measured_flicker", "Wan bedroom: over-push + boil + pumping");
ok(reasonsOf(M(1.429, 0.057, 71.4, 0.791), "exterior twilight").join() === "measured_overpush,measured_morph", "Kling Std re-lit twilight: over-push + morph even on the exterior budget");

console.log("== Sep-22 smoke test, replayed against the room-aware budget");
ok(gateVerdict(M(1.23, 0.02, 73.1, 0.75), gateThresholds(), { roomType: "exterior" }).pass, "scene 1 first attempt (1.23, no real morph) would SHIP instead of re-rolling three times");
ok(reasonsOf(M(1.477, 0.02, 59.6, 1.17), "exterior").join() === "measured_overpush", "scene 1 second attempt (1.48) is over any budget");
ok(reasonsOf(M(1.324, 0.02, 76.5, 0.9), "exterior").join() === "", "scene 7 (1.32) inside the exterior budget");

console.log("== motion-budget shortcut");
ok(motionBudgetOnly({ checked: true, pass: false, reasons: ["measured_overpush:1.48"] }), "overpush only → shortcut");
ok(motionBudgetOnly({ checked: true, pass: false, reasons: ["measured_pullback:0.94"] }), "pullback only → shortcut");
ok(!motionBudgetOnly({ checked: true, pass: false, reasons: ["measured_overpush:1.48", "measured_morph:0.09"] }), "overpush + morph → full ladder");
ok(!motionBudgetOnly({ checked: true, pass: false, reasons: ["object_artifacts: extra doorway"] }), "VLM hard reason → full ladder");
ok(!motionBudgetOnly({ checked: true, pass: true, reasons: [] }), "pass → no shortcut");
ok(!motionBudgetOnly({ checked: false, pass: true, reasons: [] }), "unchecked → no shortcut");

console.log("== reasons are hard (never motion-prefixed), fail-open on tool error, room detection");
const v = gateVerdict(M(1.3, 0.01, 90, 0.1));
ok(v.reasons.every((r) => !r.startsWith("motion")), "measured reasons never start with 'motion'");
ok(gateVerdict({ ok: false, error: "python missing" }).checked === false && gateVerdict({ ok: false }).pass === true, "tool error → unchecked, passes (fail open)");
ok(gateVerdict(null).checked === false, "null → unchecked");
ok(isExteriorRoom("pool patio") && isExteriorRoom("Exterior Twilight") && !isExteriorRoom("kitchen") && !isExteriorRoom(""), "exterior detection");
ok(gateVerdict({ ok: true, zoom: 1.05, rigid_last: 0.3, line_persist_pct: 80, lum_flicker: 0.2 }).reasons.join().startsWith("measured_morph"), "v64.1 rigid_last still honoured when rigid_step is absent");

console.log("== env thresholds");
process.env.GATE_ZOOM_MAX_EXTERIOR = "1.5";
ok(gateVerdict(M(1.477, 0.02, 59.6, 1.17), gateThresholds(), { roomType: "exterior" }).pass, "GATE_ZOOM_MAX_EXTERIOR widened → 1.48 passes");
delete process.env.GATE_ZOOM_MAX_EXTERIOR;
ok(gateThresholds().zoomMaxExterior === 1.35 && gateThresholds().zoomMax === 1.16 && gateThresholds().rigidStepMax === 0.04, "defaults restored");

console.log("== stdout contract");
ok(parseGateOutput("noise\n[gate] {\"ok\": true, \"zoom\": 1.07}\n")?.zoom === 1.07, "last [gate] JSON line parsed");
ok(parseGateOutput("Traceback…") === null, "no JSON → null");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
