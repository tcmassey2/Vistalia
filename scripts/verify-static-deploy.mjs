import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "index.html",
  "landing.css",
  "landing.js",
  "app.js",
  "styles.css",
  "app-dark.css",
  "app/index.html",
  "demo/index.html",
  "beta/index.html",
  "api/env.js",
  "api/health.js",
  "api/render.js",
  "api/classify-image.js",
  "api/create-edit-plan.js",
  "api/usage.js",
  "api/create-checkout-session.js",
  "api/stripe-webhook.js",
  "supabase/migrations/02_subscriptions.sql",
  "render-worker/src/runway-job.mjs",
  "lib/reel/demoFixtures.js",
  "vercel.json",
  "supabase/schema.sql",
  "supabase/seed.sql",
  "README.md",
  "DEPLOY_CHECKLIST.md",
  "docs/PRODUCTION_DEPLOYMENT.md"
];

for (const file of requiredFiles) {
  await access(file);
}

JSON.parse(await readFile("vercel.json", "utf8"));
JSON.parse(await readFile("package.json", "utf8"));

console.log(`EstateMotion static deploy check passed: ${requiredFiles.length} files present.`);
