import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vistalia app shell — built and served at /app on the deployed Vercel site.
//
// Source lives at /webapp/. Build output goes DIRECTLY into /app/ at the repo
// root (NOT /webapp/dist/) so that /app/index.html is a real static file that
// Vercel serves directly via cleanUrls. Earlier we tried rewrites from /app to
// /webapp/dist/index.html but Vercel's cleanUrls behavior interfered with
// destinations ending in /index.html, causing intermittent 404s. Building
// straight into /app/ removes the rewrite layer entirely.
//
// /app/ is gitignored (the build output is reproducible from /webapp/ source),
// so the deployed repo has no /app/ files until Vercel runs `npm run build`.
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  build: {
    outDir: "../app",
    sourcemap: false,
    target: "es2020",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "https://estatemotion.vercel.app",
        changeOrigin: true,
        secure: true
      }
    }
  }
});
