#!/usr/bin/env bash
# Idempotent ttyd PTY-over-websocket launcher (Channel-B terminal, symmetric with
# the desktop noVNC stack). Re-runnable after a snapshot rollover / box re-election:
# the curl readiness probe makes a second call a no-op when ttyd is already up.
#
# This is the REAL PTY transport: ttyd keeps a live PTY-backed `bash -l` per
# websocket client. The port (7681) is exposed over the SAME Modal raw-TLS tunnel
# the desktop uses, gated by the SAME scoped stream-token the server records.
#
# ttyd is launched DETACHED (setsid + </dev/null + backgrounded) so it survives the
# `exec` stream teardown that brought it up — exactly like the desktop stack daemons.
#
# Env: TERMINAL_PORT (default 7681).
# SECURITY: ttyd's origin check is OFF by default and is only enabled when
# -O/--check-origin is passed. We deliberately do NOT pass it: the preview app
# serves from a different domain and must be able to open the cross-origin WS. The
# boundary is the unguessable short-TTL Modal tunnel URL + the server-recorded
# scoped stream token (identical posture to the already-shipped desktop). ttyd runs
# --writable because a shell is inherently interactive (accepted v1 posture).
set -euo pipefail
PORT="${TERMINAL_PORT:-7681}"
RUN=/tmp/opengeni-terminal; mkdir -p "$RUN"

# Already up? (idempotent fast-path — survives rollover re-invocation)
if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  echo "OPENGENI_TERMINAL_UP port=${PORT} (already)"
  exit 0
fi

# Advertise only an installed, loadable, supported Bash ABI. Old images and
# already-running daemons retain legacy behavior; this never restarts them.
# The probe does NOT establish readiness of a future client's login shell.
READY_ARGS=()
SHELL_ARGS=(bash -l)
if [[ -r /etc/profile.d/00-opengeni-terminal-ready.sh ]] &&
  bash --noprofile --norc -c 'enable -f /usr/local/lib/opengeni/opengeni-terminal-ready.so opengeni_terminal_ready && opengeni_terminal_ready --probe' 2>/dev/null; then
  READY_ARGS=(-t opengeniInputReady=bash-readline-v1)
  SHELL_ARGS=(env OPENGENI_TERMINAL_READY=bash-readline-v1 bash -l)
fi

# Launch ttyd DETACHED so it outlives the exec stream that spawned it.
setsid env HOME=/workspace ttyd --writable --port "${PORT}" --interface 0.0.0.0 \
  --cwd /workspace --max-clients 8 "${READY_ARGS[@]}" -- "${SHELL_ARGS[@]}" \
  >"$RUN/ttyd.log" 2>&1 </dev/null &

# Readiness gate: block until ttyd answers HTTP on the port.
for i in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 && {
    echo "OPENGENI_TERMINAL_UP port=${PORT}"
    exit 0
  }
  sleep 0.1
done
echo "ttyd failed to come up on ${PORT}" >&2
exit 14
