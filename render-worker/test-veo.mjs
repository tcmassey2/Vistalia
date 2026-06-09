// EstateMotion v25 Phase 1b — Veo smoke-test runner (fal.ai).
//
// Hits the worker's POST /test/veo endpoint with one Supabase image URL
// + one motion prompt and prints the resulting clip URL on success.
//
// USAGE
//   WORKER_URL=https://estatemotion-worker.onrender.com \
//     node test-veo.mjs \
//       --image https://your-supabase-url.supabase.co/.../kitchen.jpg \
//       --prompt "Slow cinematic dolly toward the kitchen island. Preserve cabinetry exactly." \
//       --aspect 9:16 \
//       --duration 6s \
//       --model fal-ai/veo3/fast/image-to-video
//
//   # Or, if you have a local worker running:
//   WORKER_URL=http://127.0.0.1:8787 node test-veo.mjs --image ... --prompt ...
//
// Bake-off: change --model to A/B test other engines via fal.ai:
//   fal-ai/veo3/fast/image-to-video          (Veo 3 Fast, cheapest)
//   fal-ai/veo3.1/lite/image-to-video        (Veo 3.1 Lite)
//   fal-ai/veo3.1/image-to-video             (Veo 3.1 Standard)
//   fal-ai/kling-video/o3/standard/image-to-video  (Kling)
//   fal-ai/luma-dream-machine/ray-2/image-to-video (Luma Ray)
//   fal-ai/bytedance/seedance/v1/pro/image-to-video (Seedance Pro)
//
// PREREQS (on the worker side)
//   FAL_KEY              - your fal.ai API key (from https://fal.ai/dashboard/keys)
//   FAL_VIDEO_MODEL      - optional, defaults to fal-ai/veo3/fast/image-to-video
//
// PREREQS (on YOUR side, if the worker has a secret set — production does)
//   WORKER_SECRET        - same value as RENDER_WEBHOOK_SECRET on the worker.
//                          v26 gated /test/veo behind worker auth so strangers
//                          can't burn fal.ai balance. Local workers without a
//                          secret still accept unauthenticated calls.

const args = parseArgs(process.argv.slice(2));
if (!args.image || !args.prompt) {
  console.error(
    "Missing required flags. Usage:\n" +
      "  node test-veo.mjs --image <url> --prompt <text> [--aspect 9:16] [--duration 5]"
  );
  process.exit(1);
}

const workerUrl = (process.env.WORKER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const body = {
  imageUrl: args.image,
  prompt: args.prompt,
  aspectRatio: args.aspect || "9:16",
  duration: args.duration || "6s",
  ...(args.model ? { model: args.model } : {})
};

console.log(`POST ${workerUrl}/test/veo`);
console.log("Body:", { ...body, prompt: body.prompt.slice(0, 80) + "..." });
const startedAt = Date.now();

const workerSecret = process.env.WORKER_SECRET || process.env.RENDER_WEBHOOK_SECRET || "";
const res = await fetch(`${workerUrl}/test/veo`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(workerSecret ? { Authorization: `Bearer ${workerSecret}` } : {})
  },
  body: JSON.stringify(body)
});

const json = await res.json().catch(() => ({}));
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

if (!res.ok || json.status !== "ok") {
  console.error(`\n❌ Veo smoke test FAILED in ${elapsed}s`);
  console.error("HTTP", res.status, json);
  process.exit(2);
}

console.log(`\n✅ Veo smoke test PASSED in ${elapsed}s`);
console.log("Clip:        ", `${workerUrl}${json.clipServePath}`);
console.log("GCS URI:     ", json.gcsUri);
console.log("Veo op:      ", json.veoOpName);
console.log("Notes:       ", json.notes);
console.log("\nOpen the Clip URL in a browser to inspect the result.");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2);
    const val = argv[i + 1];
    if (!val || val.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = val;
      i++;
    }
  }
  return out;
}
