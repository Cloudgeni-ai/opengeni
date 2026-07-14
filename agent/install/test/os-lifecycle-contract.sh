#!/bin/sh
# Portable lifecycle truth contracts. These are intentionally runnable on Linux:
# live macOS TCC and Windows SCM behavior still require native human acceptance.

set -eu

AGENT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
REPO_DIR=$(CDPATH= cd -- "$AGENT_DIR/.." && pwd)
INSTALL_SH="$AGENT_DIR/install/install.sh"
INSTALL_PS1="$AGENT_DIR/install/install.ps1"
RELEASE_WORKFLOW="$REPO_DIR/.github/workflows/agent-release.yml"

fail() { printf '%s\n' "FAIL: $*" >&2; exit 1; }

# Source only pure helpers; OPENGENI_INSTALL_LIB prevents downloads or mutation.
OPENGENI_INSTALL_LIB=1 . "$INSTALL_SH"
BASE_URL="https://updates.example"
VERSION="latest"
[ "$(asset_url agent.bin)" = "https://updates.example/agent/latest/agent.bin" ] \
  || fail "latest asset URL contract drifted"
VERSION="1.2.3"
[ "$(asset_url agent.bin)" = "https://updates.example/agent/v1.2.3/agent.bin" ] \
  || fail "pinned asset URL contract drifted"

grep -Fq 'installer exists only at $BASE/install.sh' "$INSTALL_SH" \
  || fail "canonical installer URL is undocumented"
if grep -Fq 'immutable copies at $BASE/v/<ver>/install.sh' "$INSTALL_SH"; then
  fail "stale versioned installer URL claim returned"
fi

if grep -E 'cargo build .*--features[ =]+macos-desktop' "$RELEASE_WORKFLOW" >/dev/null; then
  fail "stable macOS release unexpectedly enables experimental macos-desktop"
fi
grep -Fq 'stable macOS agents report display_unavailable' "$RELEASE_WORKFLOW" \
  || fail "stable macOS display_unavailable decision is not explicit"

grep -Fq 'Windows service subcommands are intentionally unsupported' "$INSTALL_PS1" \
  || fail "Windows unsupported service boundary is undocumented"
if grep -Fq 'service install' "$INSTALL_PS1"; then
  fail "Windows installer still recommends unsupported service install"
fi

sh -n "$INSTALL_SH"
sh -n "$AGENT_DIR/install/uninstall.sh"
printf '%s\n' 'os-lifecycle-contract OK: URLs, stable macOS feature gate, Windows foreground boundary'
