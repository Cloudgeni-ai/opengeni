#!/usr/bin/env bash
# Supervise the localhost relay independently of the rest of the dev stack. A
# relay crash must look like a short transport interruption, not permanently
# strand every connected-machine Browser/Computer/Terminal surface.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../agent"

child_pid=""
stopping=0
cleanup() {
  stopping=1
  if [ -n "$child_pid" ]; then
    kill "$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

delay=1
while [ "$stopping" = "0" ]; do
  cargo run --quiet -p opengeni-relay &
  child_pid="$!"
  set +e
  wait "$child_pid"
  status="$?"
  set -e
  child_pid=""
  [ "$stopping" = "1" ] && break
  echo "Local relay exited (${status}); restarting in ${delay}s." >&2
  sleep "$delay"
  if [ "$delay" -lt 5 ]; then
    delay=$((delay * 2))
    [ "$delay" -gt 5 ] && delay=5
  fi
done
