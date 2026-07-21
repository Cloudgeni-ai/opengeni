#!/usr/bin/env bash
# bake-agent.sh — compile, sign, and stage the per-SHA opengeni-agent binaries the
# API image serves from /agent/* (the "agent ships inside the control-plane"
# decision; agent-distribution).
#
# Run this as a CI STEP in the deployed-env API image build (release.yml here, and
# the ops-repo per-SHA preview/staging/prod image builds) BEFORE `docker build`.
# It builds the two static Linux musl binaries that match THIS exact control-plane
# SHA, signs + checksums each, and writes them into agent/install/baked/ so they
# ride into the image via the Dockerfile's existing `COPY . .`.
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
#
# Mirrors agent-release.yml's Linux build: static musl via cargo-zigbuild, signed
# with rsign2 (pure-Rust minisign). Both tools are pure-Rust so the runner needs no
# system minisign / musl-gcc.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAKED_DIR="$REPO_ROOT/agent/install/baked"
AGENT_DIR="$REPO_ROOT/agent"

TARGETS="${OGE_BAKE_TARGETS:-x86_64-unknown-linux-musl aarch64-unknown-linux-musl}"

log() { printf '%s\n' "bake-agent: $*" >&2; }

sha256_of_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

mkdir -p "$BAKED_DIR"

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
  KEY_FILE="$(mktemp)"
  trap 'rm -f "$KEY_FILE"' EXIT
  printf '%s' "$OPENGENI_AGENT_MINISIGN_KEY" > "$KEY_FILE"
else
  log "WARNING: OPENGENI_AGENT_MINISIGN_KEY is absent — binaries will be checksum-only (UNSIGNED)."
  if [ "${OGE_BAKE_ALLOW_UNSIGNED:-0}" != "1" ]; then
    log "ERROR: refusing to bake unsigned binaries. Set OPENGENI_AGENT_MINISIGN_KEY, or OGE_BAKE_ALLOW_UNSIGNED=1 to override."
    exit 1
  fi
fi

for target in $TARGETS; do
  asset="opengeni-agent-${target}"
  log "building $asset (static musl) via cargo-zigbuild"
  ( cd "$AGENT_DIR" \
    && rustup target add "$target" >/dev/null 2>&1 || true \
    && cargo zigbuild --release --target "$target" -p opengeni-agent )
  cp "$AGENT_DIR/target/${target}/release/opengeni-agent" "$BAKED_DIR/$asset"
  chmod 0755 "$BAKED_DIR/$asset"

  # sha256 sidecar (the install script's GATE 1). Store ONLY the hash (the install
  # script's `cut -d' ' -f1` reads the first field, so a bare hash is portable too).
  ( cd "$BAKED_DIR" && sha256_of_file "$asset" > "$asset.sha256" )

  if [ "$HAVE_KEY" = "1" ]; then
    # The release key is passwordless (generated with -W); sign with -W so rsign
    # never blocks on a TTY password prompt. Detached sig is <asset>.minisig —
    # the install script's GATE 2 trust root.
    rsign sign -W -s "$KEY_FILE" -x "$BAKED_DIR/$asset.minisig" "$BAKED_DIR/$asset"
    log "signed + checksummed $asset"
  else
    rm -f "$BAKED_DIR/$asset.minisig"
    log "checksummed (UNSIGNED) $asset"
  fi
done

log "baked into $BAKED_DIR:"
ls -l "$BAKED_DIR" >&2
