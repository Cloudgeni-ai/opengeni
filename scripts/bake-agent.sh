#!/usr/bin/env bash
# bake-agent.sh — compile, sign, and stage the per-SHA opengeni-agent binaries the
# API image serves from /agent/* (the "agent ships inside the control-plane"
# decision; agent-distribution).
#
# Run this as a CI STEP in the deployed-env API image build
# (release-candidate.yml here, and operator-controlled per-SHA builds) BEFORE
# `docker build`.
# It builds both complete Linux target cohorts with one exact source identity:
# a portable musl agent embedding browserd, the pinned browser driver, and the
# native computer helper. All four assets receive checksums and signatures in
# agent/install/baked/ before the Dockerfile's existing `COPY . .`.
#
# WHY a pre-build CI step (not the Dockerfile): the minisign signing key
# (OPENGENI_AGENT_MINISIGN_KEY) must never enter the Docker build layers. Signing
# here keeps the key in the CI step's masked env only; the build context receives
# already-signed, public artifacts.
#
#   OPENGENI_AGENT_MINISIGN_KEY   the minisign secret key body (same key the
#                                 install scripts pin). REQUIRED to sign. When
#                                 ABSENT the script still builds + checksums but
#                                 SKIPS signing and exits non-zero unless
#                                 OGE_BAKE_ALLOW_UNSIGNED=1 (so a key-less build
#                                 fails loud rather than baking an unverifiable
#                                 binary). An un-baked asset just falls through to
#                                 the GitHub-Releases redirect at serve time.
#   OGE_BAKE_TARGETS              space-separated cargo target triples to bake.
#                                 Default: the two Linux musl triples install.sh
#                                 resolves for Linux x86_64/aarch64.
#   OGE_BAKE_ALLOW_UNSIGNED=1     permit a checksum-only (unsigned) bake.
#   OPENGENI_RUNTIME_BUILD_ID     exact source commit, required for every target.
#
# Mirrors agent-release.yml's coherent Linux build: glibc helpers embedded in a
# static musl parent via cargo-zigbuild, signed
# with rsign2 (pure-Rust minisign). Both tools are pure-Rust so the runner needs no
# system minisign / musl-gcc.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAKED_DIR="$REPO_ROOT/agent/install/baked"
AGENT_DIR="$REPO_ROOT/agent"

TARGETS="${OGE_BAKE_TARGETS:-x86_64-unknown-linux-musl aarch64-unknown-linux-musl}"
RUNTIME_BUILD_ID="${OPENGENI_RUNTIME_BUILD_ID:-}"

# A distributable canary is one exact-source runtime, never a development agent
# that discovers independently downloaded companions beside itself.
if [[ ! "$RUNTIME_BUILD_ID" =~ ^[a-f0-9]{40}$ ]] \
  || [ "$RUNTIME_BUILD_ID" != "$(git -C "$REPO_ROOT" rev-parse HEAD)" ]; then
  printf '%s\n' 'bake-agent: OPENGENI_RUNTIME_BUILD_ID must be the exact source commit' >&2
  exit 1
fi
export OPENGENI_RUNTIME_BUILD_ID="$RUNTIME_BUILD_ID"

log() { printf '%s\n' "bake-agent: $*" >&2; }

sha256_of_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

mkdir -p "$BAKED_DIR"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

# --- Toolchain: cargo-zigbuild gives a robust static musl cross-link with no
# system musl-gcc (the agent-release.yml pattern). It needs BOTH its own binary
# AND a `zig` compiler, and the two cache DIFFERENTLY: cargo-zigbuild lands in
# ~/.cargo/bin (restored by Swatinem/rust-cache), but `zig` comes from the
# `ziglang` pip wheel, which is NOT part of the cargo cache. Gating the wheel
# install on the binary's absence (the old behaviour) therefore SKIPPED zig on
# every warm-cache run → "Error: Failed to find zig". Install each against its
# OWN presence check so a cached cargo-zigbuild can never mask a missing zig.
# Idempotent.
if ! command -v cargo-zigbuild >/dev/null 2>&1; then
  log "installing cargo-zigbuild"
  cargo install --locked cargo-zigbuild
fi
# cargo-zigbuild resolves zig from PATH or the `python -m ziglang` wheel; ensure
# one of them is present regardless of the cargo-zigbuild cache state.
if ! command -v zig >/dev/null 2>&1 \
  && ! python3 -m ziglang version >/dev/null 2>&1 \
  && ! python -m ziglang version >/dev/null 2>&1; then
  log "installing ziglang (pip wheel — provides zig for cargo-zigbuild)"
  pip install ziglang >/dev/null 2>&1 || pip3 install ziglang >/dev/null 2>&1 \
    || pip install --user ziglang || pip3 install --user ziglang
fi

# --- Signing key presence (mirrors agent-release.yml's loud key-absent handling).
HAVE_KEY=0
if [ -n "${OPENGENI_AGENT_MINISIGN_KEY:-}" ]; then
  HAVE_KEY=1
  if ! command -v rsign >/dev/null 2>&1; then
    log "installing rsign2 (pure-Rust minisign signer)"
    cargo install --locked rsign2
  fi
  KEY_FILE="$STAGE_DIR/signing-key"
  umask 077
  printf '%s' "$OPENGENI_AGENT_MINISIGN_KEY" > "$KEY_FILE"
else
  log "WARNING: OPENGENI_AGENT_MINISIGN_KEY is absent — binaries will be checksum-only (UNSIGNED)."
  if [ "${OGE_BAKE_ALLOW_UNSIGNED:-0}" != "1" ]; then
    log "ERROR: refusing to bake unsigned binaries. Set OPENGENI_AGENT_MINISIGN_KEY, or OGE_BAKE_ALLOW_UNSIGNED=1 to override."
    exit 1
  fi
fi

for target in $TARGETS; do
  case "$target" in
    x86_64-unknown-linux-musl) bun_target=bun-linux-x64; browser_arch=x64 ;;
    aarch64-unknown-linux-musl) bun_target=bun-linux-arm64; browser_arch=arm64 ;;
    *) log "unsupported canary interaction target $target"; exit 1 ;;
  esac
  browserd="$STAGE_DIR/opengeni-browserd-$target"
  agent_browser="$STAGE_DIR/opengeni-agent-browser-$target"
  computer_native="$STAGE_DIR/opengeni-computer-native-$target"
  log "building the complete $target interaction runtime"
  (
    cd "$REPO_ROOT"
    # Helpers use host-native glibc; the parent agent remains portable musl.
    bun build --compile --target="$bun_target" packages/browserd/src/main.ts \
      --define "process.env.OPENGENI_RUNTIME_BUILD_ID=\"$RUNTIME_BUILD_ID\"" \
      --outfile "$browserd"
    OPENGENI_BROWSERD_TARGET_PLATFORM=linux \
    OPENGENI_BROWSERD_TARGET_ARCH="$browser_arch" \
    OPENGENI_BROWSERD_TARGET_MUSL=false \
    OPENGENI_BROWSERD_AGENT_BROWSER_OUTPUT="opengeni-agent-browser-$target" \
      bun packages/browserd/scripts/stage-agent-browser.ts
    cp "packages/browserd/dist/opengeni-agent-browser-$target" "$agent_browser"
  )
  test -s "$browserd"
  test -s "$agent_browser"
  interp="$(readelf -l "$browserd" | sed -n 's/.*program interpreter: \(.*\)]/\1/p')"
  case "$target:$interp" in
    x86_64-unknown-linux-musl:/lib64/ld-linux-x86-64.so.2|aarch64-unknown-linux-musl:/lib/ld-linux-aarch64.so.1) ;;
    *) log "browserd must use the native glibc dynamic linker"; exit 1 ;;
  esac
  if readelf -d "$browserd" | grep -F 'libc.musl'; then
    log "browserd must not link musl libc"; exit 1
  fi
  (
    cd "$AGENT_DIR"
    rustup target add "$target"
    cargo zigbuild --locked --release --target "$target" -p opengeni-computer-native
  )
  cp "$AGENT_DIR/target/$target/release/opengeni-computer-native" "$computer_native"
  test -s "$computer_native"
  (
    cd "$AGENT_DIR"
    OPENGENI_EMBEDDED_BROWSERD="$browserd" \
    OPENGENI_EMBEDDED_AGENT_BROWSER="$agent_browser" \
    OPENGENI_EMBEDDED_COMPUTER_NATIVE="$computer_native" \
      cargo zigbuild --locked --release --target "$target" -p opengeni-agent
  )
  cp "$AGENT_DIR/target/$target/release/opengeni-agent" "$STAGE_DIR/opengeni-agent-$target"
  for component in opengeni-agent opengeni-browserd opengeni-agent-browser opengeni-computer-native; do
    asset="$component-$target"
    test -s "$STAGE_DIR/$asset"
    chmod 0755 "$STAGE_DIR/$asset"
    ( cd "$STAGE_DIR" && sha256_of_file "$asset" > "$asset.sha256" )
    if [ "$HAVE_KEY" = "1" ]; then
      rsign sign -W -s "$KEY_FILE" -x "$STAGE_DIR/$asset.minisig" "$STAGE_DIR/$asset"
      test -s "$STAGE_DIR/$asset.minisig"
    fi
  done
done

# Nothing enters the image input directory until every requested target is built.
for target in $TARGETS; do
  for component in opengeni-agent opengeni-browserd opengeni-agent-browser opengeni-computer-native; do
    asset="$component-$target"
    cp "$STAGE_DIR/$asset" "$STAGE_DIR/$asset.sha256" "$BAKED_DIR/"
    if [ "$HAVE_KEY" = "1" ]; then cp "$STAGE_DIR/$asset.minisig" "$BAKED_DIR/"
    else rm -f "$BAKED_DIR/$asset.minisig"
    fi
  done
done

log "baked into $BAKED_DIR:"
ls -l "$BAKED_DIR" >&2
