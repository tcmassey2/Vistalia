# EstateMotion render worker — Remotion + Runway Gen-4 Turbo pipeline.
# v24: stripped back to lean v22-era image. Depth engine code is in
# the repo but not routed by server.mjs, so we don't need its heavy
# system deps (X11 dev libs, xvfb, build-essential, Mesa).
# v64: python3 sidecar for the depth-parallax engine (tools/parallax.py) —
# numpy + opencv-contrib-headless + onnxruntime with the Depth Anything V2
# small ONNX and (v64.3) big-LaMa baked in (~470 MB). No X11, no GL.
# Render Pro 4GB plan recommended. Smaller plans WILL OOM on Gen-4 renders.

FROM node:20-bookworm-slim

WORKDIR /app

# System deps:
#   - Chromium runtime libraries (Remotion downloads Chromium itself but
#     needs these shared libs to run it headless for Quick Reel renders).
#   - ffmpeg for stitching Runway clips and audio/transitions.
#   - fonts so Remotion text overlays render correctly.
#   - ca-certificates for HTTPS to Supabase, OpenAI, Runway, ElevenLabs.
#   - python3/pip + curl for the v64 depth-parallax sidecar.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
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
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# v64 depth-parallax sidecar (tools/parallax.py, driven by src/parallax-job.mjs).
# Pinned ranges known to ship cp311 wheels; opencv-CONTRIB for LSD line
# segments + ximgproc joint-bilateral. --break-system-packages: PEP 668 on
# bookworm; this image has no other Python consumers.
RUN pip3 install --no-cache-dir --break-system-packages \
      "numpy>=1.26,<2.4" \
      "opencv-contrib-python-headless>=4.10,<4.14" \
      "onnxruntime>=1.19,<1.26"

# Depth Anything V2 small (Apache-2.0, ~99 MB fp32 ONNX). Baked into the
# image so a cold container never downloads at render time; the size check
# fails the build rather than shipping an HTML error page as a model.
# Override the path at runtime with PARALLAX_MODEL_PATH.
RUN mkdir -p /app/models \
  && curl -fsSL --retry 3 --retry-delay 5 \
       -o /app/models/dav2_small.onnx \
       "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx" \
  && python3 -c "import os,sys; s=os.path.getsize('/app/models/dav2_small.onnx'); print('depth model', s, 'bytes'); sys.exit(0 if s > 50_000_000 else 1)"

# v64.3: big-LaMa (Apache-2.0, Carve's ONNX export, ~208 MB) inpaints the
# strip a lateral move reveals behind foreground objects — once per scene,
# CPU. Without it the renderer falls back to OpenCV Telea (smeary) and logs
# "plate telea". Override the path with PARALLAX_LAMA_PATH.
RUN curl -fsSL --retry 3 --retry-delay 5 \
       -o /app/models/lama_fp32.onnx \
       "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx" \
  && python3 -c "import os,sys; s=os.path.getsize('/app/models/lama_fp32.onnx'); print('lama model', s, 'bytes'); sys.exit(0 if s > 150_000_000 else 1)"

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

# v64: prove the sidecar imports and sees the model, at build time.
RUN python3 tools/parallax.py --check --model /app/models/dav2_small.onnx --lama /app/models/lama_fp32.onnx

ENV PORT=8787
ENV NODE_ENV=production
EXPOSE 8787

# Health check — Render.com uses this to decide if the container is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "server.mjs"]
