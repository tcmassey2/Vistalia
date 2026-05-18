#!/bin/sh
# EstateMotion render worker — Docker entrypoint (minimal version).
#
# Previous version used `set -e` + a polling loop, which combined to
# silently exit the script before `exec node server.mjs` ever ran.
# Result: no port bound, Render's port-scan timeout fires, container
# is marked failed.
#
# This version is stripped to the bare minimum:
#   1. Start Xvfb in the background. Don't check if it succeeded —
#      if it dies, Cinematic Depth fails gracefully via the lazy
#      gl import; Runway + Quick Reel still work.
#   2. Sleep 1s so Xvfb has time to set up its socket. Crude but
#      reliable — no polling logic that can misbehave.
#   3. Export the env vars the gl package needs.
#   4. exec node so signals propagate (PID 1).
#
# No `set -e`. No defensive logic. Node MUST start.

Xvfb :99 -screen 0 1920x1080x24 +extension GLX +render -noreset > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1

export DISPLAY=:99
export LIBGL_ALWAYS_SOFTWARE=1
export MESA_GL_VERSION_OVERRIDE=3.3
export MESA_GLSL_VERSION_OVERRIDE=330

echo "[entrypoint] Xvfb pid=$XVFB_PID, DISPLAY=$DISPLAY, LIBGL_ALWAYS_SOFTWARE=$LIBGL_ALWAYS_SOFTWARE"
echo "[entrypoint] exec node server.mjs"
exec node server.mjs
