#!/usr/bin/env bash
# install-agent-build-tools.sh — install the exact third-party tools the agent
# release builds and signs with, and nothing newer.
#
#   scripts/install-agent-build-tools.sh [--check] TOOL...
#
# TOOL is one or more of:
#   zigbuild  cargo-zigbuild and the zig compiler it links with (the ziglang
#             wheel, verified by hash), for the static musl agent and the glibc
#             2.28 helpers.
#   rsign     rsign2, the pure-Rust minisign signer.
#   rcodesign apple-codesign, which Developer-ID signs and notarizes macOS
#             releases.
#
# Every version is exact, crates install with --locked from their published
# lockfile, and the wheel installs only by its recorded hash, so a new upstream
# release can never enter a build or a signing step unreviewed. Run this in a
# step WITHOUT signing credentials: it fetches and compiles third-party code.
# --check installs nothing and fails unless the exact versions are present
# (bake-agent.sh's signing mode uses it).
#
# Changing a pin: choose a complete release that is not yanked, update the
# version here and, for zig, every wheel hash of that release from
# https://pypi.org/pypi/ziglang/<version>/json.
set -euo pipefail

CARGO_ZIGBUILD_VERSION=0.24.0
RSIGN2_VERSION=0.6.7
APPLE_CODESIGN_VERSION=0.29.0
ZIGLANG_VERSION=0.16.0
# Every published ziglang 0.16.0 wheel (macOS arm64/x86_64; Linux i686,
# x86_64, aarch64, armv7l, ppc64le, s390x, riscv64; Windows x86, x64, arm64).
# pip picks the one for this runner.
ZIGLANG_HASHES=(
  b61e5413c49508d9d62e5dcea543e3af491594154d74a00ff52f84ed508260cc
  18e14f6b25678d7b7c65708c82501ee6090fe39ed5c783477d56267af1fa5629
  8b83661247430aa335b3cbc29569084900412dde5633b02c80a6d2ff734de3d2
  9fcda73f62b851dd72a54b710ad40a209896db14cfb13649e62191243556342b
  e27d409812b11e0fb89ed0200cf2e55b6464d43f9461553104e4a4f9a94a1fd5
  7249779f0f916cfd2d1a9d54eb7600f3901384dc8dcbe1eea226bd32a8237fb5
  0fd671c599f6961638cc302cf1f9461486696385311d4c0276171dcf7d2b67f5
  df0e6599e41d087c912b0d3d7cedef6c9cb1f0032465c8fc820e9986772d11e4
  d4bd8197344fffe276e1d6446e4ef7bc38637d821b4685fe96a936503d4b0619
  f978c12b5337cf418034964de00023b7ec5ec484383dc97c6a6585f4a9105840
  089a16a4eb5a2f45151993342f8fabad24ff1a0723dc146642895c29208a3939
  e44a5271f7b72f7980017bb615823ed52e765f96b6482d93a2fd338cd53101bf
)

log() { printf '%s\n' "install-agent-build-tools: $*" >&2; }

CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
  shift
fi
if [ "$#" -eq 0 ]; then
  log "usage: $0 [--check] zigbuild|rsign|rcodesign..."
  exit 2
fi

# cargo-zigbuild runs `python3 -m ziglang` (CARGO_ZIGBUILD_PYTHON_PATH) before
# any `zig` on PATH, so the wheel in that interpreter is the zig it uses.
PYTHON="${CARGO_ZIGBUILD_PYTHON_PATH:-python3}"

crate_installed() {
  # Read the whole list first: grep -q may exit before cargo finishes writing,
  # and under pipefail that would read as "not installed".
  local installed
  installed="$(cargo install --list 2>/dev/null || true)"
  grep -Fxq "$1 v$2:" <<<"$installed"
}

ensure_crate() {
  local crate="$1" version="$2" binary="$3"
  if crate_installed "$crate" "$version" && command -v "$binary" >/dev/null 2>&1; then
    return
  fi
  if [ "$CHECK" = "1" ]; then
    log "$crate $version is not installed; run scripts/install-agent-build-tools.sh in a step without the signing key"
    exit 1
  fi
  log "installing $crate $version"
  cargo install --locked --version "$version" "$crate"
  crate_installed "$crate" "$version" || { log "$crate $version did not install"; exit 1; }
  command -v "$binary" >/dev/null 2>&1 || { log "$binary is not on PATH"; exit 1; }
}

zig_version() {
  "$PYTHON" -m ziglang version 2>/dev/null || true
}

ensure_ziglang() {
  if [ "$(zig_version)" = "$ZIGLANG_VERSION" ]; then
    return
  fi
  if [ "$CHECK" = "1" ]; then
    log "zig $ZIGLANG_VERSION (the ziglang wheel) is not installed for $PYTHON"
    exit 1
  fi
  log "installing ziglang $ZIGLANG_VERSION (the zig compiler cargo-zigbuild uses)"
  REQUIREMENTS="$(mktemp)"
  trap 'rm -f "$REQUIREMENTS"' EXIT
  {
    printf 'ziglang==%s' "$ZIGLANG_VERSION"
    for hash in "${ZIGLANG_HASHES[@]}"; do printf ' \\\n    --hash=sha256:%s' "$hash"; done
    printf '\n'
  } > "$REQUIREMENTS"
  local pip=("$PYTHON" -m pip install --disable-pip-version-check --no-deps
    --only-binary=:all: --require-hashes -r "$REQUIREMENTS")
  "${pip[@]}" || "${pip[@]}" --user
  if [ "$(zig_version)" != "$ZIGLANG_VERSION" ]; then
    log "zig $ZIGLANG_VERSION is still not what $PYTHON -m ziglang runs"
    exit 1
  fi
}

for tool in "$@"; do
  case "$tool" in
    zigbuild)
      ensure_crate cargo-zigbuild "$CARGO_ZIGBUILD_VERSION" cargo-zigbuild
      ensure_ziglang
      ;;
    rsign) ensure_crate rsign2 "$RSIGN2_VERSION" rsign ;;
    rcodesign) ensure_crate apple-codesign "$APPLE_CODESIGN_VERSION" rcodesign ;;
    *)
      log "unknown tool $tool"
      exit 2
      ;;
  esac
done
