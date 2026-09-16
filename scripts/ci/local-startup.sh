#!/usr/bin/env bash
# GitHub runner only: exercise the public launcher, retaining it across steps so
# browser installation uses the same bounded/cache-aware action as other lanes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
: "${RUNNER_TEMP:?A dedicated CI runner is required}"
: "${OPENGENI_COMPOSE_PROJECT:?An isolated acceptance project is required}"
export GH_CONFIG_DIR="$RUNNER_TEMP/opengeni-empty-gh"
mkdir -p "$GH_CONFIG_DIR"
pid_file="$RUNNER_TEMP/opengeni-startup.pid"

stop_launcher() {
  if [ -f "$pid_file" ]; then
    local launcher_pid deadline
    launcher_pid="$(cat "$pid_file")"
    kill -TERM -- "-$launcher_pid" 2>/dev/null || true
    deadline=$((SECONDS + 60))
    while kill -0 -- "-$launcher_pid" 2>/dev/null; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo "Launcher did not stop; refusing a credential-rotating restart" >&2
        return 1
      fi
      sleep 1
    done
    rm "$pid_file"
  fi
}

start_launcher() {
  local attempt="$1" log deadline
  log="$RUNNER_TEMP/opengeni-startup-$attempt.log"
  # No ambient maintainer GitHub login; optional Office runtime may be absent.
  setsid bun run dev >"$log" 2>&1 < /dev/null &
  echo "$!" > "$pid_file"
  deadline=$((SECONDS + 2700))
  until grep -q "OpenGeni dev stack ready:" "$log"; do
    if ! kill -0 "$(cat "$pid_file")" 2>/dev/null || [ "$SECONDS" -ge "$deadline" ]; then
      tail -100 "$log"
      return 1
    fi
    sleep 5
  done
  # This generated file belongs only to this job's unique project.
  set -a
  source .env.runtime
  set +a
  for port in "$OPENGENI_API_PORT" "$OPENGENI_WORKER_HTTP_PORT" "$OPENGENI_TURN_WORKER_HTTP_PORT" "$OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT" "$OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT"; do
    curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$port/healthz"
  done
  curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$OPENGENI_WEB_PORT/" >/dev/null
  curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$OPENGENI_API_PORT/v1/workspaces" >"$RUNNER_TEMP/opengeni-workspaces-$attempt.json"
  git diff --exit-code -- bun.lock package.json
}

case "${1:-}" in
  first)
    test ! -e .env
    test ! -e .env.runtime
    test ! -e node_modules
    start_launcher 1
    cp .env.runtime "$RUNNER_TEMP/opengeni-first-runtime"
    ;;
  restart)
    stop_launcher
    start_launcher 2
    for setting in OPENGENI_API_PORT OPENGENI_WEB_PORT OPENGENI_POSTGRES_HOST_PORT; do
      diff <(grep "^$setting=" "$RUNNER_TEMP/opengeni-first-runtime") <(grep "^$setting=" .env.runtime)
    done
    ;;
  verify)
    set -a
    source .env.runtime
    set +a
    node scripts/ci/local-startup-browser.mjs
    ;;
  clean)
    stop_launcher
    # A failed preflight may not have generated a runtime environment yet.
    if [ -f .env.runtime ]; then bun run dev:clean --yes; fi
    ;;
  *) echo "Usage: $0 first|restart|verify|clean" >&2; exit 2 ;;
esac
