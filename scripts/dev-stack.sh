#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Configure model and sandbox credentials before running agent sessions."
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

port_available() {
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

choose_port() {
  local var_name="$1"
  local default_port="$2"
  local current_value="${!var_name:-}"
  if [ -n "$current_value" ] && [ "$current_value" != "$default_port" ]; then
    export "$var_name=$current_value"
    return
  fi
  if port_available "$default_port"; then
    export "$var_name=$default_port"
    return
  fi
  local port
  for port in $(seq $((default_port + 1000)) $((default_port + 1099))); do
    if port_available "$port"; then
      export "$var_name=$port"
      echo "Port ${default_port} is in use; using ${var_name}=${port} for this dev stack run."
      return
    fi
  done
  echo "Could not find a free host port for ${var_name} near ${default_port}." >&2
  exit 1
}

choose_port OPENGENI_POSTGRES_HOST_PORT 5432
choose_port OPENGENI_NATS_HOST_PORT 4222
choose_port OPENGENI_NATS_MONITOR_HOST_PORT 8222
choose_port OPENGENI_TEMPORAL_HOST_PORT 7233
choose_port OPENGENI_MINIO_HOST_PORT 9000
choose_port OPENGENI_MINIO_CONSOLE_HOST_PORT 9001

default_database_url="postgres://opengeni:opengeni@127.0.0.1:5432/opengeni"
if [ "${OPENGENI_DATABASE_URL:-$default_database_url}" = "$default_database_url" ]; then
  export OPENGENI_DATABASE_URL="postgres://opengeni:opengeni@127.0.0.1:${OPENGENI_POSTGRES_HOST_PORT}/opengeni"
fi

default_nats_url="nats://127.0.0.1:4222"
if [ "${OPENGENI_NATS_URL:-$default_nats_url}" = "$default_nats_url" ]; then
  export OPENGENI_NATS_URL="nats://127.0.0.1:${OPENGENI_NATS_HOST_PORT}"
fi

default_temporal_host="127.0.0.1:7233"
if [ "${OPENGENI_TEMPORAL_HOST:-$default_temporal_host}" = "$default_temporal_host" ]; then
  export OPENGENI_TEMPORAL_HOST="127.0.0.1:${OPENGENI_TEMPORAL_HOST_PORT}"
fi

default_object_endpoint="http://127.0.0.1:9000"
if [ "${OPENGENI_OBJECT_STORAGE_ENDPOINT:-$default_object_endpoint}" = "$default_object_endpoint" ]; then
  export OPENGENI_OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:${OPENGENI_MINIO_HOST_PORT}"
fi

default_sandbox_object_endpoint="http://host.docker.internal:9000"
if [ "${OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT:-$default_sandbox_object_endpoint}" = "$default_sandbox_object_endpoint" ]; then
  export OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT="http://host.docker.internal:${OPENGENI_MINIO_HOST_PORT}"
fi

bun install
docker compose up -d postgres nats temporal minio minio-init
(cd packages/db && bun run migrate)
docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .

pids=()
cleanup() {
  if [ "${#pids[@]}" -gt 0 ]; then
    kill "${pids[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

(cd apps/api && bun run dev) &
pids+=("$!")

(cd apps/worker && bun run dev) &
pids+=("$!")

(cd apps/web && bun run dev) &
pids+=("$!")

wait
exit_code=$?
cleanup
exit "$exit_code"
