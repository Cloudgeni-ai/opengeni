#!/usr/bin/env bash
# Resolve the infrastructure backend used by scripts/dev-stack.sh.

opengeni_docker_usable() {
  command -v docker >/dev/null 2>&1 || return 1

  # A Docker client may be installed while its daemon/socket is unavailable in
  # a restricted sandbox. Bound the server probe so automatic startup cannot
  # hang on a dead desktop daemon or forwarded socket.
  local probe_timeout="${OPENGENI_DOCKER_PROBE_TIMEOUT_SECONDS:-3}"
  if command -v timeout >/dev/null 2>&1; then
    timeout "${probe_timeout}s" \
      env DOCKER_CLIENT_TIMEOUT="$probe_timeout" COMPOSE_HTTP_TIMEOUT="$probe_timeout" \
      docker info >/dev/null 2>&1
  else
    DOCKER_CLIENT_TIMEOUT="$probe_timeout" \
      COMPOSE_HTTP_TIMEOUT="$probe_timeout" \
      docker info >/dev/null 2>&1
  fi
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