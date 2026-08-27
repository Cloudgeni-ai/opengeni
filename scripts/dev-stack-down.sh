#!/usr/bin/env bash
# Stop, and optionally remove, ONLY this checkout / git worktree's local OpenGeni
# stack: the Docker Compose or native infrastructure project that `bun run dev`
# created and, with --clean, that project's data plus generated runtime file.
#
#   bun run dev:down          stop this worktree's dependency infrastructure
#   bun run dev:clean         ... and its data, sandbox image tags, .env.runtime
#
# It never prunes unrelated images, volumes, networks, build caches, or another
# worktree's stack. Host dev processes are not managed here; `bun run dev` is a
# foreground process and Ctrl-C already stops them.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/dev-stack-down.sh [--clean] [--yes]

  --clean   Also remove this worktree's Postgres/object-storage data, its
            source-tagged Docker sandbox image references, and .env.runtime.
  --yes,-y  Do not prompt before removing data (implied when stdin is not a TTY).
EOF
}

mode=down
assume_yes=0
for argument in "$@"; do
  case "$argument" in
  --clean) mode=clean ;;
  --yes | -y) assume_yes=1 ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown argument: $argument" >&2
    usage >&2
    exit 2
    ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# shellcheck disable=SC1091
. ./scripts/dev-stack-project.sh
COMPOSE_PROJECT_NAME="$(resolve_compose_project_name)"
# `bun run dev` records the project it actually used; prefer that exact name so a
# later OPENGENI_COMPOSE_PROJECT edit cannot leave the real stack behind.
if [ -f .env.runtime ]; then
  runtime_project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env.runtime | tail -1)"
  if [ -n "$runtime_project" ]; then
    COMPOSE_PROJECT_NAME="$runtime_project"
  fi
fi
export COMPOSE_PROJECT_NAME
runtime_backend=""
if [ -f .env.runtime ]; then
  runtime_backend="$(sed -n 's/^OPENGENI_DEV_BACKEND=//p' .env.runtime | tail -1)"
fi
if [ -n "$runtime_backend" ]; then
  OPENGENI_DEV_BACKEND="$runtime_backend"
else
  # No recorded run exists. Resolve the requested/default backend so an
  # explicit native cleanup still works before the first successful startup.
  # shellcheck disable=SC1091
  . ./scripts/dev-stack-backend.sh
  OPENGENI_DEV_BACKEND="$(opengeni_resolve_dev_backend)"
fi
export OPENGENI_DEV_BACKEND

echo "OpenGeni worktree stack: project=${COMPOSE_PROJECT_NAME} backend=${OPENGENI_DEV_BACKEND} (${mode})"

if [ "$OPENGENI_DEV_BACKEND" = "native" ]; then
  if [ "$mode" = "clean" ]; then
    if [ "$assume_yes" != "1" ] && [ -t 0 ]; then
      printf 'Remove native project %s including its Postgres/MinIO data? [y/N] ' "$COMPOSE_PROJECT_NAME"
      read -r answer
      case "$answer" in
      y | Y | yes | YES) ;;
      *)
        echo "Aborted; nothing removed."
        exit 1
        ;;
      esac
    fi
    bash scripts/dev-native-infra.sh down --clean
    rm -f .env.runtime
    echo "  removed .env.runtime; the next 'bun run dev' starts from a fresh database."
  else
    bash scripts/dev-native-infra.sh down
  fi
  echo "Done."
  exit 0
fi

# docker-compose.yml interpolates these; the real values no longer matter for
# stopping, but an unset config path would make Compose reject the file.
export OPENGENI_NATS_CONFIG_FILE="${OPENGENI_NATS_CONFIG_FILE:-$(pwd)/deploy/nats/local-development.conf}"

# Sandbox containers (started by the Agents SDK, labelled openai-agents-sandbox)
# join ${COMPOSE_PROJECT_NAME}_default and would otherwise keep the Compose
# network alive after `down`. Only sandbox-labelled containers attached to this
# exact network are removed here; Compose stops its own services gracefully.
sandbox_network="${COMPOSE_PROJECT_NAME}_default"
sandbox_containers="$(
  docker ps -aq --filter "network=${sandbox_network}" --filter "label=openai-agents-sandbox=true" 2>/dev/null || true
)"
if [ -n "$sandbox_containers" ]; then
  # shellcheck disable=SC2086
  docker rm -f $sandbox_containers >/dev/null
  echo "  removed $(printf '%s\n' "$sandbox_containers" | wc -l | tr -d ' ') sandbox container(s) on ${sandbox_network}"
fi

if [ "$mode" = "clean" ]; then
  if [ "$assume_yes" != "1" ] && [ -t 0 ]; then
    printf 'Remove compose project %s including its Postgres/object-storage volumes? [y/N] ' "$COMPOSE_PROJECT_NAME"
    read -r answer
    case "$answer" in
    y | Y | yes | YES) ;;
    *)
      echo "Aborted; nothing removed."
      exit 1
      ;;
    esac
  fi
  docker compose --profile minio down --remove-orphans --volumes
  # Only this worktree's source-tagged sandbox images (suffix = exact project).
  image_tags="$(
    docker image ls --format '{{.Repository}}:{{.Tag}}' opengeni-sandbox 2>/dev/null |
      grep -E "^opengeni-sandbox:local-[0-9a-f]{12,64}-${COMPOSE_PROJECT_NAME}\$" || true
  )"
  if [ -n "$image_tags" ]; then
    # shellcheck disable=SC2086
    docker image rm $image_tags >/dev/null 2>&1 || true
    echo "  removed sandbox image tag(s): $(printf '%s ' $image_tags)"
  fi
  rm -f .env.runtime
  echo "  removed volumes and .env.runtime; the next 'bun run dev' starts from a fresh database."
else
  docker compose --profile minio down --remove-orphans
fi
echo "Done."
