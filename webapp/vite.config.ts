import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// EstateMotion app shell — built and served at /app on the deployed Vercel site.
//
// Source lives at /webapp/. Build output goes to /webapp/dist/. The Vercel
// rewrites in vercel.json map /app and /app/* to /webapp/dist/index.html,
// and /app/assets/* to /webapp/dist/assets/*. Source is intentionally NOT
// at /app/ in the repo — having index.html at /app/ would cause Vercel's
// static-file resolver to serve the source HTML directly, bypassing rewrites
// and 404'ing on the .tsx script reference.
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  build: {
    outDir: "dist",
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
