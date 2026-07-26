#!/usr/bin/env bash
# Second, independent reader of :0 (x11grab). Runs alongside x11vnc with no
# interference. The recording loop (P4.3) drives start/stop; here we only spawn
# ffmpeg and stamp the PID so opengeni-desktop-down can SIGINT it for a clean
# finalize. Geometry is read live from the X server (matches the current Xvfb),
# never a stale passed-in value.
set -euo pipefail
FPS="${RECORD_FPS:-15}"
OUT="${RECORD_OUT:-/tmp/opengeni-desktop/recording-$(date +%s).mp4}"
RUN=/tmp/opengeni-desktop; mkdir -p "$RUN"
export DISPLAY=:0

# Prefer the live display geometry (survives a setGeometry restart); fall back to
# the env hints, then the canonical default.
GEO="$(xdotool getdisplaygeometry 2>/dev/null | tr ' ' 'x' || true)"
if [ -n "${GEO:-}" ] && [ "${GEO}" != "x" ]; then
  SIZE="$GEO"
else
  SIZE="${DESKTOP_W:-1280}x${DESKTOP_H:-800}"
fi

setsid ffmpeg -y -f x11grab -draw_mouse 1 -framerate "$FPS" -video_size "$SIZE" -i :0.0 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart "$OUT" \
  >"$RUN/record.log" 2>&1 &
echo $! >"$RUN/record.pid"
echo "OPENGENI_RECORD_STARTED out=$OUT pid=$(cat "$RUN/record.pid")"
