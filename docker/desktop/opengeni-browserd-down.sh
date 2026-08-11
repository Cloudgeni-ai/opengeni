#!/usr/bin/env bash
# Tear down only the browser controller recorded by its exact PID file.
set -uo pipefail

RUN="${OPENGENI_BROWSERD_RUN_DIRECTORY:-/tmp/opengeni-browserd}"
PID_FILE="${RUN}/browserd.pid"
BIN=/usr/local/bin/opengeni-browserd

if [ -s "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if [[ "$PID" =~ ^[1-9][0-9]*$ ]] && \
    [ "$(readlink -f "/proc/${PID}/exe" 2>/dev/null || true)" = "$(readlink -f "$BIN")" ]; then
    kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

echo "OPENGENI_BROWSERD_DOWN"
