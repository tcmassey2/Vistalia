#!/bin/bash
# EstateMotion render worker — Docker entrypoint.
#
# Purpose: start Xvfb on a deterministic display number, wait until it's
# actually listening, set the env vars headless WebGL (the `gl` npm
# package) needs to find it, then exec the Node server.
#
# Why not xvfb-run:
#   xvfb-run with -a auto-picks a display number which may not match what
#   we ENV'd to. Without -a it errors if :99 is taken. Either way the
#   wrapper is opaque — when gl says 'failed to create context' we can't
#   tell whether Xvfb died, the display number drifted, or libGL is
#   missing a driver. Explicit script + logs makes the next debug round
#   trivial.

set -e

DISPLAY_NUM=99
SCREEN_GEOM="1920x1080x24"

echo "[entrypoint] starting Xvfb on display :$DISPLAY_NUM with screen $SCREEN_GEOM"
Xvfb :$DISPLAY_NUM -screen 0 $SCREEN_GEOM -nolisten tcp +extension GLX +render -noreset &
XVFB_PID=$!

# Wait up to 5s for Xvfb to be ready. Polling the X socket is more
# reliable than `sleep 1` — on slow containers Xvfb's first frame can
# take 2-3 seconds.
for i in $(seq 1 50); do
  if [ -e "/tmp/.X$DISPLAY_NUM-lock" ] && [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]; then
    echo "[entrypoint] Xvfb ready (pid=$XVFB_PID, took ${i}00ms)"
    break
  fi
  sleep 0.1
done

if ! kill -0 $XVFB_PID 2>/dev/null; then
  echo "[entrypoint] FATAL: Xvfb died before becoming ready. Falling back to no-display mode — Cinematic Depth will fail but Runway + Quick Reel work." >&2
fi

# Env vars the gl npm package reads:
#   DISPLAY                    — which X server to attach to
#   LIBGL_ALWAYS_SOFTWARE=1    — force Mesa software rendering (no GPU)
#                                Critical on headless containers; without
#                                this libGL tries to load a hardware
#                                driver and fails silently → createGL
#                                returns null.
#   MESA_GL_VERSION_OVERRIDE   — bumps reported GL version above what
#                                stock Mesa-on-software claims, so libGL
#                                + ANGLE accept the context.
export DISPLAY=:$DISPLAY_NUM
export LIBGL_ALWAYS_SOFTWARE=1
export MESA_GL_VERSION_OVERRIDE=3.3
export MESA_GLSL_VERSION_OVERRIDE=330

echo "[entrypoint] env: DISPLAY=$DISPLAY LIBGL_ALWAYS_SOFTWARE=$LIBGL_ALWAYS_SOFTWARE MESA_GL_VERSION_OVERRIDE=$MESA_GL_VERSION_OVERRIDE"
echo "[entrypoint] exec node server.mjs"
exec node server.mjs
