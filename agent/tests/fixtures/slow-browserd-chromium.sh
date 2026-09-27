#!/bin/sh
# Synthetic acceptance fixture: delay SIGINT cleanup, close only this child,
# then reopen its exact profile to prove ownership was released.
set -eu
root="$OPENGENI_BROWSERD_ROOT"
mkdir -p "$root/profile"
launch() {
  rm -f "$root/profile/DevToolsActivePort"
  chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --remote-debugging-port=0 --user-data-dir="$root/profile" about:blank >"$root/chrome.log" 2>&1 &
  owned=$!
  n=0
  until [ -s "$root/profile/DevToolsActivePort" ]; do
    kill -0 "$owned"
    n=$((n+1)); [ "$n" -lt 150 ] || exit 71
    sleep .1
  done
}
stop_owned() {
  kill -TERM "$owned"
  wait "$owned" || true
  if kill -0 "$owned" 2>/dev/null; then exit 72; fi
}
cleanup() {
  sleep 12
  stop_owned
  launch
  stop_owned
  touch "$root/cleaned"
  exit 0
}
trap cleanup INT
launch
printf '%s\n' '{"service":"opengeni-browserd","status":"ready","protocolVersion":1,"runtimeBuildId":"@RUNTIME_BUILD_ID@","computer":false,"hostname":"127.0.0.1","port":12345}'
while :; do sleep .1; done
