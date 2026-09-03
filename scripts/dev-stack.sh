#!/usr/bin/env bash
# Full local OpenGeni stack for one checkout / git worktree.
# Isolates the infrastructure project + host ports so parallel worktrees do not
# share Postgres/NATS/Temporal/object storage or race on :8000/:3000.
set -euo pipefail

case "${1:-}" in
--opengeni-dev-stack-token=*)
  opengeni_dev_stack_token="${1#--opengeni-dev-stack-token=}"
  shift
  ;;
*)
  opengeni_dev_stack_token="$(bun -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"
  exec bash "$0" "--opengeni-dev-stack-token=${opengeni_dev_stack_token}" "$@"
  ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Configure model and sandbox credentials before running agent sessions."
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Docker remains the preferred local infrastructure backend when its daemon is
# reachable. Restricted sandboxes commonly have no daemon (or only a dead CLI),
# so auto falls back to equivalent native processes without changing `bun run
# dev`. An explicit Docker request still fails closed.
# shellcheck disable=SC1091
. ./scripts/dev-stack-backend.sh
OPENGENI_DEV_BACKEND="$(opengeni_resolve_dev_backend)"
export OPENGENI_DEV_BACKEND

# A native infrastructure host cannot provide the Docker sandbox provider. The
# in-process local provider preserves sandbox execution without credentials or a
# daemon. Preserve explicit remote providers such as Modal/OpenSandbox.
if [ "$OPENGENI_DEV_BACKEND" = "native" ] &&
  [ "${OPENGENI_SANDBOX_BACKEND:-docker}" = "docker" ]; then
  OPENGENI_SANDBOX_BACKEND=local
fi
OPENGENI_SANDBOX_BACKEND="${OPENGENI_SANDBOX_BACKEND:-docker}"
export OPENGENI_SANDBOX_BACKEND

# Connected Machines are part of the normal localhost product surface. Keep the
# deployment/config-library default fail-closed, but make `bun run dev`
# self-contained even for an older copied .env that predates this setting. An
# explicit false remains authoritative for local testing of the disabled state.
if [ -z "${OPENGENI_SANDBOX_SELFHOSTED_ENABLED:-}" ]; then
  OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true
fi
export OPENGENI_SANDBOX_SELFHOSTED_ENABLED

# Browser and Computer are first-class localhost surfaces. Production remains
# fail-closed in packages/config, while a development stack should exercise the
# same interactive capabilities users are actively building. Preserve explicit
# false values so disabled-policy states are still easy to test intentionally.
if [ -z "${OPENGENI_SANDBOX_DESKTOP_ENABLED:-}" ]; then
  OPENGENI_SANDBOX_DESKTOP_ENABLED=true
fi
if [ -z "${OPENGENI_SANDBOX_DESKTOP_INTERACTIVE:-}" ]; then
  OPENGENI_SANDBOX_DESKTOP_INTERACTIVE=true
fi
export OPENGENI_SANDBOX_DESKTOP_ENABLED
export OPENGENI_SANDBOX_DESKTOP_INTERACTIVE

# Local development must exercise the same durable same-session ownership path
# as managed deployments. The config-library defaults stay fail-closed, while
# an explicit false remains authoritative for legacy-path regression tests.
# Lazy provisioning keeps sandbox creation/resume off the first-model critical
# path; the first actual sandbox operation establishes the box single-flight.
if [ -z "${OPENGENI_SANDBOX_OWNERSHIP_ENABLED:-}" ]; then
  OPENGENI_SANDBOX_OWNERSHIP_ENABLED=true
fi
if [ -z "${OPENGENI_SANDBOX_LAZY_PROVISION:-}" ]; then
  OPENGENI_SANDBOX_LAZY_PROVISION=true
fi
export OPENGENI_SANDBOX_OWNERSHIP_ENABLED
export OPENGENI_SANDBOX_LAZY_PROVISION

# The Modal SDK natively supports MODAL_TOKEN_* and ~/.modal.toml, while the
# deployment-facing OpenGeni config intentionally requires explicit credentials.
# Bridge those standard local sources for this dev process only; never persist
# the imported token in .env or .env.runtime.
if [ "${OPENGENI_SANDBOX_BACKEND:-docker}" = "modal" ] &&
  [ -z "${OPENGENI_MODAL_TOKEN_ID:-}" ] &&
  [ -z "${OPENGENI_MODAL_TOKEN_SECRET:-}" ]; then
  if [ -n "${MODAL_TOKEN_ID:-}" ] && [ -n "${MODAL_TOKEN_SECRET:-}" ]; then
    OPENGENI_MODAL_TOKEN_ID="$MODAL_TOKEN_ID"
    OPENGENI_MODAL_TOKEN_SECRET="$MODAL_TOKEN_SECRET"
  elif [ -f "${HOME}/.modal.toml" ]; then
    IFS=$'\t' read -r OPENGENI_MODAL_TOKEN_ID OPENGENI_MODAL_TOKEN_SECRET < <(
      bun -e '
        const config = Bun.TOML.parse(await Bun.file(`${Bun.env.HOME}/.modal.toml`).text());
        const requested = Bun.env.MODAL_PROFILE?.trim();
        const entries = Object.entries(config).filter(([, value]) =>
          value !== null && typeof value === "object"
        );
        const selected = requested
          ? entries.find(([name]) => name === requested)
          : entries.find(([, value]) => value.active === true);
        if (!selected) throw new Error("No active Modal profile is configured");
        const profile = selected[1];
        if (typeof profile.token_id !== "string" || typeof profile.token_secret !== "string") {
          throw new Error(`Modal profile ${selected[0]} has no token pair`);
        }
        process.stdout.write(`${profile.token_id}\t${profile.token_secret}\n`);
      '
    )
  fi
  export OPENGENI_MODAL_TOKEN_ID OPENGENI_MODAL_TOKEN_SECRET
fi

# Local managed credentials (Codex subscriptions, MCP credentials, etc.) still
# need encryption at rest. Generate one worktree-local key on first boot and
# persist it in the ignored .env so restarts can decrypt previously stored rows.
if [ -z "${OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY:-}" ]; then
  OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64"))')"
  export OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY
  {
    printf '\n%s\n' '# Generated by scripts/dev-stack.sh for local development. Do not commit.'
    printf 'OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY=%s\n' "$OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY"
  } >>.env
  echo "Generated and persisted a local environments encryption key in .env."
fi

# Integrations are part of the ordinary localhost product surface. A clean
# checkout enables them, while an explicit false remains authoritative for
# testing the deployment kill switch. OAuth state must remain verifiable across
# API restarts, so generate one worktree-local signing secret and persist it in
# the ignored .env instead of minting an ephemeral value per process.
if [ -z "${OPENGENI_INTEGRATIONS_ENABLED:-}" ]; then
  OPENGENI_INTEGRATIONS_ENABLED=true
  export OPENGENI_INTEGRATIONS_ENABLED
  {
    printf '\n%s\n' '# Added by scripts/dev-stack.sh for local integration development.'
    printf 'OPENGENI_INTEGRATIONS_ENABLED=true\n'
  } >>.env
  echo "Enabled and persisted integrations in .env."
else
  export OPENGENI_INTEGRATIONS_ENABLED
fi
if [ "$OPENGENI_INTEGRATIONS_ENABLED" = "true" ] &&
  [ -z "${OPENGENI_INTEGRATIONS_STATE_SECRET:-}" ]; then
  OPENGENI_INTEGRATIONS_STATE_SECRET="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"))')"
  export OPENGENI_INTEGRATIONS_STATE_SECRET
  {
    printf '%s\n' '# Generated by scripts/dev-stack.sh for local integration OAuth state.'
    printf 'OPENGENI_INTEGRATIONS_STATE_SECRET=%s\n' "$OPENGENI_INTEGRATIONS_STATE_SECRET"
  } >>.env
  echo "Generated and persisted a local integration state secret in .env."
fi

# Connected-machine enrollment and streaming are ordinary local-development
# capabilities. A clean checkout must not require the operator to invent and
# repeatedly export signing secrets before the Machines dialog can work. Keep
# these worktree-local values stable across restarts so already-enrolled agents
# remain valid; production/configured deployments continue to provide their own.
if [ "${OPENGENI_SANDBOX_SELFHOSTED_ENABLED:-false}" = "true" ]; then
  if [ -z "${OPENGENI_ENROLLMENT_SIGNING_SECRET:-}" ] &&
    [ -z "${OPENGENI_DELEGATION_SECRET:-}" ]; then
    OPENGENI_ENROLLMENT_SIGNING_SECRET="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"))')"
    export OPENGENI_ENROLLMENT_SIGNING_SECRET
    {
      printf '\n%s\n' '# Generated by scripts/dev-stack.sh for local Connected Machines.'
      printf 'OPENGENI_ENROLLMENT_SIGNING_SECRET=%s\n' "$OPENGENI_ENROLLMENT_SIGNING_SECRET"
    } >>.env
    echo "Generated and persisted a local Connected Machine enrollment secret in .env."
  fi
  if [ -z "${OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET:-}" ] &&
    [ -z "${OPENGENI_STREAM_TOKEN_SECRET:-}" ] &&
    [ -z "${OPENGENI_DELEGATION_SECRET:-}" ]; then
    OPENGENI_STREAM_TOKEN_SECRET="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"))')"
    export OPENGENI_STREAM_TOKEN_SECRET
    {
      printf '%s\n' '# Generated by scripts/dev-stack.sh for local Connected Machine streams.'
      printf 'OPENGENI_STREAM_TOKEN_SECRET=%s\n' "$OPENGENI_STREAM_TOKEN_SECRET"
    } >>.env
    echo "Generated and persisted a local Connected Machine stream secret in .env."
  fi
  if [ -z "${OPENGENI_AGENT_STABLE_VERSION:-}" ]; then
    OPENGENI_AGENT_STABLE_VERSION="$(bun -e '
      const manifest = Bun.TOML.parse(await Bun.file("agent/Cargo.toml").text());
      process.stdout.write(manifest.workspace.package.version);
    ')"
    export OPENGENI_AGENT_STABLE_VERSION
  fi
fi

# The local UI exposes Codex connection management, so its model-catalog and
# runtime gates must agree by default. An explicit false still disables it.
if [ -z "${OPENGENI_CODEX_SUBSCRIPTION_ENABLED:-}" ]; then
  OPENGENI_CODEX_SUBSCRIPTION_ENABLED=true
  export OPENGENI_CODEX_SUBSCRIPTION_ENABLED
  {
    printf '\n%s\n' '# Added by scripts/dev-stack.sh for local Codex/realtime development.'
    printf 'OPENGENI_CODEX_SUBSCRIPTION_ENABLED=true\n'
  } >>.env
  echo "Enabled and persisted Codex subscription support in .env."
else
  export OPENGENI_CODEX_SUBSCRIPTION_ENABLED
fi

# SuperGrok/xAI is the same local-product surface: the settings card and model
# catalog should be reachable on `bun run dev` without a second env edit.
# packages/config stays fail-closed for production. An explicit false remains
# authoritative for testing the disabled rail.
if [ -z "${OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED:-}" ]; then
  OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED=true
  export OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED
  {
    printf '\n%s\n' '# Added by scripts/dev-stack.sh for local SuperGrok development.'
    printf 'OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED=true\n'
  } >>.env
  echo "Enabled and persisted SuperGrok subscription support in .env."
else
  export OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED
fi

# Infrastructure project identity is shared with scripts/dev-stack-down.sh so
# `bun run dev:down` / `dev:clean` always target exactly this worktree's stack.
# shellcheck disable=SC1091
. ./scripts/dev-stack-project.sh
COMPOSE_PROJECT_NAME="$(resolve_compose_project_name)"
export COMPOSE_PROJECT_NAME

# Modal's application name is also an ownership namespace: the sandbox reaper
# lists instances in that application and removes instances absent from this
# stack's database. Reusing a copied .env value across worktrees therefore lets
# one local stack reap another stack's live sandboxes. Isolate it alongside the
# Compose project by default. Set OPENGENI_PIN_MODAL_APP_NAME=1 only when a
# deliberately shared Modal application is required.
if [ "${OPENGENI_SANDBOX_BACKEND:-docker}" = "modal" ]; then
  if [ "${OPENGENI_PIN_MODAL_APP_NAME:-0}" != "1" ]; then
    OPENGENI_MODAL_APP_NAME="opengeni-${COMPOSE_PROJECT_NAME}"
  fi
  export OPENGENI_MODAL_APP_NAME
fi

# A stopped host dev process intentionally leaves this worktree's dependencies
# running. Reuse the generated ports only when the same recorded infrastructure
# backend is still healthy; otherwise a restart must avoid stale port state.
reuse_runtime_ports=0
runtime_backend=""
if [ -f .env.runtime ]; then
  runtime_backend="$(sed -n 's/^OPENGENI_DEV_BACKEND=//p' .env.runtime | tail -1)"
fi
runtime_infrastructure_running=0
if [ "$runtime_backend" = "$OPENGENI_DEV_BACKEND" ]; then
  if [ "$OPENGENI_DEV_BACKEND" = "docker" ] &&
    [ -n "$(docker compose ps -q 2>/dev/null)" ]; then
    runtime_infrastructure_running=1
  elif [ "$OPENGENI_DEV_BACKEND" = "native" ] &&
    bash scripts/dev-native-infra.sh status --quiet >/dev/null 2>&1; then
    runtime_infrastructure_running=1
  fi
fi
if [ -f .env.runtime ] &&
  [ "$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env.runtime | tail -1)" = "$COMPOSE_PROJECT_NAME" ] &&
  [ "$runtime_infrastructure_running" = "1" ]; then
  # Reuse only generated port assignments. Sourcing the whole runtime file
  # resurrects stale derived URLs and silently overrides newer operator values
  # from .env (notably remote-reachable Connected Machine endpoints).
  for runtime_port_var in \
    OPENGENI_POSTGRES_HOST_PORT \
    OPENGENI_NATS_HOST_PORT \
    OPENGENI_NATS_MONITOR_HOST_PORT \
    OPENGENI_TEMPORAL_HOST_PORT \
    OPENGENI_TEMPORAL_UI_HOST_PORT \
    OPENGENI_GARAGE_HOST_PORT \
    OPENGENI_MINIO_HOST_PORT \
    OPENGENI_MINIO_CONSOLE_HOST_PORT \
    OPENGENI_API_PORT \
    OPENGENI_WORKER_HTTP_PORT \
    OPENGENI_TURN_WORKER_HTTP_PORT \
    OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT \
    OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT \
    OPENGENI_WEB_PORT \
    OPENGENI_RELAY_HOST_PORT; do
    runtime_port_value="$(
      sed -n "s/^${runtime_port_var}=//p" .env.runtime | tail -1
    )"
    if [ -n "$runtime_port_value" ]; then
      printf -v "$runtime_port_var" '%s' "$runtime_port_value"
      export "$runtime_port_var"
    fi
  done
  reuse_runtime_ports=1
fi

netcat_probe_supported=0
if command -v nc >/dev/null 2>&1; then
  # `nc` is not one implementation: some installed variants reject `-z` or
  # `-w`. Prove both flags once from its own help before trusting an exit status;
  # an option-parse failure must use the fallback probes below.
  nc_help="$(nc -h 2>&1 || true)"
  if printf '%s\n' "$nc_help" | grep -Eq '(^|[[:space:]])-z([[:space:],]|$)' &&
    printf '%s\n' "$nc_help" | grep -Eq '(^|[[:space:]])-w([[:space:],]|$)'; then
    netcat_probe_supported=1
  fi
fi

port_available() {
  # Every host service below binds 127.0.0.1. Probe that exact socket instead of
  # asking lsof to enumerate the entire host: lsof can block for minutes when an
  # unrelated OrbStack/NFS mount is degraded, making one worktree appear hung
  # while merely selecting ports. Prove a compatible netcat first, then use
  # bash's exact loopback socket fallback.
  if [ "$netcat_probe_supported" = "1" ]; then
    ! nc -z -w 1 127.0.0.1 "$1" >/dev/null 2>&1
    return
  fi
  ! (echo >"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

# Validate and briefly claim the exact configured address, rather than assuming
# a loopback port probe represents a Tailscale address or another local bind.
relay_bind_available() {
  OPENGENI_LOCAL_RELAY_BIND="$1" bun -e '
    import { createServer } from "node:net";
    const value = Bun.env.OPENGENI_LOCAL_RELAY_BIND?.trim() ?? "";
    const bracketed = value.match(/^\[([^\]]+)]:(\d+)$/);
    const plain = value.match(/^([^:]+):(\d+)$/);
    const match = bracketed ?? plain;
    if (!match) throw new Error("OPENGENI_RELAY_BIND must be host:port (IPv6 must use brackets)");
    const port = Number(match[2]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("OPENGENI_RELAY_BIND port must be between 1 and 65535");
    }
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: match[1], port, exclusive: true }, resolve);
    });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.stdout.write(String(port));
  '
}

# Ports already claimed by this run (avoids MinIO data/console sharing one bind).
DECLARED_PORTS=()

port_claimed() {
  local candidate="$1"
  local claimed
  for claimed in "${DECLARED_PORTS[@]+"${DECLARED_PORTS[@]}"}"; do
    [ "$claimed" = "$candidate" ] && return 0
  done
  return 1
}

claim_port() {
  DECLARED_PORTS+=("$1")
}

# Prefer the default port when free. Otherwise scan nearby ports.
# Host-port values from a copied .env are ignored unless OPENGENI_PIN_PORTS=1,
# so parallel worktrees do not sticky-collide on another checkout's ports.
choose_port() {
  local var_name="$1"
  local default_port="$2"
  local pinned="${!var_name:-}"

  if [ "$reuse_runtime_ports" = "1" ] && [ -n "$pinned" ]; then
    export "$var_name=$pinned"
    claim_port "$pinned"
    return
  fi

  if [ "${OPENGENI_PIN_PORTS:-0}" = "1" ] && [ -n "$pinned" ]; then
    if ! port_claimed "$pinned" && port_available "$pinned"; then
      export "$var_name=$pinned"
      claim_port "$pinned"
      return
    fi
    echo "Pinned ${var_name}=${pinned} is busy; selecting a free port instead." >&2
  fi

  if ! port_claimed "$default_port" && port_available "$default_port"; then
    export "$var_name=$default_port"
    claim_port "$default_port"
    return
  fi
  # Prefer default+1000… when defaults are taken. Window is wide so many
  # parallel worktrees can each grab distinct host ports; still capped so we
  # do not walk the whole ephemeral range on failure.
  local port
  local scan_start=$((default_port + 1000))
  local scan_end=$((default_port + 2999))
  if [ "$scan_end" -gt 65535 ]; then
    scan_end=65535
  fi
  for port in $(seq "$scan_start" "$scan_end"); do
    if ! port_claimed "$port" && port_available "$port"; then
      export "$var_name=$port"
      claim_port "$port"
      echo "Port ${default_port} is in use; using ${var_name}=${port} for this worktree stack."
      return
    fi
  done
  echo "Could not find a free host port for ${var_name} in ${scan_start}-${scan_end}." >&2
  exit 1
}

# Rewrite the port on loopback URLs/hosts so a copied .env cannot point this
# worktree at another stack's infra. Non-loopback URLs are left alone.
# Handles postgres://user@host:port/db, nats://host:port, http(s)://host:port,
# and bare host:port (Temporal).
rewrite_loopback_port() {
  local value="$1"
  local new_port="$2"
  if [[ "$value" =~ @127\.0\.0\.1:[0-9]+ ]] || [[ "$value" =~ @localhost:[0-9]+ ]]; then
    printf '%s' "$value" | sed -E "s/@(127\.0\.0\.1|localhost):[0-9]+/@\1:${new_port}/"
    return
  fi
  # Any URI scheme on loopback (nats://, http://, https://, …).
  if [[ "$value" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*://127\.0\.0\.1:[0-9]+ ]] ||
    [[ "$value" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*://localhost:[0-9]+ ]]; then
    printf '%s' "$value" | sed -E "s#^([a-zA-Z][a-zA-Z0-9+.-]*://)(127\.0\.0\.1|localhost):[0-9]+#\1\2:${new_port}#"
    return
  fi
  if [[ "$value" =~ ^127\.0\.0\.1:[0-9]+$ ]] || [[ "$value" =~ ^localhost:[0-9]+$ ]]; then
    printf '%s' "$value" | sed -E "s/^(127\.0\.0\.1|localhost):[0-9]+/\1:${new_port}/"
    return
  fi
  printf '%s' "$value"
}

choose_port OPENGENI_POSTGRES_HOST_PORT 5432
choose_port OPENGENI_NATS_HOST_PORT 4222
choose_port OPENGENI_NATS_MONITOR_HOST_PORT 8222
choose_port OPENGENI_TEMPORAL_HOST_PORT 7233
if [ "$OPENGENI_DEV_BACKEND" = "native" ]; then
  choose_port OPENGENI_TEMPORAL_UI_HOST_PORT 8233
  OPENGENI_OBJECT_STORAGE_FIXTURE=minio
else
  OPENGENI_OBJECT_STORAGE_FIXTURE="${OPENGENI_OBJECT_STORAGE_FIXTURE:-garage}"
fi
export OPENGENI_OBJECT_STORAGE_FIXTURE
object_s3_host_port=""
if [ "$OPENGENI_OBJECT_STORAGE_FIXTURE" = "minio" ]; then
  choose_port OPENGENI_MINIO_HOST_PORT 9000
  choose_port OPENGENI_MINIO_CONSOLE_HOST_PORT 9001
  object_s3_host_port="$OPENGENI_MINIO_HOST_PORT"
elif [ "$OPENGENI_OBJECT_STORAGE_FIXTURE" = "garage" ]; then
  choose_port OPENGENI_GARAGE_HOST_PORT 3900
  object_s3_host_port="$OPENGENI_GARAGE_HOST_PORT"
else
  echo "OPENGENI_OBJECT_STORAGE_FIXTURE must be garage or minio." >&2
  exit 1
fi
choose_port OPENGENI_API_PORT 8000
choose_port OPENGENI_WORKER_HTTP_PORT 8001
choose_port OPENGENI_TURN_WORKER_HTTP_PORT 8002
choose_port OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT 9465
choose_port OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT 9466
choose_port OPENGENI_WEB_PORT 3000

# OAuth callbacks land on the API, then return to a browser-owned route. Keep
# that final hop on the selected web server for every local worktree while
# preserving an explicit operator-provided origin.
if [ -z "${OPENGENI_WEB_BASE_URL:-}" ]; then
  export OPENGENI_WEB_BASE_URL="http://127.0.0.1:${OPENGENI_WEB_PORT}"
else
  export OPENGENI_WEB_BASE_URL
fi

# Host workers always reach first-party MCP through this worktree's API port.
# OPENGENI_MCP_URL may later become a public Cloudflare edge for Modal and must
# never drag worker traffic through that tunnel.
default_internal_mcp_url="http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp"
if [ -z "${OPENGENI_MCP_INTERNAL_URL:-}" ] ||
  [ "${OPENGENI_MCP_INTERNAL_URL}" = "$default_internal_mcp_url" ]; then
  export OPENGENI_MCP_INTERNAL_URL="http://127.0.0.1:${OPENGENI_API_PORT}/v1/workspaces/{workspaceId}/mcp"
else
  export OPENGENI_MCP_INTERNAL_URL="$(rewrite_loopback_port "$OPENGENI_MCP_INTERNAL_URL" "$OPENGENI_API_PORT")"
fi
if [ "${OPENGENI_SANDBOX_BACKEND:-docker}" = "modal" ]; then
  choose_port OPENGENI_SANDBOX_EDGE_PORT 10080
fi
if [ "${OPENGENI_SANDBOX_SELFHOSTED_ENABLED:-false}" = "true" ]; then
  if [ -n "${OPENGENI_RELAY_BIND:-}" ]; then
    if ! explicit_relay_port="$(relay_bind_available "$OPENGENI_RELAY_BIND")"; then
      echo "Configured OPENGENI_RELAY_BIND=${OPENGENI_RELAY_BIND} is invalid or unavailable." >&2
      exit 1
    fi
    if port_claimed "$explicit_relay_port"; then
      echo "Configured OPENGENI_RELAY_BIND=${OPENGENI_RELAY_BIND} conflicts with another local service." >&2
      exit 1
    fi
    OPENGENI_RELAY_HOST_PORT="$explicit_relay_port"
    export OPENGENI_RELAY_HOST_PORT
    claim_port "$explicit_relay_port"
  else
    choose_port OPENGENI_RELAY_HOST_PORT 8280
  fi
fi

pids=()
pid_labels=()
failed_process_status=1

register_process() {
  pids+=("$1")
  pid_labels+=("$2")
}

signal_process_tree() {
  local signal="$1"
  local pid="$2"
  local child
  while read -r child; do
    if [ -n "$child" ]; then
      signal_process_tree "$signal" "$child"
    fi
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "-$signal" "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  if [ "${#pids[@]}" -eq 0 ]; then
    return
  fi
  local deadline=$((SECONDS + 5))
  local pid running
  for pid in "${pids[@]}"; do
    signal_process_tree TERM "$pid"
  done
  while [ "$SECONDS" -lt "$deadline" ]; do
    running=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        running=1
        break
      fi
    done
    if [ "$running" -eq 0 ]; then
      break
    fi
    sleep 0.1
  done
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      signal_process_tree KILL "$pid"
    fi
  done
  for pid in "${pids[@]}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

dev_processes_running() {
  local index pid label status
  for ((index = 0; index < ${#pids[@]}; index++)); do
    pid="${pids[$index]}"
    label="${pid_labels[$index]}"
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      if wait "$pid"; then
        status=0
      else
        status=$?
      fi
      failed_process_status="$status"
      if [ "$failed_process_status" -eq 0 ]; then
        failed_process_status=1
      fi
      echo "OpenGeni dev process exited: ${label} (status ${status}). Stopping the stack." >&2
      return 1
    fi
  done
  return 0
}

stack_http_ready() {
  curl -fsS -m 1 "http://127.0.0.1:${OPENGENI_API_PORT}/healthz" >/dev/null 2>&1 &&
    curl -fsS -m 1 "http://127.0.0.1:${OPENGENI_WORKER_HTTP_PORT}/healthz" >/dev/null 2>&1 &&
    curl -fsS -m 1 "http://127.0.0.1:${OPENGENI_TURN_WORKER_HTTP_PORT}/healthz" >/dev/null 2>&1 &&
    curl -fsS -m 1 "http://127.0.0.1:${OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT}/healthz" >/dev/null 2>&1 &&
    curl -fsS -m 1 "http://127.0.0.1:${OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT}/healthz" >/dev/null 2>&1 &&
    curl -fsS -m 1 "http://127.0.0.1:${OPENGENI_WEB_PORT}/" >/dev/null 2>&1
}

wait_for_stack_readiness() {
  local deadline=$((SECONDS + 60))
  while ! stack_http_ready; do
    if ! dev_processes_running; then
      return 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "OpenGeni dev stack did not become ready within 60 seconds. Stopping all processes." >&2
      failed_process_status=1
      return 1
    fi
    sleep 0.1
  done
  echo "OpenGeni dev stack ready: API, workers, artifact services, and web are reachable."
}

monitor_dev_stack() {
  local unhealthy_checks=0
  while dev_processes_running; do
    if stack_http_ready; then
      unhealthy_checks=0
    else
      unhealthy_checks=$((unhealthy_checks + 1))
      if [ "$unhealthy_checks" -ge 2 ]; then
        echo "OpenGeni dev stack lost aggregate readiness. Stopping instead of leaving a partial stack running." >&2
        failed_process_status=1
        return 1
      fi
    fi
    sleep 5
  done
  return 1
}

default_database_url="postgres://opengeni_app:opengeni_app@127.0.0.1:5432/opengeni"
if [ -z "${OPENGENI_DATABASE_URL:-}" ] || [ "${OPENGENI_DATABASE_URL}" = "$default_database_url" ]; then
  export OPENGENI_DATABASE_URL="postgres://opengeni_app:opengeni_app@127.0.0.1:${OPENGENI_POSTGRES_HOST_PORT}/opengeni"
else
  export OPENGENI_DATABASE_URL="$(rewrite_loopback_port "$OPENGENI_DATABASE_URL" "$OPENGENI_POSTGRES_HOST_PORT")"
fi

# Forced-RLS role provisioning needs the plaintext password for the application
# role. Local development already carries that credential in its loopback DSN,
# so derive it when a sparse worktree .env omits the redundant standalone var.
if [ -z "${OPENGENI_APP_DATABASE_PASSWORD:-}" ]; then
  OPENGENI_APP_DATABASE_PASSWORD="$(
    OPENGENI_LOCAL_DATABASE_URL="$OPENGENI_DATABASE_URL" bun -e '
      const url = new URL(Bun.env.OPENGENI_LOCAL_DATABASE_URL);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())) {
        throw new Error("Automatic local app-role password derivation requires a loopback database URL");
      }
      if (!url.password) throw new Error("Local application database URL must contain a password");
      process.stdout.write(decodeURIComponent(url.password));
    '
  )"
fi
export OPENGENI_APP_DATABASE_PASSWORD

default_migrations_database_url="postgres://opengeni:opengeni@127.0.0.1:5432/opengeni"
if [ -z "${OPENGENI_MIGRATIONS_DATABASE_URL:-}" ] || [ "${OPENGENI_MIGRATIONS_DATABASE_URL}" = "$default_migrations_database_url" ]; then
  export OPENGENI_MIGRATIONS_DATABASE_URL="postgres://opengeni:opengeni@127.0.0.1:${OPENGENI_POSTGRES_HOST_PORT}/opengeni"
else
  export OPENGENI_MIGRATIONS_DATABASE_URL="$(rewrite_loopback_port "$OPENGENI_MIGRATIONS_DATABASE_URL" "$OPENGENI_POSTGRES_HOST_PORT")"
fi

# Artifact services use separate, least-privileged login roles. Generate real
# per-launch credentials, converge the roles through provision-roles below, and
# persist only the resulting DSNs in the ignored .env.runtime for this stack.
OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_USER=opengeni_artifact_materializer
OPENGENI_ARTIFACT_OUTBOX_DATABASE_USER=opengeni_artifact_outbox_dispatcher
OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_PASSWORD="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"))')"
OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"))')"
export OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_USER
export OPENGENI_ARTIFACT_OUTBOX_DATABASE_USER
export OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_PASSWORD
export OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD

database_url_for_role() {
  local role="$1"
  local password="$2"
  OPENGENI_ROLE_DSN_BASE="$OPENGENI_MIGRATIONS_DATABASE_URL" \
    OPENGENI_ROLE_DSN_USER="$role" \
    OPENGENI_ROLE_DSN_PASSWORD="$password" \
    bun -e '
      const url = new URL(Bun.env.OPENGENI_ROLE_DSN_BASE);
      if (!['"'"'postgres:'"'"', '"'"'postgresql:'"'"'].includes(url.protocol)) throw new Error('"'"'Local database URL must use PostgreSQL'"'"');
      if (!['"'"'localhost'"'"', '"'"'127.0.0.1'"'"', '"'"'[::1]'"'"'].includes(url.hostname.toLowerCase())) throw new Error('"'"'Local artifact services require a loopback database URL'"'"');
      url.username = Bun.env.OPENGENI_ROLE_DSN_USER;
      url.password = Bun.env.OPENGENI_ROLE_DSN_PASSWORD;
      process.stdout.write(url.href);
    '
}

OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL="$(database_url_for_role \
  "$OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_USER" \
  "$OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_PASSWORD")"
OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL="$(database_url_for_role \
  "$OPENGENI_ARTIFACT_OUTBOX_DATABASE_USER" \
  "$OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD")"
OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE="$OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_USER"
OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE="$OPENGENI_ARTIFACT_OUTBOX_DATABASE_USER"
export OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL
export OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL
export OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE
export OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE

default_nats_url="nats://127.0.0.1:4222"
if [ -z "${OPENGENI_NATS_URL:-}" ] || [ "${OPENGENI_NATS_URL}" = "$default_nats_url" ]; then
  export OPENGENI_NATS_URL="nats://127.0.0.1:${OPENGENI_NATS_HOST_PORT}"
else
  export OPENGENI_NATS_URL="$(rewrite_loopback_port "$OPENGENI_NATS_URL" "$OPENGENI_NATS_HOST_PORT")"
fi

# A localhost Machines command must contain endpoints reachable by an agent on
# this host, and the served installer must fetch through this API rather than the
# public CDN. Explicit non-loopback operator values still win unchanged.
if [ "${OPENGENI_SANDBOX_SELFHOSTED_ENABLED:-false}" = "true" ]; then
  default_selfhosted_nats_url="nats://127.0.0.1:4222"
  if [ -z "${OPENGENI_SELFHOSTED_NATS_URL:-}" ] ||
    [ "${OPENGENI_SELFHOSTED_NATS_URL}" = "$default_selfhosted_nats_url" ]; then
    export OPENGENI_SELFHOSTED_NATS_URL="$OPENGENI_NATS_URL"
  else
    export OPENGENI_SELFHOSTED_NATS_URL="$(rewrite_loopback_port "$OPENGENI_SELFHOSTED_NATS_URL" "$OPENGENI_NATS_HOST_PORT")"
  fi

  default_selfhosted_relay_url="ws://127.0.0.1:8280"
  if [ -z "${OPENGENI_SELFHOSTED_RELAY_URL:-}" ] ||
    [ "${OPENGENI_SELFHOSTED_RELAY_URL}" = "$default_selfhosted_relay_url" ]; then
    export OPENGENI_SELFHOSTED_RELAY_URL="ws://127.0.0.1:${OPENGENI_RELAY_HOST_PORT}"
  else
    export OPENGENI_SELFHOSTED_RELAY_URL="$(rewrite_loopback_port "$OPENGENI_SELFHOSTED_RELAY_URL" "$OPENGENI_RELAY_HOST_PORT")"
  fi

  if [ -z "${OPENGENI_PUBLIC_BASE_URL:-}" ]; then
    export OPENGENI_PUBLIC_BASE_URL="http://127.0.0.1:${OPENGENI_API_PORT}"
  fi
fi

default_temporal_host="127.0.0.1:7233"
if [ -z "${OPENGENI_TEMPORAL_HOST:-}" ] || [ "${OPENGENI_TEMPORAL_HOST}" = "$default_temporal_host" ]; then
  export OPENGENI_TEMPORAL_HOST="127.0.0.1:${OPENGENI_TEMPORAL_HOST_PORT}"
else
  export OPENGENI_TEMPORAL_HOST="$(rewrite_loopback_port "$OPENGENI_TEMPORAL_HOST" "$OPENGENI_TEMPORAL_HOST_PORT")"
fi

default_object_endpoint_garage="http://127.0.0.1:3900"
default_object_endpoint_minio="http://127.0.0.1:9000"
if [ -z "${OPENGENI_OBJECT_STORAGE_ENDPOINT:-}" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_ENDPOINT}" = "$default_object_endpoint_garage" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_ENDPOINT}" = "$default_object_endpoint_minio" ]; then
  export OPENGENI_OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:${object_s3_host_port}"
else
  export OPENGENI_OBJECT_STORAGE_ENDPOINT="$(rewrite_loopback_port "$OPENGENI_OBJECT_STORAGE_ENDPOINT" "$object_s3_host_port")"
fi

# docker-compose.yml owns this worktree's local object-storage fixture.
# Sparse acceptance .env files should not have to repeat the development keys.
GARAGE_FIXTURE_ACCESS_KEY_ID="GK0123456789abcdef0123456789abcdef"
GARAGE_FIXTURE_SECRET_ACCESS_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
if [ "$OPENGENI_OBJECT_STORAGE_FIXTURE" = "garage" ]; then
  if [ -z "${OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID:-}" ] ||
    [ "${OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID}" = "minioadmin" ]; then
    export OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID="$GARAGE_FIXTURE_ACCESS_KEY_ID"
    export OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY="$GARAGE_FIXTURE_SECRET_ACCESS_KEY"
  fi
  if [ -z "${OPENGENI_OBJECT_STORAGE_S3_PROVIDER:-}" ] ||
    [ "${OPENGENI_OBJECT_STORAGE_S3_PROVIDER}" = "Minio" ]; then
    export OPENGENI_OBJECT_STORAGE_S3_PROVIDER="Other"
  fi
else
  if [ -z "${OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID:-}" ] ||
    [ "${OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID}" = "$GARAGE_FIXTURE_ACCESS_KEY_ID" ]; then
    export OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID=minioadmin
    export OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY=minioadmin
  fi
  if [ -z "${OPENGENI_OBJECT_STORAGE_S3_PROVIDER:-}" ] ||
    [ "${OPENGENI_OBJECT_STORAGE_S3_PROVIDER}" = "Other" ]; then
    export OPENGENI_OBJECT_STORAGE_S3_PROVIDER="Minio"
  fi
fi
export OPENGENI_OBJECT_STORAGE_BACKEND="${OPENGENI_OBJECT_STORAGE_BACKEND:-s3-compatible}"
export OPENGENI_OBJECT_STORAGE_BUCKET="${OPENGENI_OBJECT_STORAGE_BUCKET:-opengeni-files}"
export OPENGENI_OBJECT_STORAGE_REGION="${OPENGENI_OBJECT_STORAGE_REGION:-us-east-1}"
export OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE="${OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE:-true}"

# API/workers run on the host in local development, so their authenticated
# object-storage client must use the host endpoint. Compose DNS (`garage:3900` /
# `minio:9000`) is reachable only from compose/sandbox containers.
default_internal_object_endpoint_garage="http://garage:3900"
default_internal_object_endpoint_minio="http://minio:9000"
if [ -z "${OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT:-}" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT}" = "$default_internal_object_endpoint_garage" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT}" = "$default_internal_object_endpoint_minio" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT}" = "$default_object_endpoint_garage" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT}" = "$default_object_endpoint_minio" ]; then
  export OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT="${OPENGENI_OBJECT_STORAGE_ENDPOINT}"
else
  export OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT="$(rewrite_loopback_port "$OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT" "$object_s3_host_port")"
fi

default_sandbox_object_endpoint="http://host.docker.internal:9000"
if [ -z "${OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT:-}" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT}" = "$default_sandbox_object_endpoint" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT}" = "$default_internal_object_endpoint_garage" ] ||
  [ "${OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT}" = "$default_internal_object_endpoint_minio" ]; then
  if [ "$OPENGENI_SANDBOX_BACKEND" = "local" ]; then
    export OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT="${OPENGENI_OBJECT_STORAGE_ENDPOINT}"
  elif [ "$OPENGENI_OBJECT_STORAGE_FIXTURE" = "minio" ]; then
    export OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT="http://minio:9000"
  else
    export OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT="http://garage:3900"
  fi
fi

# A managed Modal sandbox cannot resolve compose-only `garage`/`minio` DNS or
# reach the host loopback endpoint embedded in local presigned URLs. Give remote
# sandboxes a short-lived HTTPS route to this worktree's private object store.
# remains credential-protected and every write still requires its object-scoped
# signed URL. Operators can bypass this local convenience by configuring any
# already-sandbox-reachable endpoint.
if [ "${OPENGENI_SANDBOX_BACKEND:-docker}" = "modal" ]; then
  sandbox_object_host="$({
    OPENGENI_LOCAL_OBJECT_ENDPOINT="$OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT" bun -e '
      const url = new URL(Bun.env.OPENGENI_LOCAL_OBJECT_ENDPOINT);
      process.stdout.write(url.hostname.toLowerCase());
    '
  })"
  if [ "$sandbox_object_host" = "garage" ] ||
    [ "$sandbox_object_host" = "minio" ] ||
    [ "$sandbox_object_host" = "host.docker.internal" ] ||
    [ "$sandbox_object_host" = "127.0.0.1" ] ||
    [ "$sandbox_object_host" = "localhost" ] ||
    [[ "$sandbox_object_host" = *.ngrok-free.app ]] ||
    [[ "$sandbox_object_host" = *.ngrok-free.dev ]] ||
    [[ "$sandbox_object_host" = *.ngrok.io ]] ||
    [[ "$sandbox_object_host" = *.trycloudflare.com ]]; then
    needs_modal_object_route=1
  else
    needs_modal_object_route=0
  fi

  # The API/worker live on the developer host while Modal executes remotely.
  # Publish one exact worktree-scoped edge for presigned objects plus
  # MCP/Codemode; browser/UI origins and Connected Machine enrollment remain
  # unchanged.
  mcp_host="$({
    OPENGENI_LOCAL_MCP_URL="${OPENGENI_MCP_URL:-http://127.0.0.1:${OPENGENI_API_PORT}}" bun -e '
      const url = new URL(Bun.env.OPENGENI_LOCAL_MCP_URL.replace("{workspaceId}", "workspace"));
      process.stdout.write(url.hostname.toLowerCase());
    '
  })"
  if [ -z "${OPENGENI_MCP_URL:-}" ] ||
    [ "$mcp_host" = "127.0.0.1" ] ||
    [ "$mcp_host" = "localhost" ] ||
    [ "$mcp_host" = "host.docker.internal" ] ||
    [[ "$mcp_host" = *.ngrok-free.app ]] ||
    [[ "$mcp_host" = *.ngrok-free.dev ]] ||
    [[ "$mcp_host" = *.ngrok.io ]] ||
    [[ "$mcp_host" = *.trycloudflare.com ]]; then
    needs_modal_api_route=1
  else
    needs_modal_api_route=0
  fi

  if [ "$needs_modal_object_route" = "1" ] || [ "$needs_modal_api_route" = "1" ]; then
    if ! command -v cloudflared >/dev/null 2>&1; then
      echo "Modal local development needs cloudflared or explicit sandbox-reachable object and MCP endpoints." >&2
      exit 1
    fi
    mkdir -p .opengeni
    edge_log=".opengeni/cloudflared-sandbox-edge.log"
    : >"$edge_log"
      OPENGENI_SANDBOX_EDGE_API_ORIGIN="http://127.0.0.1:${OPENGENI_API_PORT}" \
      OPENGENI_SANDBOX_EDGE_OBJECT_ORIGIN="http://127.0.0.1:${object_s3_host_port}" \
      bun scripts/dev-sandbox-edge.ts &
    register_process "$!" "Modal sandbox edge"
    for _attempt in $(seq 1 100); do
      curl -fsS "http://127.0.0.1:${OPENGENI_SANDBOX_EDGE_PORT}/__opengeni_edge_health" \
        >/dev/null 2>&1 && break
      sleep 0.05
    done
    curl -fsS "http://127.0.0.1:${OPENGENI_SANDBOX_EDGE_PORT}/__opengeni_edge_health" \
      >/dev/null || {
      echo "Could not start the local Modal sandbox edge." >&2
      exit 1
    }
    cloudflared tunnel --no-autoupdate \
      --url "http://127.0.0.1:${OPENGENI_SANDBOX_EDGE_PORT}" \
      --logfile "$edge_log" --loglevel info >/dev/null 2>&1 &
    register_process "$!" "Modal sandbox tunnel"
    sandbox_edge_url=""
    for _attempt in $(seq 1 200); do
      sandbox_edge_url="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$edge_log" | tail -n 1 || true)"
      [ -n "$sandbox_edge_url" ] && break
      sleep 0.1
    done
    if [ -z "$sandbox_edge_url" ]; then
      echo "Could not establish the remote Modal sandbox edge." >&2
      exit 1
    fi
    if [ "$needs_modal_object_route" = "1" ]; then
      export OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT="$sandbox_edge_url"
      echo "  modal-object-storage=${OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT}"
    fi
    if [ "$needs_modal_api_route" = "1" ]; then
      export OPENGENI_MCP_URL="${sandbox_edge_url}/v1/workspaces/{workspaceId}/mcp"
      echo "  modal-opengeni-api=${sandbox_edge_url}"
    fi
  fi
fi

# Sandbox containers must join *this* worktree's compose network.
export OPENGENI_DOCKER_NETWORK="${COMPOSE_PROJECT_NAME}_default"

default_vite_api_base_url="http://127.0.0.1:8000"
# Browser cookies are domain-scoped, so `localhost` and `127.0.0.1` are not
# interchangeable here. Match the generated API URL to the configured local
# web/public hostname; otherwise managed signup can create the user while the
# browser silently drops the cross-site session cookie.
browser_loopback_host="127.0.0.1"
browser_base_url="${OPENGENI_WEB_BASE_URL:-${OPENGENI_PUBLIC_BASE_URL:-}}"
if [[ "$browser_base_url" =~ ^https?://localhost([:/]|$) ]]; then
  browser_loopback_host="localhost"
elif [[ "$browser_base_url" =~ ^https?://127\.0\.0\.1([:/]|$) ]]; then
  browser_loopback_host="127.0.0.1"
fi
if [ -z "${VITE_API_BASE_URL:-}" ] || [ "${VITE_API_BASE_URL}" = "$default_vite_api_base_url" ]; then
  export VITE_API_BASE_URL="http://${browser_loopback_host}:${OPENGENI_API_PORT}"
else
  export VITE_API_BASE_URL="$(rewrite_loopback_port "$VITE_API_BASE_URL" "$OPENGENI_API_PORT")"
fi

# Connected-machine terminal/desktop/browser streams need the separate relay
# data plane. Production runs it as its own workload; local development must do
# the same whenever the configured relay URL points back at this machine. Until
# now dev-stack started the control plane but silently omitted the relay, so an
# enrolled machine looked online while every live surface failed at :8280.
start_local_relay=0
if [ "${OPENGENI_SANDBOX_SELFHOSTED_ENABLED:-false}" = "true" ] &&
  [ -n "${OPENGENI_SELFHOSTED_RELAY_URL:-}" ]; then
  IFS=$'\t' read -r relay_hostname relay_port < <(
    OPENGENI_LOCAL_RELAY_URL="$OPENGENI_SELFHOSTED_RELAY_URL" bun -e '
      const url = new URL(Bun.env.OPENGENI_LOCAL_RELAY_URL);
      const port = url.port || (url.protocol === "wss:" ? "443" : "80");
      process.stdout.write(`${url.hostname}\t${port}\n`);
    '
  )
  if [ -n "${OPENGENI_RELAY_BIND:-}" ]; then
    # An operator may advertise this development relay through a non-loopback
    # interface (for example the host's Tailscale address) while binding the
    # process to 0.0.0.0. Treat an explicit bind as ownership of the local relay
    # instead of assuming every non-loopback URL belongs to an external service.
    OPENGENI_RELAY_TOKEN_SECRET="${OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET:-${OPENGENI_STREAM_TOKEN_SECRET:-${OPENGENI_DELEGATION_SECRET:-}}}"
    if [ -z "$OPENGENI_RELAY_TOKEN_SECRET" ]; then
      echo "Connected-machine local relay requires OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET or OPENGENI_STREAM_TOKEN_SECRET." >&2
      exit 1
    fi
    export OPENGENI_RELAY_BIND OPENGENI_RELAY_TOKEN_SECRET
    start_local_relay=1
  elif [ "$relay_hostname" = "127.0.0.1" ] || [ "$relay_hostname" = "localhost" ]; then
    OPENGENI_RELAY_BIND="127.0.0.1:${relay_port}"
    OPENGENI_RELAY_TOKEN_SECRET="${OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET:-${OPENGENI_STREAM_TOKEN_SECRET:-${OPENGENI_DELEGATION_SECRET:-}}}"
    if [ -z "$OPENGENI_RELAY_TOKEN_SECRET" ]; then
      echo "Connected-machine local relay requires OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET or OPENGENI_STREAM_TOKEN_SECRET." >&2
      exit 1
    fi
    export OPENGENI_RELAY_BIND OPENGENI_RELAY_TOKEN_SECRET
    start_local_relay=1
  fi
fi

# A clean checkout must establish the canonical workspace package links before
# the generated facade is verified. The facade never searches alternate roots.
bun install --frozen-lockfile

# Connected Machines use the real NATS auth-callout boundary in local development,
# too. Generate one stable worktree-local signing identity/password pair, render an
# ignored NATS configuration, and authenticate the API/worker control connections.
# Reusing these values across restarts keeps existing enrollments valid; parallel
# worktrees remain isolated by their own .env, Compose project, ports, and config.
if [ "${OPENGENI_SANDBOX_SELFHOSTED_ENABLED:-false}" = "true" ]; then
  generated_nats_env=0
  if [ -z "${OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED:-}" ]; then
    IFS=$'\t' read -r OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED \
      OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY < <(
      bun -e '
        import { nkeys } from "@opengeni/events";
        const account = nkeys.createAccount();
        const seed = new TextDecoder().decode(account.getSeed());
        process.stdout.write(`${seed}\t${account.getPublicKey()}\n`);
      '
    )
    generated_nats_env=1
  else
    derived_nats_public_key="$({
      OPENGENI_LOCAL_NATS_SEED="$OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED" bun -e '
        import { nkeys } from "@opengeni/events";
        const key = nkeys.fromSeed(new TextEncoder().encode(Bun.env.OPENGENI_LOCAL_NATS_SEED));
        process.stdout.write(key.getPublicKey());
      '
    })"
    if [ -n "${OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY:-}" ] &&
      [ "$OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY" != "$derived_nats_public_key" ]; then
      echo "OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY does not match its account seed." >&2
      exit 1
    fi
    OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY="$derived_nats_public_key"
  fi
  OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_NAME="${OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_NAME:-APP}"
  OPENGENI_SELFHOSTED_NATS_CALLOUT_USER="${OPENGENI_SELFHOSTED_NATS_CALLOUT_USER:-auth}"
  OPENGENI_SELFHOSTED_NATS_CONTROL_USER="${OPENGENI_SELFHOSTED_NATS_CONTROL_USER:-control}"
  if [ -z "${OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD:-}" ]; then
    OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"))')"
    generated_nats_env=1
  fi
  if [ -z "${OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD:-}" ]; then
    OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"))')"
    generated_nats_env=1
  fi
  export OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED
  export OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY
  export OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_NAME
  export OPENGENI_SELFHOSTED_NATS_CALLOUT_USER
  export OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD
  export OPENGENI_SELFHOSTED_NATS_CONTROL_USER
  export OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD
  if [ "$generated_nats_env" = "1" ]; then
    {
      printf '\n%s\n' '# Generated by scripts/dev-stack.sh for local NATS auth-callout.'
      printf 'OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED=%s\n' "$OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED"
      printf 'OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY=%s\n' "$OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY"
      printf 'OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD=%s\n' "$OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD"
      printf 'OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD=%s\n' "$OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD"
    } >>.env
    echo "Generated and persisted the local NATS auth-callout identity in .env."
  fi
  OPENGENI_NATS_CONFIG_FILE="$(pwd)/.opengeni/nats-auth-callout.conf"
  export OPENGENI_NATS_CONFIG_FILE
  bun scripts/prepare-development-nats-config.ts --output "$OPENGENI_NATS_CONFIG_FILE" >/dev/null
fi

# Local editable-artifact authority uses a separately typed current-host bundle.
# It is rebuilt only when its exact source/toolchain fingerprint or smoke receipt
# changes. Production's complete eight-target locator remains untouched and a
# development manifest is rejected by the runtime when NODE_ENV=production.
unset OPENGENI_ARTIFACT_RUNTIME_MANIFEST
export NODE_ENV=development
artifact_development_root="$(pwd)/.opengeni/artifact-runtime-development"
# Optional shared Cargo target cache for the host-side Rust builds (artifact
# kernel napi binding here, Connected Machine relay below). Opt-in only: by
# default every checkout keeps its own in-repo target/ trees. When set, each
# Cargo workspace gets its own subdirectory so the two never mix, and parallel
# worktrees reuse compiled registry dependencies instead of recompiling them.
artifact_kernel_cargo_env=()
relay_cargo_env=()
if [ -n "${OPENGENI_DEV_CARGO_TARGET_DIR:-}" ]; then
  case "$OPENGENI_DEV_CARGO_TARGET_DIR" in
  /*) ;;
  *)
    echo "OPENGENI_DEV_CARGO_TARGET_DIR must be an absolute path." >&2
    exit 1
    ;;
  esac
  mkdir -p "${OPENGENI_DEV_CARGO_TARGET_DIR}/artifact-kernel" "${OPENGENI_DEV_CARGO_TARGET_DIR}/agent"
  artifact_kernel_cargo_env=("CARGO_TARGET_DIR=${OPENGENI_DEV_CARGO_TARGET_DIR}/artifact-kernel")
  relay_cargo_env=("CARGO_TARGET_DIR=${OPENGENI_DEV_CARGO_TARGET_DIR}/agent")
fi
env "${artifact_kernel_cargo_env[@]+"${artifact_kernel_cargo_env[@]}"}" \
  bun scripts/prepare-development-artifact-runtime.ts \
  --repository-root "$(pwd)" \
  --output "$artifact_development_root"
export OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST="${artifact_development_root}/installation.development.json"
export OPENGENI_ARTIFACT_TOOL_ENTRY="${artifact_development_root}/skill-facade-entry.mjs"
export OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE="${artifact_development_root}/opengeni-artifact-materializer"
export OPENGENI_ARTIFACT_MATERIALIZER_ENABLED=true
export OPENGENI_ARTIFACT_OUTBOX_ENABLED=true
export OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT=true
export OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT=true
export OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST=127.0.0.1

# Native agent skills require a source-matched Linux runtime inside the sandbox
# image. Resolve only the exact clean-HEAD CI artifact; never reuse a stale
# bundle. Ordinary API/web development remains available when no exact artifact
# exists, while OPENGENI_REQUIRE_SANDBOX_ARTIFACT_RUNTIME=1 makes that mismatch
# an explicit startup failure for artifact-engine work.
sandbox_runtime_bundle=".opengeni/no-artifact-runtime-for-this-source"
sandbox_source_tag="$(git rev-parse --short=12 HEAD)"
if [ "${OPENGENI_SANDBOX_BACKEND:-docker}" = "docker" ]; then
  if sandbox_runtime_json="$(bun scripts/resolve-development-sandbox-runtime.ts \
    --repository-root "$(pwd)" \
    --output "$(pwd)/.release/artifact-runtime")"; then
    sandbox_source_tag="$(printf '%s' "$sandbox_runtime_json" | bun -e 'const value=await Bun.stdin.json();process.stdout.write(value.sourceTag)')"
    sandbox_runtime_bundle=".release/artifact-runtime"
    OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED=true
    echo "Using exact-head sandbox artifact runtime (${sandbox_source_tag})."
  else
    OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED=false
    if [ "${OPENGENI_REQUIRE_SANDBOX_ARTIFACT_RUNTIME:-0}" = "1" ]; then
      echo "Exact-head sandbox artifact runtime is required but unavailable." >&2
      exit 1
    fi
    echo "Exact-head sandbox artifact runtime unavailable; standalone local Office file operations are disabled." >&2
  fi
  OPENGENI_DOCKER_IMAGE="opengeni-sandbox:local-${sandbox_source_tag}-${COMPOSE_PROJECT_NAME}"
  export OPENGENI_DOCKER_IMAGE OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED
fi

# Sibling shells / `bun run dev:*` source this after `.env`. Use printf so URL
# passwords containing `$` / backticks cannot break the file via heredoc expansion.
{
  printf '%s\n' "# Generated by scripts/dev-stack.sh for worktree stack ${COMPOSE_PROJECT_NAME}. Do not commit."
  printf 'COMPOSE_PROJECT_NAME=%s\n' "${COMPOSE_PROJECT_NAME}"
  printf 'OPENGENI_DEV_BACKEND=%s\n' "${OPENGENI_DEV_BACKEND}"
  printf 'OPENGENI_SANDBOX_BACKEND=%s\n' "${OPENGENI_SANDBOX_BACKEND}"
  printf 'OPENGENI_MODAL_APP_NAME=%s\n' "${OPENGENI_MODAL_APP_NAME:-opengeni-sandbox}"
  printf 'OPENGENI_DOCKER_NETWORK=%s\n' "${OPENGENI_DOCKER_NETWORK}"
  printf 'OPENGENI_DOCKER_IMAGE=%s\n' "${OPENGENI_DOCKER_IMAGE:-opengeni-sandbox:local}"
  printf 'OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED=%s\n' "${OPENGENI_SANDBOX_ARTIFACT_RUNTIME_ENABLED:-false}"
  printf 'OPENGENI_SANDBOX_OWNERSHIP_ENABLED=%s\n' "${OPENGENI_SANDBOX_OWNERSHIP_ENABLED}"
  printf 'OPENGENI_SANDBOX_LAZY_PROVISION=%s\n' "${OPENGENI_SANDBOX_LAZY_PROVISION}"
  printf 'OPENGENI_POSTGRES_HOST_PORT=%s\n' "${OPENGENI_POSTGRES_HOST_PORT}"
  printf 'OPENGENI_NATS_HOST_PORT=%s\n' "${OPENGENI_NATS_HOST_PORT}"
  printf 'OPENGENI_NATS_MONITOR_HOST_PORT=%s\n' "${OPENGENI_NATS_MONITOR_HOST_PORT}"
  printf 'OPENGENI_NATS_CONFIG_FILE=%s\n' "${OPENGENI_NATS_CONFIG_FILE:-$(pwd)/deploy/nats/local-development.conf}"
  printf 'OPENGENI_TEMPORAL_HOST_PORT=%s\n' "${OPENGENI_TEMPORAL_HOST_PORT}"
  if [ "$OPENGENI_DEV_BACKEND" = "native" ]; then
    printf 'OPENGENI_TEMPORAL_UI_HOST_PORT=%s\n' "${OPENGENI_TEMPORAL_UI_HOST_PORT}"
  fi
  printf 'OPENGENI_OBJECT_STORAGE_FIXTURE=%s\n' "${OPENGENI_OBJECT_STORAGE_FIXTURE}"
  if [ "$OPENGENI_OBJECT_STORAGE_FIXTURE" = "minio" ]; then
    printf 'OPENGENI_MINIO_HOST_PORT=%s\n' "${OPENGENI_MINIO_HOST_PORT}"
    printf 'OPENGENI_MINIO_CONSOLE_HOST_PORT=%s\n' "${OPENGENI_MINIO_CONSOLE_HOST_PORT}"
  else
    printf 'OPENGENI_GARAGE_HOST_PORT=%s\n' "${OPENGENI_GARAGE_HOST_PORT}"
  fi
  printf 'OPENGENI_API_PORT=%s\n' "${OPENGENI_API_PORT}"
  printf 'OPENGENI_WORKER_HTTP_PORT=%s\n' "${OPENGENI_WORKER_HTTP_PORT}"
  printf 'OPENGENI_TURN_WORKER_HTTP_PORT=%s\n' "${OPENGENI_TURN_WORKER_HTTP_PORT}"
  printf 'OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT=%s\n' "${OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT}"
  printf 'OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT=%s\n' "${OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT}"
  printf 'OPENGENI_WEB_PORT=%s\n' "${OPENGENI_WEB_PORT}"
  printf 'OPENGENI_WEB_BASE_URL=%s\n' "${OPENGENI_WEB_BASE_URL}"
  if [ -n "${OPENGENI_SANDBOX_EDGE_PORT:-}" ]; then
    printf 'OPENGENI_SANDBOX_EDGE_PORT=%s\n' "${OPENGENI_SANDBOX_EDGE_PORT}"
  fi
  if [ "${OPENGENI_SANDBOX_SELFHOSTED_ENABLED:-false}" = "true" ]; then
    printf 'OPENGENI_RELAY_HOST_PORT=%s\n' "${OPENGENI_RELAY_HOST_PORT}"
    printf 'OPENGENI_SELFHOSTED_NATS_URL=%s\n' "${OPENGENI_SELFHOSTED_NATS_URL}"
    printf 'OPENGENI_SELFHOSTED_RELAY_URL=%s\n' "${OPENGENI_SELFHOSTED_RELAY_URL}"
    printf 'OPENGENI_PUBLIC_BASE_URL=%s\n' "${OPENGENI_PUBLIC_BASE_URL}"
    printf 'OPENGENI_AGENT_STABLE_VERSION=%s\n' "${OPENGENI_AGENT_STABLE_VERSION}"
    # Component launchers (`bun run dev:api`, `dev:worker:*`) source .env and
    # then this file. Persist the complete NATS auth-callout identity here so a
    # restarted component does not silently lose the in-process defaults and
    # reconnect anonymously to a server that now requires authentication.
    printf 'OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED=%s\n' "${OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED}"
    printf 'OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY=%s\n' "${OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY}"
    printf 'OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_NAME=%s\n' "${OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_NAME}"
    printf 'OPENGENI_SELFHOSTED_NATS_CALLOUT_USER=%s\n' "${OPENGENI_SELFHOSTED_NATS_CALLOUT_USER}"
    printf 'OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD=%s\n' "${OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD}"
    printf 'OPENGENI_SELFHOSTED_NATS_CONTROL_USER=%s\n' "${OPENGENI_SELFHOSTED_NATS_CONTROL_USER}"
    printf 'OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD=%s\n' "${OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD}"
  fi
  if [ "$start_local_relay" = "1" ]; then
    printf 'OPENGENI_RELAY_BIND=%s\n' "${OPENGENI_RELAY_BIND}"
  fi
  printf 'OPENGENI_DATABASE_URL=%s\n' "${OPENGENI_DATABASE_URL}"
  printf 'OPENGENI_MIGRATIONS_DATABASE_URL=%s\n' "${OPENGENI_MIGRATIONS_DATABASE_URL}"
  printf 'OPENGENI_NATS_URL=%s\n' "${OPENGENI_NATS_URL}"
  printf 'OPENGENI_TEMPORAL_HOST=%s\n' "${OPENGENI_TEMPORAL_HOST}"
  printf 'OPENGENI_OBJECT_STORAGE_ENDPOINT=%s\n' "${OPENGENI_OBJECT_STORAGE_ENDPOINT}"
  printf 'OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT=%s\n' "${OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT}"
  printf 'OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT=%s\n' "${OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT}"
  printf 'OPENGENI_OBJECT_STORAGE_BACKEND=%s\n' "${OPENGENI_OBJECT_STORAGE_BACKEND}"
  printf 'OPENGENI_OBJECT_STORAGE_BUCKET=%s\n' "${OPENGENI_OBJECT_STORAGE_BUCKET}"
  printf 'OPENGENI_OBJECT_STORAGE_REGION=%s\n' "${OPENGENI_OBJECT_STORAGE_REGION}"
  printf 'OPENGENI_OBJECT_STORAGE_S3_PROVIDER=%s\n' "${OPENGENI_OBJECT_STORAGE_S3_PROVIDER}"
  printf 'OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID=%s\n' "${OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID}"
  printf 'OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY=%s\n' "${OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY}"
  printf 'OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE=%s\n' "${OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE}"
  printf 'OPENGENI_MCP_INTERNAL_URL=%s\n' "${OPENGENI_MCP_INTERNAL_URL}"
  if [ -n "${OPENGENI_MCP_URL:-}" ]; then
    printf 'OPENGENI_MCP_URL=%s\n' "${OPENGENI_MCP_URL}"
  fi
  printf 'OPENGENI_CODEX_SUBSCRIPTION_ENABLED=%s\n' "${OPENGENI_CODEX_SUBSCRIPTION_ENABLED}"
  printf 'OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED=%s\n' "${OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED}"
  printf 'NODE_ENV=%s\n' "${NODE_ENV}"
  printf 'OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST=%s\n' "${OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST}"
  printf 'OPENGENI_ARTIFACT_TOOL_ENTRY=%s\n' "${OPENGENI_ARTIFACT_TOOL_ENTRY}"
  printf 'OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE=%s\n' "${OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE}"
  printf 'OPENGENI_ARTIFACT_MATERIALIZER_ENABLED=%s\n' "${OPENGENI_ARTIFACT_MATERIALIZER_ENABLED}"
  printf 'OPENGENI_ARTIFACT_OUTBOX_ENABLED=%s\n' "${OPENGENI_ARTIFACT_OUTBOX_ENABLED}"
  printf 'OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT=%s\n' "${OPENGENI_ARTIFACT_LOCAL_DEVELOPMENT}"
  printf 'OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT=%s\n' "${OPENGENI_ARTIFACT_MATERIALIZER_UNSANDBOXED_DEVELOPMENT}"
  printf 'OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST=%s\n' "${OPENGENI_ARTIFACT_MATERIALIZER_HTTP_HOST}"
  printf 'OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL=%s\n' "${OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_URL}"
  printf 'OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE=%s\n' "${OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE}"
  printf 'OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL=%s\n' "${OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL}"
  printf 'OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE=%s\n' "${OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE}"
  printf 'VITE_API_BASE_URL=%s\n' "${VITE_API_BASE_URL}"
} >.env.runtime

echo "OpenGeni worktree stack: project=${COMPOSE_PROJECT_NAME} backend=${OPENGENI_DEV_BACKEND} sandbox=${OPENGENI_SANDBOX_BACKEND}"
echo "  api=${VITE_API_BASE_URL}  web=http://127.0.0.1:${OPENGENI_WEB_PORT}"
echo "  postgres=127.0.0.1:${OPENGENI_POSTGRES_HOST_PORT}  nats=${OPENGENI_NATS_URL}"
echo "  temporal=${OPENGENI_TEMPORAL_HOST}  object-storage=${OPENGENI_OBJECT_STORAGE_ENDPOINT} (${OPENGENI_OBJECT_STORAGE_FIXTURE})"
if [ "$OPENGENI_DEV_BACKEND" = "native" ]; then
  echo "  temporal-ui=http://127.0.0.1:${OPENGENI_TEMPORAL_UI_HOST_PORT}"
fi
echo "  artifact-materializer=http://127.0.0.1:${OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT}  artifact-outbox=http://127.0.0.1:${OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT}"
echo "  Wrote .env.runtime (source it in sibling shells)."

if [ "$OPENGENI_DEV_BACKEND" = "native" ]; then
  bash scripts/dev-native-infra.sh start
elif [ "$OPENGENI_OBJECT_STORAGE_FIXTURE" = "minio" ]; then
  docker compose --profile minio up -d postgres nats temporal minio minio-init
else
  docker compose up -d postgres nats temporal garage garage-init
fi
(cd packages/db && bun run migrate)
(cd packages/db && bun run provision-roles)
# The sidecars need only their dedicated DSNs. Do not leak raw provisioning
# passwords into API/web/worker child environments after role convergence.
unset OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_PASSWORD
unset OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD
if [ "${OPENGENI_CATALOG_IMPORT_ENABLED:-true}" = "true" ]; then
  OPENGENI_DATABASE_URL="$OPENGENI_MIGRATIONS_DATABASE_URL" \
    bun scripts/import-integrations-catalog.ts \
      --snapshot data/catalog/integrations-snapshot.json --if-changed --skip-logos
fi
if [ "${OPENGENI_SANDBOX_BACKEND:-docker}" = "docker" ]; then
  # 6gb was the documented cap before one build's cache working set (10-14 GB)
  # was measured; copied .env files still carry it and it makes every start
  # evict and rebuild the whole image. Treat that exact stale value as unset;
  # any other explicit value remains authoritative.
  if [ "${OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX:-}" = "6gb" ]; then
    echo "OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX=6gb is below one sandbox build's cache working set; using the default cap instead (set another explicit value in .env to override)." >&2
    unset OPENGENI_DEV_SANDBOX_BUILD_CACHE_MAX
  fi
  bun scripts/prepare-development-sandbox-image.ts \
    --repository-root "$(pwd)" \
    --image "${OPENGENI_DOCKER_IMAGE}" \
    --runtime-bundle "${sandbox_runtime_bundle}" \
    --source-sha "$(git rev-parse HEAD)" \
    --lease-id "${COMPOSE_PROJECT_NAME}" \
    --lease-pid "$$" \
    --lease-token "${opengeni_dev_stack_token}"
else
  echo "Skipping local Docker sandbox image build (backend=${OPENGENI_SANDBOX_BACKEND:-docker})."
fi

if [ "$start_local_relay" = "1" ]; then
  env "${relay_cargo_env[@]+"${relay_cargo_env[@]}"}" \
    bash scripts/run-development-relay.sh &
  register_process "$!" "connected-machine relay"
fi

(cd apps/api && bun run dev) &
register_process "$!" "API"

(cd apps/worker && OPENGENI_WORKER_ROLE=control bun run dev:watch) &
register_process "$!" "control worker"

(cd apps/worker && OPENGENI_WORKER_ROLE=turn \
  OPENGENI_WORKER_HTTP_PORT="${OPENGENI_TURN_WORKER_HTTP_PORT}" bun run dev:watch) &
register_process "$!" "turn worker"

(cd apps/worker && bun run start:artifact-materializer) &
register_process "$!" "artifact materializer"

(cd apps/worker && bun run start:artifact-outbox) &
register_process "$!" "artifact outbox"

# The web setup surface serves the unpacked Chrome bridge archive directly from
# apps/browser-extension/dist. Starting Vite without the package build leaves a
# perfectly healthy machine agent advertising browserBridge=true while the
# only way to attach an existing Chrome profile returns 503. Keep the dev-stack
# launcher aligned with apps/web's own dev script and fail before Vite starts if
# the deterministic extension artifact cannot be produced.
bun run --cwd apps/browser-extension build
(cd apps/web && bun x vite dev --port "${OPENGENI_WEB_PORT}" --host 0.0.0.0) &
register_process "$!" "web"

bun scripts/watch-development-schema.ts "$(pwd)" &
register_process "$!" "database schema guard"

if ! wait_for_stack_readiness; then
  exit "$failed_process_status"
fi
if ! monitor_dev_stack; then
  exit "$failed_process_status"
fi
