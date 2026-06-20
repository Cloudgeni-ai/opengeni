#!/usr/bin/env bash
# Idempotent desktop-stack launcher (productionized from the proven spike).
# Re-runnable after a snapshot rollover / box re-election: the PID guards make a
# second call a no-op when the stack is already up. A second concurrent caller
# serializes on the per-stage flock so we never double-launch.
#
# Env: DESKTOP_W DESKTOP_H DESKTOP_DPI STREAM_PORT (defaults below). DISPLAY=:0.
set -euo pipefail
W="${DESKTOP_W:-1280}"; H="${DESKTOP_H:-800}"; DPI="${DESKTOP_DPI:-96}"
PORT="${STREAM_PORT:-${OPENGENI_DESKTOP_STREAM_PORT:-6080}}"
export DISPLAY=:0
RUN=/tmp/opengeni-desktop; mkdir -p "$RUN"

# FLOCK-IDEMPOTENCY: a single whole-script lock so two concurrent
# `opengeni-desktop-up` invocations (the API on a viewer op + the agent turn,
# both racing after a rollover) serialize — the first brings the stack up, the
# second observes every stage already alive and no-ops. flock auto-releases when
# this shell exits (the FD closes).
exec 9>"$RUN/up.lock"
flock 9

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
start() { # name, cmd...
  local name="$1"; shift
  alive "$name" && return 0
  setsid "$@" >"$RUN/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
}

# 1. Xvfb :0  (RAM framebuffer; 24-bit mandatory for Chrome; no live RANDR -> geometry fixed here)
start xvfb Xvfb :0 -ac -screen 0 "${W}x${H}x24" -dpi "$DPI" -retro -nolisten tcp -nolisten unix
# readiness gate: block until the display answers
for i in $(seq 1 50); do xdpyinfo -display :0 >/dev/null 2>&1 && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "Xvfb failed to come up" >&2; exit 11; }; done

# 2. dbus + XFCE4  (supervised by caller; respawn handled by re-invoking up)
if ! alive xfce; then
  start xfce dbus-launch --exit-with-session startxfce4
fi

# 3. x11vnc  (shares the EXISTING :0; -shared = native N-viewer fan-out; -forever = survive 0 viewers)
#    -viewonly => v1 read-only desktop (F13): NO write path to :0 from viewers; the agent
#    drives input via session.exec'd xdotool (XTEST), not the VNC channel.
start x11vnc x11vnc -display :0 -forever -shared -viewonly -wait 50 -rfbport 5900 -nopw \
  -noxdamage -noxfixes -repeat -ping 1 -speeds lan -o "$RUN/x11vnc.full.log"
for i in $(seq 1 50); do nc -z localhost 5900 && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "x11vnc failed on :5900" >&2; exit 12; }; done

# 4. websockify + noVNC  -> ONE exposed port (6080); 5900 stays localhost-only
start novnc /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen "$PORT" --web /opt/noVNC
for i in $(seq 1 50); do nc -z localhost "$PORT" && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "websockify failed on $PORT" >&2; exit 13; }; done

echo "OPENGENI_DESKTOP_UP port=$PORT geometry=${W}x${H} dpi=${DPI}"
