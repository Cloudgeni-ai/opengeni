#!/usr/bin/env bash
# Container-free PostgreSQL/NATS/Temporal/MinIO for one OpenGeni worktree.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
if [ -f .env.runtime ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.runtime
  set +a
fi

# shellcheck disable=SC1091
. ./scripts/dev-stack-project.sh
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(resolve_compose_project_name)}"
if [ -z "$COMPOSE_PROJECT_NAME" ]; then
  echo "Refusing to manage native infrastructure without a project name." >&2
  exit 1
fi
export COMPOSE_PROJECT_NAME

# Keep the helper independently usable for diagnostics and test setup. The full
# launcher normally selects and exports these values before calling `start`, but
# a direct invocation after `dev:clean` must not fail on an older copied .env.
OPENGENI_POSTGRES_HOST_PORT="${OPENGENI_POSTGRES_HOST_PORT:-5432}"
OPENGENI_NATS_HOST_PORT="${OPENGENI_NATS_HOST_PORT:-4222}"
OPENGENI_NATS_MONITOR_HOST_PORT="${OPENGENI_NATS_MONITOR_HOST_PORT:-8222}"
OPENGENI_NATS_CONFIG_FILE="${OPENGENI_NATS_CONFIG_FILE:-$(pwd)/deploy/nats/local-development.conf}"
OPENGENI_TEMPORAL_HOST_PORT="${OPENGENI_TEMPORAL_HOST_PORT:-7233}"
OPENGENI_TEMPORAL_UI_HOST_PORT="${OPENGENI_TEMPORAL_UI_HOST_PORT:-8233}"
OPENGENI_MINIO_HOST_PORT="${OPENGENI_MINIO_HOST_PORT:-9000}"
OPENGENI_MINIO_CONSOLE_HOST_PORT="${OPENGENI_MINIO_CONSOLE_HOST_PORT:-9001}"
OPENGENI_OBJECT_STORAGE_FIXTURE="${OPENGENI_OBJECT_STORAGE_FIXTURE:-minio}"
OPENGENI_OBJECT_STORAGE_BUCKET="${OPENGENI_OBJECT_STORAGE_BUCKET:-opengeni-files}"

STATE_DIR="$(pwd)/.opengeni/native/${COMPOSE_PROJECT_NAME}"
LOG_DIR="$STATE_DIR/logs"
PID_DIR="$STATE_DIR/pids"
RUNTIME_DIR="$STATE_DIR/runtime"
# PostgreSQL refuses to run as root. Sandboxes often mount the repository root
# mode 0700, so the system postgres user cannot traverse to an in-repository
# cluster without also gaining access to source and local secrets. Keep the
# ordinary checkout-local path when it is traversable; otherwise use an exact,
# hashed project directory under /var/tmp and remove it on `dev:clean`.
repository_state_id="$(printf '%s' "$(pwd)" | sha256sum | cut -c1-16)"
POSTGRES_STATE_ROOT="$STATE_DIR/postgres"
if [ "$(id -u)" = "0" ] && id -u postgres >/dev/null 2>&1 &&
  ! runuser -u postgres -- test -x "$(pwd)"; then
  POSTGRES_STATE_ROOT="/var/tmp/opengeni-native-postgres/${repository_state_id}-${COMPOSE_PROJECT_NAME}"
fi
POSTGRES_DATA="$POSTGRES_STATE_ROOT/data"
POSTGRES_SOCKET="${TMPDIR:-/tmp}/opengeni-pg-${OPENGENI_POSTGRES_HOST_PORT:-5432}"
POSTGRES_LOG="$POSTGRES_STATE_ROOT/postgres.log"
NATS_DATA="$STATE_DIR/nats"
TEMPORAL_DATA="$STATE_DIR/temporal"
MINIO_DATA="$STATE_DIR/minio"
MC_CONFIG_DIR="$STATE_DIR/mc"
POSTGRES_BINDIR="$(pg_config --bindir 2>/dev/null || true)"

usage() {
  cat <<'EOF'
Usage: scripts/dev-native-infra.sh <start|status|ps|logs|down> [options]

  start             Start PostgreSQL, NATS, Temporal, and MinIO.
  status [--quiet]  Verify all four native dependencies are running.
  ps                 Print native dependency process state and logs.
  logs [-f] [name]  Show logs (names: postgres, nats, temporal, minio).
  down [--clean]    Stop native dependencies; --clean also removes their data.
EOF
}

die() {
  echo "Native OpenGeni infrastructure: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command '$1'"
}

pid_file() {
  printf '%s/%s.pid\n' "$PID_DIR" "$1"
}

log_file() {
  if [ "$1" = "postgres" ]; then
    printf '%s\n' "$POSTGRES_LOG"
  else
    printf '%s/%s.log\n' "$LOG_DIR" "$1"
  fi
}

service_pid() {
  local file
  file="$(pid_file "$1")"
  [ -f "$file" ] && sed -n '1p' "$file"
}

service_start_time() {
  local file
  file="$(pid_file "$1")"
  [ -f "$file" ] && sed -n '2p' "$file"
}

process_start_time() {
  local pid="$1"
  [ -r "/proc/$pid/stat" ] || return 1
  awk '{print $22}' "/proc/$pid/stat"
}

service_running() {
  local pid expected_start actual_start
  pid="$(service_pid "$1")"
  expected_start="$(service_start_time "$1")"
  [ -n "$pid" ] && [ -n "$expected_start" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  actual_start="$(process_start_time "$pid" 2>/dev/null || true)"
  [ -n "$actual_start" ] && [ "$actual_start" = "$expected_start" ]
}

run_as_postgres() {
  if [ "$(id -u)" = "0" ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

db_running() {
  [ -n "$POSTGRES_BINDIR" ] &&
    [ -f "$POSTGRES_DATA/PG_VERSION" ] &&
    run_as_postgres "$POSTGRES_BINDIR/pg_ctl" -D "$POSTGRES_DATA" status >/dev/null 2>&1
}

start_service() {
  local name="$1"
  shift
  require_command setsid
  if service_running "$name"; then
    echo "  ${name}=already-running (pid $(service_pid "$name"))"
    return
  fi
  rm -f "$(pid_file "$name")"
  (
    local child_pid child_start
    nohup setsid "$@" >"$(log_file "$name")" 2>&1 &
    child_pid="$!"
    child_start="$(process_start_time "$child_pid")"
    printf '%s\n%s\n' "$child_pid" "$child_start" >"$(pid_file "$name")"
  )
  sleep 0.2
  if ! service_running "$name"; then
    tail -n 60 "$(log_file "$name")" >&2 || true
    die "$name exited during startup"
  fi
  echo "  ${name}=started (pid $(service_pid "$name"))"
}

stop_service() {
  local name="$1"
  local pid pgid attempt
  pid="$(service_pid "$name")"
  if [ -z "$pid" ] || ! service_running "$name"; then
    rm -f "$(pid_file "$name")"
    return
  fi
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  if [ "$pgid" = "$pid" ]; then
    kill -TERM -- "-$pid" >/dev/null 2>&1 || true
  else
    kill -TERM "$pid" >/dev/null 2>&1 || true
  fi
  for attempt in $(seq 1 50); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$(pid_file "$name")"
      echo "  ${name}=stopped"
      return
    fi
    sleep 0.1
  done
  if [ "$pgid" = "$pid" ]; then
    kill -KILL -- "-$pid" >/dev/null 2>&1 || true
  else
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$(pid_file "$name")"
  echo "  ${name}=killed-after-timeout"
}

wait_for_tcp() {
  local name="$1"
  local port="$2"
  local attempts="${3:-150}"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
      return
    fi
    if [ "$name" != "postgres" ] && ! service_running "$name"; then
      tail -n 60 "$(log_file "$name")" >&2 || true
      die "$name exited before listening on 127.0.0.1:$port"
    fi
    sleep 0.2
  done
  tail -n 60 "$(log_file "$name")" >&2 || true
  die "$name did not listen on 127.0.0.1:$port"
}

start_postgres() {
  require_command pg_config
  require_command psql
  require_command pg_isready
  [ -n "$POSTGRES_BINDIR" ] || die "pg_config did not report the PostgreSQL binary directory"
  [ -x "$POSTGRES_BINDIR/initdb" ] || die "initdb is unavailable in $POSTGRES_BINDIR"
  [ -x "$POSTGRES_BINDIR/pg_ctl" ] || die "pg_ctl is unavailable in $POSTGRES_BINDIR"

  mkdir -p "$POSTGRES_DATA" "$POSTGRES_SOCKET"
  if [ "$POSTGRES_STATE_ROOT" != "$STATE_DIR/postgres" ]; then
    chmod 0711 "$(dirname "$POSTGRES_STATE_ROOT")"
  fi
  chmod 0711 "$(pwd)/.opengeni" "$(pwd)/.opengeni/native" "$STATE_DIR"
  if [ "$(id -u)" = "0" ]; then
    chown -R postgres:postgres "$POSTGRES_STATE_ROOT" "$POSTGRES_SOCKET"
  fi
  if [ ! -f "$POSTGRES_DATA/PG_VERSION" ]; then
    run_as_postgres "$POSTGRES_BINDIR/initdb" \
      -D "$POSTGRES_DATA" \
      -U opengeni \
      --auth=trust \
      --no-locale \
      --encoding=UTF8 >/dev/null
  fi
  if ! db_running; then
    run_as_postgres "$POSTGRES_BINDIR/pg_ctl" \
      -D "$POSTGRES_DATA" \
      -l "$POSTGRES_LOG" \
      -o "-h 127.0.0.1 -p ${OPENGENI_POSTGRES_HOST_PORT} -k ${POSTGRES_SOCKET}" \
      start >/dev/null
  fi
  wait_for_tcp postgres "$OPENGENI_POSTGRES_HOST_PORT"
  if ! psql -h 127.0.0.1 -p "$OPENGENI_POSTGRES_HOST_PORT" -U opengeni -d postgres -tAc \
    "select 1 from pg_database where datname = 'opengeni'" | grep -q '^1$'; then
    "$POSTGRES_BINDIR/createdb" -h 127.0.0.1 -p "$OPENGENI_POSTGRES_HOST_PORT" -U opengeni opengeni
  fi
  psql -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p "$OPENGENI_POSTGRES_HOST_PORT" -U opengeni -d opengeni \
    -c "ALTER ROLE opengeni WITH PASSWORD 'opengeni'" \
    -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto' \
    -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null
  echo "  postgres=ready (127.0.0.1:${OPENGENI_POSTGRES_HOST_PORT})"
}

start_stack() {
  require_command nats-server
  require_command temporal
  require_command minio
  require_command mc
  [ "${OPENGENI_OBJECT_STORAGE_FIXTURE:-}" = "minio" ] ||
    die "native infrastructure requires OPENGENI_OBJECT_STORAGE_FIXTURE=minio"

  mkdir -p "$LOG_DIR" "$PID_DIR" "$RUNTIME_DIR" "$NATS_DATA" "$TEMPORAL_DATA" "$MINIO_DATA" "$MC_CONFIG_DIR"
  start_postgres

  start_service nats \
    nats-server \
      -c "$OPENGENI_NATS_CONFIG_FILE" \
      -a 127.0.0.1 \
      -p "$OPENGENI_NATS_HOST_PORT" \
      -m "$OPENGENI_NATS_MONITOR_HOST_PORT"
  start_service temporal \
    temporal server start-dev \
      --ip 127.0.0.1 \
      --port "$OPENGENI_TEMPORAL_HOST_PORT" \
      --ui-ip 127.0.0.1 \
      --ui-port "$OPENGENI_TEMPORAL_UI_HOST_PORT" \
      --db-filename "$TEMPORAL_DATA/temporal.db" \
      --ui-disable-news-fetch \
      --log-level warn
  start_service minio \
    env MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
      minio server "$MINIO_DATA" \
        --address "127.0.0.1:${OPENGENI_MINIO_HOST_PORT}" \
        --console-address "127.0.0.1:${OPENGENI_MINIO_CONSOLE_HOST_PORT}"

  wait_for_tcp nats "$OPENGENI_NATS_HOST_PORT"
  wait_for_tcp temporal "$OPENGENI_TEMPORAL_HOST_PORT" 300
  wait_for_tcp minio "$OPENGENI_MINIO_HOST_PORT"

  mc --config-dir "$MC_CONFIG_DIR" alias set local \
    "http://127.0.0.1:${OPENGENI_MINIO_HOST_PORT}" minioadmin minioadmin >/dev/null
  mc --config-dir "$MC_CONFIG_DIR" mb --ignore-existing \
    "local/${OPENGENI_OBJECT_STORAGE_BUCKET:-opengeni-files}" >/dev/null
  echo "  minio-bucket=${OPENGENI_OBJECT_STORAGE_BUCKET:-opengeni-files}"
}

all_running() {
  db_running && service_running nats && service_running temporal && service_running minio
}

print_status() {
  local quiet="${1:-}"
  if all_running; then
    if [ "$quiet" != "--quiet" ]; then
      echo "Native OpenGeni infrastructure is running for ${COMPOSE_PROJECT_NAME}."
    fi
    return 0
  fi
  if [ "$quiet" != "--quiet" ]; then
    echo "Native OpenGeni infrastructure is not fully running for ${COMPOSE_PROJECT_NAME}." >&2
  fi
  return 1
}

print_ps() {
  printf '%-12s %-10s %-8s %s\n' SERVICE STATE PID LOG
  local name pid state
  for name in postgres nats temporal minio; do
    if [ "$name" = "postgres" ]; then
      if db_running; then
        pid="$(sed -n '1p' "$POSTGRES_DATA/postmaster.pid")"
        state=running
      else
        pid=-
        state=stopped
      fi
    else
      pid="$(service_pid "$name")"
      if service_running "$name"; then
        state=running
      else
        pid=-
        state=stopped
      fi
    fi
    printf '%-12s %-10s %-8s %s\n' "$name" "$state" "$pid" "$(log_file "$name")"
  done
}

show_logs() {
  local follow=0
  local names=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
    -f | --follow) follow=1 ;;
    postgres | nats | temporal | minio) names+=("$1") ;;
    *) die "unknown log option or service '$1'" ;;
    esac
    shift
  done
  if [ "${#names[@]}" -eq 0 ]; then
    names=(postgres nats temporal minio)
  fi
  local files=()
  local name file
  for name in "${names[@]}"; do
    file="$(log_file "$name")"
    [ -f "$file" ] && files+=("$file")
  done
  [ "${#files[@]}" -gt 0 ] || die "no native infrastructure logs exist yet"
  if [ "$follow" = "1" ]; then
    exec tail -n 100 -F "${files[@]}"
  fi
  tail -n 100 "${files[@]}"
}

stop_stack() {
  local clean="${1:-}"
  local name
  for name in minio temporal nats; do
    stop_service "$name"
  done
  if db_running; then
    run_as_postgres "$POSTGRES_BINDIR/pg_ctl" -D "$POSTGRES_DATA" -m fast stop >/dev/null
    echo "  postgres=stopped"
  fi
  if [ "$clean" = "--clean" ]; then
    case "$STATE_DIR" in
    "$(pwd)/.opengeni/native/"*) ;;
    *) die "refusing to clean unexpected state path $STATE_DIR" ;;
    esac
    case "$POSTGRES_STATE_ROOT" in
    "$STATE_DIR/postgres" | "/var/tmp/opengeni-native-postgres/${repository_state_id}-${COMPOSE_PROJECT_NAME}") ;;
    *) die "refusing to clean unexpected PostgreSQL state path $POSTGRES_STATE_ROOT" ;;
    esac
    rm -rf -- "$STATE_DIR"
    rm -rf -- "$POSTGRES_STATE_ROOT"
    rm -rf -- "$POSTGRES_SOCKET"
    echo "  removed native data for ${COMPOSE_PROJECT_NAME}"
  elif [ -n "$clean" ]; then
    die "unknown down option '$clean'"
  fi
}

command="${1:-help}"
shift || true
case "$command" in
start) start_stack "$@" ;;
status) print_status "$@" ;;
ps) print_ps "$@" ;;
logs) show_logs "$@" ;;
down) stop_stack "$@" ;;
help | -h | --help) usage ;;
*)
  usage >&2
  die "unknown command '$command'"
  ;;
esac