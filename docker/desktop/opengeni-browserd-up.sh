#!/usr/bin/env bash
# Idempotently launch the placement-local OpenGeni browser controller. The
# controller token is read from an owner-only file; its value never enters argv,
# stdout, or the process environment.
set -euo pipefail

PORT="${OPENGENI_BROWSERD_PORT:-7682}"
TOKEN_FILE="${OPENGENI_BROWSERD_ADMIN_TOKEN_FILE:?OPENGENI_BROWSERD_ADMIN_TOKEN_FILE is required}"
RUN="${OPENGENI_BROWSERD_RUN_DIRECTORY:-/tmp/opengeni-browserd}"
ROOT="${OPENGENI_BROWSERD_ROOT:-${RUN}/state}"
PID_FILE="${RUN}/browserd.pid"
LOG_FILE="${RUN}/browserd.log"
BIN=/usr/local/bin/opengeni-browserd
BROWSER_EXECUTABLE="${OPENGENI_BROWSERD_BROWSER_EXECUTABLE:-}"
COMPUTER_NATIVE_BINARY="${OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY:-}"
STARTUP_TIMEOUT_SECONDS="${OPENGENI_BROWSERD_STARTUP_TIMEOUT_SECONDS:-30}"

if ! [[ "$STARTUP_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || [ "$STARTUP_TIMEOUT_SECONDS" -gt 120 ]; then
  echo "browser controller startup timeout must be an integer from 1 to 120 seconds" >&2
  exit 14
fi
STARTUP_ATTEMPTS=$((STARTUP_TIMEOUT_SECONDS * 10))

if [ -z "$BROWSER_EXECUTABLE" ] && [ -r /etc/opengeni/browser-engine ]; then
  BROWSER_EXECUTABLE="$(head -n 1 /etc/opengeni/browser-engine)"
fi
if [ ! -x "$BROWSER_EXECUTABLE" ]; then
  for candidate in /opt/google/chrome/google-chrome /usr/lib/chromium/chromium /usr/bin/chromium; do
    if [ -x "$candidate" ]; then
      BROWSER_EXECUTABLE="$candidate"
      break
    fi
  done
fi
if [ -n "$COMPUTER_NATIVE_BINARY" ] && [ ! -x "$COMPUTER_NATIVE_BINARY" ]; then
  echo "computer controller native helper is not executable" >&2
  exit 17
fi
if [ ! -x "$BROWSER_EXECUTABLE" ]; then
  echo "browser controller has no supported Chromium engine" >&2
  exit 16
fi

umask 077
mkdir -p "$RUN" "$ROOT"
chmod 0700 "$RUN" "$ROOT"

same_process() {
  local pid="$1"
  [ -d "/proc/${pid}" ] || return 1
  [ "$(readlink -f "/proc/${pid}/exe" 2>/dev/null || true)" = "$(readlink -f "$BIN")" ]
}

admin_ready() {
  {
    printf 'header = "Authorization: Bearer '
    tr -d '\r\n' <"$TOKEN_FILE"
    printf '"\n'
  } | curl --disable --config - --noproxy '*' --fail --silent --show-error \
    "http://127.0.0.1:${PORT}/v1/browser-sessions" >/dev/null 2>&1
}

print_startup_log() {
  if [ -s "$LOG_FILE" ]; then
    echo "browser controller startup log (last 80 lines, at most 16 KiB):" >&2
    tail -c 16384 "$LOG_FILE" | tail -n 80 >&2
  fi
}

if [ -s "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if [[ "$PID" =~ ^[1-9][0-9]*$ ]] && same_process "$PID" && admin_ready; then
    echo "OPENGENI_BROWSERD_UP port=${PORT} (already)"
    exit 0
  fi
  if [[ "$PID" =~ ^[1-9][0-9]*$ ]] && same_process "$PID"; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# Refuse to mask a foreign listener. A healthy response is insufficient: only
# the exact PID we launched plus a successful admin-authenticated request proves
# controller identity.
if curl --disable --noproxy '*' --fail --silent "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  echo "browser controller port ${PORT} is occupied by an unmanaged process" >&2
  exit 15
fi

setsid env \
  OPENGENI_BROWSERD_ROOT="$ROOT" \
  OPENGENI_BROWSERD_ADMIN_TOKEN_FILE="$TOKEN_FILE" \
  OPENGENI_BROWSERD_HOSTNAME="0.0.0.0" \
  OPENGENI_BROWSERD_PORT="$PORT" \
  OPENGENI_BROWSERD_AGENT_BROWSER_BINARY="${OPENGENI_BROWSERD_AGENT_BROWSER_BINARY:-/usr/local/lib/opengeni/agent-browser}" \
  OPENGENI_BROWSERD_LIGHTPANDA_BINARY="${OPENGENI_BROWSERD_LIGHTPANDA_BINARY:-/usr/local/lib/opengeni/lightpanda}" \
  OPENGENI_BROWSERD_BROWSER_EXECUTABLE="$BROWSER_EXECUTABLE" \
  OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY="$COMPUTER_NATIVE_BINARY" \
  OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE="${OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE:-isolated_linux}" \
  OPENGENI_BROWSERD_ALLOWED_ORIGINS="${OPENGENI_BROWSERD_ALLOWED_ORIGINS:-}" \
  "$BIN" >"$LOG_FILE" 2>&1 </dev/null &
PID=$!
printf '%s\n' "$PID" >"${PID_FILE}.new"
mv -f "${PID_FILE}.new" "$PID_FILE"

for _ in $(seq 1 "$STARTUP_ATTEMPTS"); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "browser controller exited during startup" >&2
    print_startup_log
    exit 14
  fi
  # setsid launches `env`, which then execs browserd. On a cold or remote
  # placement /proc/$PID/exe can briefly still name env even though the exact
  # child is healthy and transitioning. Wait for that exec boundary; only a
  # physically absent PID is an early exit.
  if ! same_process "$PID"; then
    sleep 0.1
    continue
  fi
  if admin_ready; then
    echo "OPENGENI_BROWSERD_UP port=${PORT}"
    exit 0
  fi
  sleep 0.1
done

kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "browser controller failed to become ready on ${PORT} within ${STARTUP_TIMEOUT_SECONDS}s" >&2
print_startup_log
exit 14
