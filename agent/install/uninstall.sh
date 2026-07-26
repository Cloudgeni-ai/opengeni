#!/bin/sh
# shellcheck shell=sh
#
# OpenGeni self-hosted agent uninstaller — Linux + macOS, STRICT POSIX sh.
# =============================================================================
#
#   curl -fsSL https://get.opengeni.ai/uninstall.sh | sh
#
# Stops any opt-in service, removes the installed binary, and (only with
# --purge / OPENGENI_PURGE=1) deletes the persisted enrollment credentials and
# asks the control plane to deactivate the enrollment so the machine does not
# linger as a ghost in the Machines dashboard. By default the credentials are
# LEFT in place so a re-install reconnects without re-enrolling.
#
# Environment overrides:
#   OPENGENI_INSTALL_DIR   Where the binary lives. Default: ~/.local/bin
#                          (or /usr/local/bin when OPENGENI_SYSTEM=1).
#   OPENGENI_SYSTEM=1      The binary was installed system-wide.
#   OPENGENI_CONFIG_DIR    The credential dir. Default: ~/.config/opengeni/agent.
#   OPENGENI_PURGE=1       Also remove credentials + deactivate the enrollment.
#
# Flags: --purge (same as OPENGENI_PURGE=1).
# =============================================================================

set -eu

PURGE="${OPENGENI_PURGE:-0}"
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help)
      printf '%s\n' "usage: uninstall.sh [--purge]"
      printf '%s\n' "  --purge   also delete credentials + deactivate the enrollment"
      exit 0
      ;;
    *) printf '%s\n' "opengeni-uninstall: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

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

# Stop + remove any opt-in service first; the binary owns the per-OS teardown.
if [ -x "$bin" ]; then
  log "stopping + removing any opt-in service (no-op if none installed)"
  "$bin" service uninstall >/dev/null 2>&1 || true

  if [ "$PURGE" = "1" ]; then
    log "purge: deactivating the enrollment with the control plane"
    "$bin" uninstall --purge >/dev/null 2>&1 || \
      log "could not deactivate the enrollment (it may already be gone)"
  fi
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

# Purge credentials only when asked.
if [ "$PURGE" = "1" ]; then
  config_dir="$(resolve_config_dir)"
  if [ -d "$config_dir" ]; then
    rm -rf "$config_dir" && log "removed credentials at $config_dir"
  fi
  log "purge complete — this machine is fully removed."
else
  log "credentials left in place (re-install to reconnect). Pass --purge to remove them."
fi
