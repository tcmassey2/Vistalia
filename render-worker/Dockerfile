# EstateMotion render worker — Remotion + Runway Gen-4 Turbo pipeline.
# v24: stripped back to lean v22-era image. Depth engine code is in
# the repo but not routed by server.mjs, so we don't need its heavy
# system deps (X11 dev libs, xvfb, build-essential, Mesa).
# Render Pro 4GB plan recommended. Smaller plans WILL OOM on Gen-4 renders.

FROM node:20-bookworm-slim

WORKDIR /app

# System deps:
#   - Chromium runtime libraries (Remotion downloads Chromium itself but
#     needs these shared libs to run it headless for Quick Reel renders).
#   - ffmpeg for stitching Runway clips and audio/transitions.
#   - fonts so Remotion text overlays render correctly.
#   - ca-certificates for HTTPS to Supabase, OpenAI, Runway, ElevenLabs.
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
  && rm -rf /var/lib/apt/lists/*

# Install dependencies. Using `npm install` rather than `npm ci` because
# the lock file isn't regenerated in the sandbox where edits happen.
# Tolerates lock-file drift. Regenerate the lock locally + swap to
# `npm ci --omit=dev` if you want stricter installs.
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

CMD ["node", "server.mjs"]
