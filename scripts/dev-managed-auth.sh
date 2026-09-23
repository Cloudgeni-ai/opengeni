#!/usr/bin/env bash

# Called after loading the worktree environment. Never invent deployment secrets.
opengeni_ensure_local_managed_auth() {
  local env_file="$1" managed_secret_name
  [ "${OPENGENI_PRODUCT_ACCESS_MODE:-local}" = "managed" ] || return 0
  case "${OPENGENI_ENVIRONMENT:-local}" in local|test) ;; *) return 0 ;; esac
  for managed_secret_name in OPENGENI_BETTER_AUTH_SECRET OPENGENI_DELEGATION_SECRET; do
    if [ -z "${!managed_secret_name:-}" ]; then
      printf -v "$managed_secret_name" '%s' "$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"))')"
      export "$managed_secret_name"
      printf '%s=%s\n' "$managed_secret_name" "${!managed_secret_name}" >>"$env_file"
      chmod 600 "$env_file"
      echo "Generated and persisted $managed_secret_name for local managed-mode development."
    fi
  done
}