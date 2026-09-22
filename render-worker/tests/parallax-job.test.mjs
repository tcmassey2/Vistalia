// v64 — depth-parallax engine wrapper: routing policy, choreography and the
// renderer's stdout contract. Pure Node (no Python needed). Run from
// render-worker/: node tests/parallax-job.test.mjs
import { parallaxPolicy, parallaxMove, parseParallaxSummary, PARALLAX_MODES } from "../src/parallax-job.mjs";

let pass = 0;
const failures = [];
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { failures.push(name); console.error(`  FAIL: ${name} ${detail}`); }
};

console.log("== PARALLAX_MODE routing");
delete process.env.PARALLAX_MODE;
ok(parallaxPolicy({ roomType: "kitchen" }) === "off", "unset → off (v63 behaviour)");
process.env.PARALLAX_MODE = "garbage";
ok(parallaxPolicy({ roomType: "kitchen" }) === "off", "unknown value → off");
process.env.PARALLAX_MODE = "floor";
ok(parallaxPolicy({ roomType: "kitchen" }) === "floor", "floor: interiors still go to fal first");
ok(parallaxPolicy({ roomType: "exterior" }) === "floor", "floor: exteriors too");
process.env.PARALLAX_MODE = "interior";
ok(parallaxPolicy({ roomType: "kitchen" }) === "primary", "interior: kitchen → primary");
ok(parallaxPolicy({ roomType: "primary bedroom" }) === "primary", "interior: bedroom → primary");
ok(parallaxPolicy({ roomType: "bathroom" }) === "primary", "interior: bath → primary");
ok(parallaxPolicy({ roomType: "exterior twilight" }) === "floor", "interior: exterior stays generative (+floor)");
ok(parallaxPolicy({ roomType: "pool" }) === "floor", "interior: pool stays generative (+floor)");
ok(parallaxPolicy({ roomType: "backyard patio" }) === "floor", "interior: patio stays generative (+floor)");
ok(parallaxPolicy({ roomType: "" }) === "primary", "interior: unknown room → primary (galleries are mostly rooms)");
ok(parallaxPolicy({}) === "primary", "interior: missing room → primary");
process.env.PARALLAX_MODE = "ALL";
ok(parallaxPolicy({ roomType: "pool" }) === "primary", "all (case-insensitive): pool → primary");
ok(JSON.stringify(PARALLAX_MODES) === JSON.stringify(["off", "floor", "interior", "all"]), "modes list");

console.log("== choreography: push only, velocity-constant, rotation drift");
delete process.env.PARALLAX_VELOCITY; delete process.env.PARALLAX_ZOOM_MAX;
const seen = new Set();
for (let i = 0; i < 12; i++) {
  const mv = parallaxMove(i, "push_in", 3.5);
  ok(mv.zoom >= 1.10 && mv.zoom <= 1.16, `scene ${i} @3.5s: zoom ${mv.zoom} in the v39-floor band (never a pull-out)`);
  ok(Math.abs(mv.yaw) <= 1.0 && Math.abs(mv.pitch) <= 0.4, `scene ${i} @3.5s: rotation stays steadicam (yaw ${mv.yaw}, pitch ${mv.pitch})`);
  seen.add(JSON.stringify([mv.zoom, mv.yaw, mv.pitch]));
}
ok(seen.size >= 4, `variety across scenes (${seen.size} distinct moves in 12)`);
const short = parallaxMove(0, "push_in", 1.9), ref = parallaxMove(0, "push_in", 3.5), long6 = parallaxMove(0, "push_in", 6.2), long9 = parallaxMove(0, "push_in", 8.8);
ok(short.zoom < ref.zoom && ref.zoom < long6.zoom && long6.zoom <= long9.zoom, `per-frame speed constant: zoom grows with duration (${short.zoom} < ${ref.zoom} < ${long6.zoom} <= ${long9.zoom})`);
ok(long9.zoom <= 1.30, `zoom capped at 1.30 for the 1.75x supersample (${long9.zoom})`);
ok(long9.gain === 2.2 && short.gain === 0.6, `gain clamps at 0.6..2.2 (${short.gain}, ${long9.gain})`);
ok(Math.abs(long9.yaw) <= 1.6 * 0.9 + 1e-6, `rotation gain capped at 1.6× (${long9.yaw})`);
process.env.PARALLAX_VELOCITY = "0.5";
ok(parallaxMove(0, "push_in", 3.5).zoom < ref.zoom, "PARALLAX_VELOCITY scales the move");
delete process.env.PARALLAX_VELOCITY;
ok(parallaxMove(3, "pull_out", 3.5).zoom > 1, "legacy pull_out renders as a push (v46)");
ok(parallaxMove(0, "lateral_pan", 3.5).yaw !== 0, "lateral_pan gets a turning push");

console.log("== stdout contract");
const good = "[parallax] 1080x1920 depth 1.4s lines 252/252 ...\n[parallax] {\"ok\": true, \"elapsed_s\": 41.2, \"bend_p95_px\": 0.9}\n";
ok(parseParallaxSummary(good)?.ok === true && parseParallaxSummary(good).bend_p95_px === 0.9, "last JSON line wins");
const bad = "[parallax] {\"ok\": false, \"error\": \"depth model missing\"}\n";
ok(parseParallaxSummary(bad)?.ok === false && /model/.test(parseParallaxSummary(bad).error), "failure summary parsed");
ok(parseParallaxSummary("Traceback (most recent call last)\nValueError: x") === null, "no summary → null (caller treats as failure)");
ok(parseParallaxSummary("") === null, "empty → null");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
