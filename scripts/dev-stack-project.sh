# Shared Compose-project identity for one OpenGeni checkout / git worktree.
# Sourced by scripts/dev-stack.sh (start) and scripts/dev-stack-down.sh (stop /
# clean) so both always name the exact same Docker Compose project, network,
# volumes, and sandbox image tags. Callers must already be in the repository
# root with .env sourced.

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

# Compose project identity: directory basename (unique per linked worktree path).
# Ignore ambient COMPOSE_PROJECT_NAME from the parent shell — a prior export of
# `opengeni` would otherwise collapse every worktree onto one project. Override
# only via OPENGENI_COMPOSE_PROJECT in .env / the environment.
resolve_compose_project_name() {
  if [ -n "${OPENGENI_COMPOSE_PROJECT:-}" ]; then
    slugify "$OPENGENI_COMPOSE_PROJECT"
    return
  fi
  local project
  project="$(slugify "$(basename "$(pwd)")")"
  # Bare main-checkout directory name only — never rewrite an explicit override
  # (operators may still want COMPOSE project `opengeni` for legacy volumes).
  if [ "$project" = "opengeni" ]; then
    project="opengeni-main"
  fi
  printf '%s' "$project"
}
