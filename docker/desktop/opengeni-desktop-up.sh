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

# ---- SESSION ENVIRONMENT (idempotent; fixes the "Input/output error" + app breakage) ----
# These export into the XFCE session because XFCE (stage 2 below) inherits this shell's
# env. All steps are safe to re-run on every up.
#
# (a) A writable XDG_RUNTIME_DIR. The box has no logind, so /run/user/0 is absent and
#     XDG_RUNTIME_DIR is empty — which makes GTK/Chrome spam socket errors and degrades
#     dbus-dependent apps. Point it at a private 0700 dir on /tmp.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime-0}"
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
# (b) Suppress the at-spi/a11y bus warning every GTK app prints (org.a11y.Bus not
#     provided). at-spi2-core is installed, but with no session bus wired the dbind
#     warning is just noise; turn the bridge off cheaply.
export NO_AT_BRIDGE=1
export GTK_A11Y=none
# (c) A SYSTEM dbus so apps that want the system bus (power/network/notify integration)
#     stop erroring on /run/dbus/system_bus_socket. Idempotent: only launch if absent.
if [ ! -S /run/dbus/system_bus_socket ]; then
  mkdir -p /run/dbus
  dbus-daemon --system --fork >/dev/null 2>&1 || true
fi

# (d) Re-assert the DEFAULT BROWSER config for THIS session's HOME. The image bakes the
#     config system-wide (/etc/xdg) and into the /workspace skel, but a fresh /workspace
#     volume mount can shadow the skel — so write the user copies too. This makes the
#     XFCE panel/menu "Web Browser" (exo-open --launch WebBrowser) resolve to the
#     container-safe wrapper instead of the stock chrome-no-flags helper that I/O-errors.
HOME="${HOME:-/workspace}"
mkdir -p "$HOME/.config/xfce4" "$HOME/.config"
if [ ! -f "$HOME/.config/xfce4/helpers.rc" ]; then
  printf '[Default]\nWebBrowser=opengeni-browser\n' > "$HOME/.config/xfce4/helpers.rc"
fi
if [ ! -f "$HOME/.config/mimeapps.list" ]; then
  printf '[Default Applications]\nx-scheme-handler/http=opengeni-browser.desktop\nx-scheme-handler/https=opengeni-browser.desktop\ntext/html=opengeni-browser.desktop\nx-scheme-handler/about=opengeni-browser.desktop\nx-scheme-handler/unknown=opengeni-browser.desktop\n' \
    > "$HOME/.config/mimeapps.list"
fi

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

# 1b. KEYMAP — Xvfb boots with a SPARSE default XKB map: only a handful of keysyms
# have a keycode, so x11vnc silently drops any keysym noVNC sends that isn't in it
# ('a'/'s' happen to map, 'd'/'l' don't). Load the full US layout onto :0 so EVERY
# keysym resolves to a keycode. Idempotent: re-running just re-asserts the same map.
# setxkbmap (x11-xserver-utils) no-ops silently unless xkb-data (rules/symbols) and
# xkbcomp (x11-xkb-utils) are present — both are in the desktop apt layer. We run it
# UNCONDITIONALLY on every up (not PID-guarded) so a box whose stack pre-check was
# skipped still gets the map; if it somehow fails we warn but don't abort the stack.
DISPLAY=:0 setxkbmap us 2>>"$RUN/setxkbmap.log" \
  || echo "WARN: setxkbmap us failed (keys may drop); see $RUN/setxkbmap.log" >&2

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
  -xkb -noxdamage -noxfixes -repeat -ping 1 -speeds lan -o "$RUN/x11vnc.full.log"
for i in $(seq 1 50); do nc -z localhost 5900 && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "x11vnc failed on :5900" >&2; exit 12; }; done

# 4. websockify + noVNC  -> ONE exposed port (6080); 5900 stays localhost-only
start novnc /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen "$PORT" --web /opt/noVNC
for i in $(seq 1 50); do nc -z localhost "$PORT" && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "websockify failed on $PORT" >&2; exit 13; }; done

echo "OPENGENI_DESKTOP_UP port=$PORT geometry=${W}x${H} dpi=${DPI}"
