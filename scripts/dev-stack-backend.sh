#!/usr/bin/env bash
# Resolve the infrastructure backend used by scripts/dev-stack.sh.

opengeni_load_dev_environment() {
  # An invocation's backend choice is authority, not a default that a copied
  # .env.example may silently replace. Other dotenv behavior is unchanged.
  local backend_was_set="${OPENGENI_DEV_BACKEND+x}"
  local invocation_backend="${OPENGENI_DEV_BACKEND-}"
  set -a
  # shellcheck disable=SC1090
  . "$1"
  set +a
  if [ "$backend_was_set" = x ]; then
    export OPENGENI_DEV_BACKEND="$invocation_backend"
  fi
}

opengeni_docker_usable() {
  command -v docker >/dev/null 2>&1 || return 1

  # A Docker client may be installed while its daemon/socket is unavailable in
  # a restricted sandbox. Bound the server probe so automatic startup cannot
  # hang on a dead desktop daemon or forwarded socket.
  local probe_timeout="${OPENGENI_DOCKER_PROBE_TIMEOUT_SECONDS:-3}"
  # macOS does not ship GNU timeout. Bun is already the launcher prerequisite;
  # use its process deadline on every supported host, not advisory Docker envs.
  OPENGENI_DOCKER_PROBE_SECONDS="$probe_timeout" bun -e '
    const seconds = Number(process.env.OPENGENI_DOCKER_PROBE_SECONDS);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) process.exit(1);
    try {
      const result = Bun.spawnSync(["docker", "info"], {
        stdout: "ignore", stderr: "ignore", timeout: seconds * 1000,
      });
      process.exit(result.exitCode === 0 ? 0 : 1);
    } catch { process.exit(1); }
  ' >/dev/null 2>&1
}

opengeni_resolve_dev_backend() {
  local requested="${OPENGENI_DEV_BACKEND:-auto}"

  case "$requested" in
  auto)
    if opengeni_docker_usable; then
      printf 'docker\n'
    else
      printf 'native\n'
    fi
    ;;
  native)
    printf 'native\n'
    ;;
  docker)
    if ! command -v docker >/dev/null 2>&1; then
      echo "OPENGENI_DEV_BACKEND=docker was requested, but the Docker client is unavailable." >&2
      return 1
    fi
    if ! opengeni_docker_usable; then
      echo "OPENGENI_DEV_BACKEND=docker was requested, but the Docker daemon is unavailable." >&2
      return 1
    fi
    printf 'docker\n'
    ;;
  *)
    echo "OPENGENI_DEV_BACKEND must be auto, docker, or native." >&2
    return 1
    ;;
  esac
}
opengeni_resolve_dev_bind_host() {
  # The local stack serves an unauthenticated API, and the default local sandbox
  # runs agent commands directly on this machine. Host-facing services therefore
  # bind loopback unless the developer deliberately exposes them on 0.0.0.0.
  local requested="${OPENGENI_DEV_BIND_HOST:-127.0.0.1}"
  case "$requested" in
  127.0.0.1 | 0.0.0.0)
    printf '%s\n' "$requested"
    ;;
  *)
    echo "OPENGENI_DEV_BIND_HOST must be 127.0.0.1 (default) or 0.0.0.0." >&2
    return 1
    ;;
  esac
}
opengeni_dev_bind_host_notice() {
  # $1 = resolved bind host.
  if [ "$1" = "0.0.0.0" ]; then
    echo "OPENGENI_DEV_BIND_HOST=0.0.0.0: the unauthenticated API, web app, and infrastructure ports accept connections from your network. The API still answers browsers only for its configured addresses; set OPENGENI_WEB_BASE_URL (and VITE_API_BASE_URL) to the address other devices use."
  fi
}
opengeni_dev_sandbox_bridge_mode() {
  # How Docker sandboxes reach this stack's API. Prints:
  #   forward  Linux Docker Engine with a loopback API: publish only the
  #            sandbox routes on this worktree's Compose network gateway
  #            (scripts/dev-sandbox-bridge.ts).
  #   direct   Linux Docker Engine with OPENGENI_DEV_BIND_HOST=0.0.0.0: the API
  #            already listens on that gateway; only point sandboxes at it.
  #   none     Docker Desktop (macOS/Windows) forwards host.docker.internal to
  #            the loopback API, other sandbox backends do not run in Docker,
  #            and an explicit sandbox-reachable OPENGENI_MCP_URL is kept.
  # $1 = resolved bind host, $2 = sandbox backend, $3 = `uname -s`,
  # $4 = infrastructure backend.
  if [ "$2" != "docker" ] || [ "$3" != "Linux" ] || [ "$4" != "docker" ]; then
    echo none
    return
  fi
  if [ -n "${OPENGENI_MCP_URL:-}" ] &&
    ! [[ "${OPENGENI_MCP_URL}" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*://(127\.0\.0\.1|localhost|\[::1\]|host\.docker\.internal)([:/]|$) ]]; then
    echo none
    return
  fi
  if [ "$1" = "0.0.0.0" ]; then
    echo direct
  else
    echo forward
  fi
}
