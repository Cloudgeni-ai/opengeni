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

# FAST PRE-CHECK (lock-free): if the stack is ALREADY up — websockify (the one
# exposed port) AND x11vnc are both listening — re-print the marker and exit 0
# IMMEDIATELY, *before* taking the inner lock. This is the contention escape
# hatch: a no-op caller (the agent turn re-ensuring after a viewer attach already
# brought the stack up) must never serialize behind the lock holder. `nc -z` to
# the two loopback ports is the cheap, sub-millisecond "already up?" signal.
if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1 && nc -z 127.0.0.1 5900 >/dev/null 2>&1; then
  echo "OPENGENI_DESKTOP_UP port=$PORT geometry=${W}x${H} dpi=${DPI} (precheck)"
  exit 0
fi

# FLOCK-IDEMPOTENCY: a single whole-script lock so two concurrent
# `opengeni-desktop-up` invocations (the API on a viewer op + the agent turn,
# both racing after a rollover) serialize — the first brings the stack up, the
# second observes every stage already alive and no-ops. flock auto-releases when
# this shell exits (the FD closes).
exec 9>"$RUN/up.lock"
flock 9

# Re-check under the lock (the stack may have come up while we waited on flock):
# the same cheap port probe, now race-free. A caller that blocked on a mid-run
# launch returns the moment the holder finished, without re-running the stages.
if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1 && nc -z 127.0.0.1 5900 >/dev/null 2>&1; then
  echo "OPENGENI_DESKTOP_UP port=$PORT geometry=${W}x${H} dpi=${DPI} (precheck)"
  exit 0
fi

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
#    Human take-control: NO -viewonly, so VNC viewers can drive mouse+keyboard into
#    :0 (the human intervenes when they want). This is the intended SHARED-desktop
#    behavior: viewer input and the agent's xdotool/scrot (XTEST) input both reach
#    the SAME :0 independently. Control is gated client-side (the "Take control"
#    affordance) and by the stream posture (unguessable short-TTL tunnel URL +
#    server-recorded scoped token); there is no in-box token validation by design.
start x11vnc x11vnc -display :0 -forever -shared -wait 50 -rfbport 5900 -nopw \
  -noxdamage -noxfixes -repeat -ping 1 -speeds lan -o "$RUN/x11vnc.full.log"
for i in $(seq 1 50); do nc -z localhost 5900 && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "x11vnc failed on :5900" >&2; exit 12; }; done

# 4. websockify + noVNC  -> ONE exposed port (6080); 5900 stays localhost-only
start novnc /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen "$PORT" --web /opt/noVNC
for i in $(seq 1 50); do nc -z localhost "$PORT" && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "websockify failed on $PORT" >&2; exit 13; }; done

echo "OPENGENI_DESKTOP_UP port=$PORT geometry=${W}x${H} dpi=${DPI}"
