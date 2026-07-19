#!/bin/sh
# shellcheck shell=sh
#
# OpenGeni self-hosted agent uninstaller — Linux + macOS, STRICT POSIX sh.
# =============================================================================
#
#   curl -fsSL https://app.opengeni.ai/uninstall.sh | sh
#
# Stops any opt-in service, removes the installed binary, and (only with
# --purge / OPENGENI_PURGE=1) asks the control plane to revoke the enrollment
# BEFORE deleting the persisted credentials, so a failed or ambiguous request is
# retry-safe. By default the credentials are LEFT in place so a re-install
# reconnects without re-enrolling.
#
# Environment overrides:
#   OPENGENI_INSTALL_DIR   Where the binary lives. Default: ~/.local/bin
#                          (or /usr/local/bin when OPENGENI_SYSTEM=1).
#   OPENGENI_SYSTEM=1      The binary was installed system-wide.
#   OPENGENI_CONFIG_DIR    The credential dir. Default: ~/.config/opengeni/agent.
#   OPENGENI_PURGE=1       Also remove credentials + deactivate the enrollment.
#   OPENGENI_LOCAL_ONLY=1  With purge only: skip remote revoke and delete local
#                          state. The dashboard enrollment may remain active.
#
# Flags: --purge (same as OPENGENI_PURGE=1), --local-only (purge only).
# =============================================================================

set -eu

PURGE="${OPENGENI_PURGE:-0}"
LOCAL_ONLY="${OPENGENI_LOCAL_ONLY:-0}"
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help)
      printf '%s\n' "usage: uninstall.sh [--purge [--local-only]]"
      printf '%s\n' "  --purge       remotely revoke, then delete credentials"
      printf '%s\n' "  --local-only  with --purge only; skip remote revoke (dashboard enrollment may remain active)"
      exit 0
      ;;
    *) printf '%s\n' "opengeni-uninstall: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$LOCAL_ONLY" = "1" ] && [ "$PURGE" != "1" ]; then
  printf '%s\n' "opengeni-uninstall: --local-only requires --purge" >&2
  exit 2
fi

log() { printf '%s\n' "opengeni-uninstall: $*" >&2; }

resolve_install_dir() {
  if [ -n "${OPENGENI_INSTALL_DIR:-}" ]; then echo "$OPENGENI_INSTALL_DIR"; return; fi
  if [ "${OPENGENI_SYSTEM:-0}" = "1" ]; then echo "/usr/local/bin"; return; fi
  echo "${HOME}/.local/bin"
}

resolve_config_dir() {
  if [ -n "${OPENGENI_CONFIG_DIR:-}" ]; then echo "$OPENGENI_CONFIG_DIR"; return; fi
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then echo "$XDG_CONFIG_HOME/opengeni/agent"; return; fi
  echo "${HOME}/.config/opengeni/agent"
}

install_dir="$(resolve_install_dir)"
bin="$install_dir/opengeni-agent"

# With a purge, first let the binary perform remote revoke while both it and the
# stored bearer still exist. Do NOT swallow a failure: HTTP errors/timeouts and a
# malformed confirmation are ambiguous, and deleting either retry input would
# strand an active dashboard enrollment. `--local-only` is the explicit recovery
# escape hatch and is intentionally loud.
if [ -x "$bin" ]; then
  # Cleanup is a hard precondition for every destructive step. The native binary
  # probes both systemd scopes independently (or the exact LaunchAgent plist) and
  # distinguishes a missing unit from bus/permission/unknown failures. Never
  # revoke or delete while a KeepAlive service may still be running.
  log "stopping + removing every installed native service scope"
  "$bin" service uninstall || {
    log "service cleanup was not confirmed; keeping binary and credentials for recovery"
    exit 1
  }

  if [ "$PURGE" = "1" ]; then
    if [ "$LOCAL_ONLY" = "1" ]; then
      log "WARNING: --local-only skips remote revoke; the dashboard enrollment may remain active."
      "$bin" uninstall --purge --local-only || {
        log "local-only purge failed; keeping binary and credentials for recovery"
        exit 1
      }
    else
      log "purge: confirming remote enrollment revoke before local deletion"
      "$bin" uninstall --purge || {
        log "remote revoke was not confirmed; keeping binary and credentials so you can retry"
        exit 1
      }
    fi
  fi
elif [ "$PURGE" = "1" ] && [ "$LOCAL_ONLY" != "1" ]; then
  log "cannot remotely revoke: no executable at $bin; keeping local credentials for retry"
  exit 1
elif [ "$LOCAL_ONLY" = "1" ]; then
  log "WARNING: --local-only skips remote revoke; the dashboard enrollment may remain active."
fi

# Remove the binary. On macOS this path is a SYMLINK into the app bundle (see
# install.sh); `rm -f` drops the symlink itself, not its target — the bundle is
# removed separately below.
if [ -e "$bin" ] || [ -L "$bin" ]; then
  rm -f "$bin" && log "removed $bin"
else
  log "no binary found at $bin (already removed?)"
fi

# macOS: the installer puts the real binary in an app bundle under ~/Applications
# (the code-signing identity that carries the TCC grants). Uninstall is explicit
# user intent, so remove the whole bundle — ad-hoc or Developer-ID signed alike.
if [ "$(uname -s)" = "Darwin" ]; then
  app="${HOME}/Applications/OpenGeni Agent.app"
  if [ -d "$app" ]; then
    rm -rf "$app" && log "removed $app"
  fi
fi

# Purge credentials only after the binary confirmed remote revocation (or after
# the explicit local-only recovery override above). This is intentionally
# idempotent: a successful binary purge may already have removed this directory.
if [ "$PURGE" = "1" ]; then
  config_dir="$(resolve_config_dir)"
  if [ -d "$config_dir" ]; then
    rm -rf "$config_dir" && log "removed credentials at $config_dir"
  fi
  if [ "$LOCAL_ONLY" = "1" ]; then
    log "local-only purge complete — the dashboard enrollment may remain active."
  else
    log "purge complete — remote revoke was confirmed before local removal."
  fi
else
  log "credentials left in place (re-install to reconnect). Pass --purge to remove them."
fi
