// v64 — measured clip gate: thresholds + verdict merge, against the Sep-21
// bake-off measurements. Pure Node. Run from render-worker/:
//   node tests/clip-gate.test.mjs
import { gateVerdict, gateEnabled, gateThresholds, parseGateOutput } from "../src/clip-gate.mjs";

let pass = 0;
const failures = [];
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { failures.push(name); console.error(`  FAIL: ${name} ${detail}`); }
};
const reasonsOf = (m) => gateVerdict(m, gateThresholds()).reasons.map((r) => r.split(":")[0]);

console.log("== enablement");
delete process.env.MEASURED_GATE; delete process.env.PARALLAX_MODE;
ok(gateEnabled() === false, "off by default (v63 behaviour)");
process.env.PARALLAX_MODE = "interior";
ok(gateEnabled() === true, "on when PARALLAX_MODE is set (the floor is worth falling to)");
process.env.MEASURED_GATE = "0";
ok(gateEnabled() === false, "MEASURED_GATE=0 forces off");
process.env.MEASURED_GATE = "1"; delete process.env.PARALLAX_MODE;
ok(gateEnabled() === true, "MEASURED_GATE=1 forces on");

console.log("== calibration clips pass");
ok(gateVerdict({ ok: true, zoom: 1.06, rigid_last: 0.043, line_persist_pct: 83.5, lum_flicker: 0.3 }).pass, "synthetic 6% zoom passes");
ok(gateVerdict({ ok: true, zoom: 1.065, rigid_last: 0.049, line_persist_pct: 85.1, lum_flicker: 0.18 }).pass, "depth-parallax r6 passes");
ok(gateVerdict({ ok: true, zoom: 1.093, rigid_last: 0.048, line_persist_pct: 86.9, lum_flicker: 0.06 }).pass, "Kling v3 Pro bath (clean clip) passes");

console.log("== bake-off failures fail for the right reason");
ok(reasonsOf({ ok: true, zoom: 1.153, rigid_last: 0.339, line_persist_pct: 44.3, lum_flicker: 1.94 }).join() === "measured_morph,measured_lines", "Kling great room: morph + lines", reasonsOf({ ok: true, zoom: 1.153, rigid_last: 0.339, line_persist_pct: 44.3, lum_flicker: 1.94 }).join());
ok(reasonsOf({ ok: true, zoom: 1.379, rigid_last: 0.181, line_persist_pct: 76.5, lum_flicker: 0.42 }).join() === "measured_overpush,measured_morph", "Kling bedroom: 4.7× the ask + morph");
ok(reasonsOf({ ok: true, zoom: 0.94, rigid_last: 0.05, line_persist_pct: 83.9, lum_flicker: 0.81 }).join() === "measured_pullback", "MiniMax kitchen: pull-back (v46: never)");
ok(reasonsOf({ ok: true, zoom: 1.0, rigid_last: 0.0, line_persist_pct: 93.5, lum_flicker: 0.001 }).join() === "measured_static", "static clip: near-still (v60.5)");
ok(reasonsOf({ ok: true, zoom: 1.267, rigid_last: 0.254, line_persist_pct: 72.7, lum_flicker: 2.16 }).join() === "measured_overpush,measured_morph", "Wan bedroom: over-push + morph");

console.log("== reasons are hard (never motion-prefixed), fail-open on tool error");
const v = gateVerdict({ ok: true, zoom: 1.3, rigid_last: 0.01, line_persist_pct: 90, lum_flicker: 0.1 });
ok(v.reasons.every((r) => !r.startsWith("motion")), "measured reasons never start with 'motion'");
ok(gateVerdict({ ok: false, error: "python missing" }).checked === false && gateVerdict({ ok: false }).pass === true, "tool error → unchecked, passes (fail open)");
ok(gateVerdict(null).checked === false, "null → unchecked");

console.log("== env thresholds");
process.env.GATE_ZOOM_MAX = "1.4";
ok(gateVerdict({ ok: true, zoom: 1.379, rigid_last: 0.05, line_persist_pct: 80, lum_flicker: 0.4 }).pass, "GATE_ZOOM_MAX widened → bedroom zoom passes");
delete process.env.GATE_ZOOM_MAX;
ok(gateThresholds().zoomMax === 1.16, "default zoomMax restored");

console.log("== stdout contract");
ok(parseGateOutput("noise\n[gate] {\"ok\": true, \"zoom\": 1.07}\n")?.zoom === 1.07, "last [gate] JSON line parsed");
ok(parseGateOutput("Traceback…") === null, "no JSON → null");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
