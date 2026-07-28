// v62.63 — the lead auto-render retry state machine, tested against a
// stubbed PostgREST. Run: node tests/lead-retry.test.mjs (from
// render-worker/). The seam is __testFailOrRetry, exercised exactly as
// processOne calls it; fetch is monkey-patched to capture PATCH bodies
// and to simulate the migration-38-missing 400.

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

const { __testFailOrRetry, __testRetrySchedule } = await import("../src/lead-auto-render.mjs");

let pass = 0;
const failures = [];
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`  ok: ${name}`); }
  else { failures.push(name); console.error(`  FAIL: ${name} ${detail}`); }
};

const calls = [];
let respondWith = { ok: true, status: 204, body: "" };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
  const r = respondWith;
  return {
    ok: r.ok,
    status: r.status,
    text: async () => r.body,
    json: async () => { try { return JSON.parse(r.body); } catch { return {}; } }
  };
};

const SUPA = "https://stub.supabase.co";

console.log("== schedule shape");
ok(JSON.stringify(__testRetrySchedule.RETRY_BACKOFF_MIN) === "[15,60,240]",
  "backoff ladder is +15m, +1h, +4h", JSON.stringify(__testRetrySchedule.RETRY_BACKOFF_MIN));
ok(__testRetrySchedule.MAX_RETRIES === 3, "three retries max");

console.log("== transient failure, first attempt → retry scheduled at +15m");
calls.length = 0;
const t0 = Date.now();
await __testFailOrRetry(SUPA, { lead_id: "L1", auto_render_attempts: 0 }, "import(failed,0p)", { retryable: true });
{
  const patch = calls.find((c) => c.method === "PATCH")?.body;
  ok(patch?.auto_render_status === "retry:import(failed,0p)", "status becomes retry:*", JSON.stringify(patch));
  ok(patch?.auto_render_attempts === 1, "attempt counter increments");
  const delta = (new Date(patch?.auto_render_next_at).getTime() - t0) / 60000;
  ok(delta > 14 && delta < 16, "next_at ≈ +15 minutes", `${delta.toFixed(1)}m`);
}

console.log("== second retry uses the second rung (+60m)");
calls.length = 0;
await __testFailOrRetry(SUPA, { lead_id: "L2", auto_render_attempts: 1 }, "plan-fallback(timeout)", { retryable: true });
{
  const patch = calls.find((c) => c.method === "PATCH")?.body;
  const delta = (new Date(patch?.auto_render_next_at).getTime() - Date.now()) / 60000;
  ok(patch?.auto_render_attempts === 2 && delta > 58 && delta < 62, "attempt 2 lands at ≈ +60m", `${delta.toFixed(1)}m`);
}

console.log("== retries exhausted → terminal failed:*");
calls.length = 0;
await __testFailOrRetry(SUPA, { lead_id: "L3", auto_render_attempts: 3 }, "import(failed,0p)", { retryable: true });
{
  const patch = calls.find((c) => c.method === "PATCH")?.body;
  ok(patch?.auto_render_status === "failed:import(failed,0p)", "status is terminal failed:*", JSON.stringify(patch));
  ok(!("auto_render_next_at" in (patch || {})), "no next_at on a terminal mark");
}

console.log("== semantic rejection → terminal immediately, attempts untouched");
calls.length = 0;
await __testFailOrRetry(SUPA, { lead_id: "L4", auto_render_attempts: 0 }, "submit(402,payment)", { retryable: false });
{
  const patch = calls.find((c) => c.method === "PATCH")?.body;
  ok(patch?.auto_render_status === "failed:submit(402,payment)", "4xx-class goes straight to failed:*");
  ok(calls.filter((c) => c.method === "PATCH").length === 1, "exactly one PATCH — no retry write");
}

console.log("== migration 38 missing → falls back to terminal one-shot behavior");
calls.length = 0;
respondWith = { ok: false, status: 400, body: `{"message":"Could not find the 'auto_render_attempts' column"}` };
await __testFailOrRetry(SUPA, { lead_id: "L5", auto_render_attempts: 0 }, "import(failed,0p)", { retryable: true });
respondWith = { ok: true, status: 204, body: "" };
{
  const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.body);
  ok(patches.some((p) => p?.auto_render_status === "failed:import(failed,0p)"),
    "terminal mark lands after the retry write is rejected", JSON.stringify(patches));
}

console.log("== once columns are known missing, retries stop being attempted at all");
calls.length = 0;
await __testFailOrRetry(SUPA, { lead_id: "L6", auto_render_attempts: 0 }, "import(failed,0p)", { retryable: true });
{
  const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.body);
  ok(patches.length === 1 && patches[0]?.auto_render_status === "failed:import(failed,0p)",
    "single terminal PATCH — no doomed retry write", JSON.stringify(patches));
}

console.log(`\n${failures.length === 0 ? "ALL PASS" : `FAILURES (${failures.length})`}  [${pass} passed]`);
process.exit(failures.length === 0 ? 0 : 1);
