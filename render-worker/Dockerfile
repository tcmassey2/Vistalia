# EstateMotion render worker — Remotion + (future) Runway/FFmpeg pipeline.
# Tested on Render.com Standard plan (2GB RAM, 1 CPU). Starter plan WILL OOM.

FROM node:20-bookworm-slim

WORKDIR /app

# System deps:
#   - Chromium runtime libraries (Remotion downloads Chromium itself but needs
#     these shared libs to run it headless)
#   - ffmpeg for stitching Runway clips and applying transitions/audio in the
#     Cinematic AI tier
#   - fonts so Remotion text overlays render correctly without falling back to
#     blank squares
#   - ca-certificates for HTTPS to Supabase, OpenAI, and Runway
#   - X11 dev libs + pkg-config + build-essential + python3 so the `gl`
#     npm package (headless WebGL for Cinematic Depth engine) compiles
#     its native binding from source on first install. Without these the
#     npm install step fails with "Package xi was not found in the
#     pkg-config search path" (Render.com build log signature).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libnspr4 \
    libgbm1 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libdbus-1-3 \
    libxi-dev \
    libxext-dev \
    libx11-dev \
    libglu1-mesa-dev \
    libglew-dev \
    pkg-config \
    build-essential \
    python3 \
    xvfb \
    xauth \
    mesa-utils \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (cached layer when only source changes).
# Using `npm install` instead of `npm ci` because the lock file isn't
# regenerated for every package.json change in the sandbox where edits
# happen. `npm install` tolerates the drift; `npm ci` errors out the
# moment lock != package.json (which broke this build when sharp, gl,
# and three were added to package.json without a matching lock update).
# To restore `npm ci` later: regenerate package-lock.json locally with
# `cd render-worker && rm -rf node_modules package-lock.json && npm install`,
# commit the new lock, then swap this RUN back to `npm ci --omit=dev`.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy source.
COPY . .

# Pre-warm Remotion's Chromium download at build time so the first render
# doesn't have to download ~150MB on a cold container.
RUN node -e "require('@remotion/renderer').ensureBrowser().then(() => console.log('Chromium ready')).catch(err => { console.error(err); process.exit(1); })"

ENV PORT=8787
ENV NODE_ENV=production
EXPOSE 8787

# Health check — Render.com uses this to decide if the container is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Custom entrypoint: starts Xvfb deterministically on :99, sets the
# Mesa software-rendering env vars (LIBGL_ALWAYS_SOFTWARE=1, GL
# version override) that the gl npm package needs to create a context
# on a headless container, then exec's node server.mjs. See the
# script itself for why xvfb-run wasn't enough.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
CMD ["/usr/local/bin/docker-entrypoint.sh"]
