#!/usr/bin/env bash
# bake-agent.sh — compile, sign, and stage the per-SHA opengeni-agent binaries the
# API image serves from /agent/* (the "agent ships inside the control-plane"
# decision; agent-distribution).
#
#   scripts/bake-agent.sh [build]   compile and checksum every target, unsigned
#   scripts/bake-agent.sh sign      sign what `build` staged
#
# Run both as CI STEPS in the deployed-env API image build
# (release-candidate.yml, ci.yml's api-image job, and operator-controlled
# per-SHA builds) BEFORE `docker build`: first install the pinned tools
# (scripts/install-agent-build-tools.sh zigbuild rsign) and `build`, both
# without the signing key, then `sign` in a step of its own that alone
# receives the key.
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
# WHY a separate signing mode: the build fetches and runs third-party tooling
# (cargo-zigbuild, zig, Bun, every crate build script). None of it may run
# while the key is in the environment or on disk, so `build` refuses a key,
# and `sign` runs only the pinned rsign over artifacts that are already built.
#
#   OPENGENI_AGENT_MINISIGN_KEY   the minisign secret key body (same key the
#                                 install scripts pin), for `sign` only; `build`
#                                 refuses to run with it set. When ABSENT, `sign`
#                                 exits non-zero unless OGE_BAKE_ALLOW_UNSIGNED=1
#                                 (so a key-less bake fails loud rather than
#                                 baking an unverifiable binary). An un-baked
#                                 asset just falls through to the GitHub-Releases
#                                 redirect at serve time.
#   OGE_BAKE_TARGETS              space-separated cargo target triples to bake.
#                                 Default: the two Linux musl triples install.sh
#                                 resolves for Linux x86_64/aarch64. `sign` must
#                                 get the same targets as `build`.
#   OGE_BAKE_ALLOW_UNSIGNED=1     let `sign` leave a checksum-only (unsigned) bake.
#   OPENGENI_RUNTIME_BUILD_ID     exact source commit, required for `build`.
#
# Mirrors agent-release.yml's coherent Linux build: glibc helpers embedded in a
# static musl parent via cargo-zigbuild, signed
# with rsign2 (pure-Rust minisign). Both tools are pure-Rust so the runner needs no
# system minisign / musl-gcc. Their exact versions live in
# scripts/install-agent-build-tools.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAKED_DIR="$REPO_ROOT/agent/install/baked"
AGENT_DIR="$REPO_ROOT/agent"
TOOLS="$REPO_ROOT/scripts/install-agent-build-tools.sh"
COMPONENTS="opengeni-agent opengeni-browserd opengeni-computer-native"

TARGETS="${OGE_BAKE_TARGETS:-x86_64-unknown-linux-musl aarch64-unknown-linux-musl}"
MODE="${1:-build}"

log() { printf '%s\n' "bake-agent: $*" >&2; }

sha256_of_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

check_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c --status "$1"
  else
    shasum -a 256 -c --status "$1"
  fi
}

# ---------------------------------------------------------------------------
# sign: sign the staged cohort with the pinned rsign, and run nothing else.
# ---------------------------------------------------------------------------
sign() {
  # Keep the key out of every child's environment; rsign reads it from a file
  # that exists only for the signing loop.
  local key="${OPENGENI_AGENT_MINISIGN_KEY:-}"
  unset OPENGENI_AGENT_MINISIGN_KEY
  if [ -z "$key" ]; then
    log "WARNING: OPENGENI_AGENT_MINISIGN_KEY is absent — binaries stay checksum-only (UNSIGNED)."
    if [ "${OGE_BAKE_ALLOW_UNSIGNED:-0}" != "1" ]; then
      log "ERROR: refusing to leave unsigned binaries. Set OPENGENI_AGENT_MINISIGN_KEY, or OGE_BAKE_ALLOW_UNSIGNED=1 to override."
      exit 1
    fi
    return
  fi
  "$TOOLS" --check rsign
  # Sign exactly the complete cohort `build` checksummed, nothing partial.
  for target in $TARGETS; do
    for component in $COMPONENTS; do
      asset="$component-$target"
      test -s "$BAKED_DIR/$asset" || { log "$asset was not built; run \`$0 build\` first"; exit 1; }
      ( cd "$BAKED_DIR" && check_sha256 "$asset.sha256" ) \
        || { log "$asset does not match its checksum"; exit 1; }
    done
  done
  STAGE_DIR="$(mktemp -d)"
  trap 'rm -rf "$STAGE_DIR"' EXIT
  KEY_FILE="$STAGE_DIR/signing-key"
  (umask 077 && printf '%s' "$key" > "$KEY_FILE")
  key=""
  for target in $TARGETS; do
    for component in $COMPONENTS; do
      asset="$component-$target"
      rsign sign -W -s "$KEY_FILE" -x "$STAGE_DIR/$asset.minisig" "$BAKED_DIR/$asset"
      test -s "$STAGE_DIR/$asset.minisig"
    done
  done
  rm -f "$KEY_FILE"
  # Signatures enter the image input directory only once every one exists.
  for target in $TARGETS; do
    for component in $COMPONENTS; do
      cp "$STAGE_DIR/$component-$target.minisig" "$BAKED_DIR/"
    done
  done
  log "signed into $BAKED_DIR:"
  ls -l "$BAKED_DIR" >&2
}

case "$MODE" in
  build) ;;
  sign)
    sign
    exit 0
    ;;
  *)
    log "usage: $0 [build|sign]"
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# build: compile and checksum every target, never with the key present.
# ---------------------------------------------------------------------------
if [ -n "${OPENGENI_AGENT_MINISIGN_KEY:-}" ]; then
  log "ERROR: OPENGENI_AGENT_MINISIGN_KEY must not be present while building; give it only to \`$0 sign\`."
  exit 1
fi

RUNTIME_BUILD_ID="${OPENGENI_RUNTIME_BUILD_ID:-}"

# A distributable canary is one exact-source runtime, never a development agent
# that discovers independently downloaded companions beside itself.
if [[ ! "$RUNTIME_BUILD_ID" =~ ^[a-f0-9]{40}$ ]] \
  || [ "$RUNTIME_BUILD_ID" != "$(git -C "$REPO_ROOT" rev-parse HEAD)" ]; then
  printf '%s\n' 'bake-agent: OPENGENI_RUNTIME_BUILD_ID must be the exact source commit' >&2
  exit 1
fi
export OPENGENI_RUNTIME_BUILD_ID="$RUNTIME_BUILD_ID"

mkdir -p "$BAKED_DIR"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

# --- Toolchain: cargo-zigbuild gives a robust static musl cross-link with no
# system musl-gcc (the agent-release.yml pattern). It needs BOTH its own binary
# AND a `zig` compiler (the `ziglang` wheel), which cache differently; the
# installer checks each exact version on its own, so a cached cargo-zigbuild
# can never mask a missing or different zig. Idempotent.
"$TOOLS" zigbuild

for target in $TARGETS; do
  case "$target" in
    x86_64-unknown-linux-musl) bun_target=bun-linux-x64 ;;
    aarch64-unknown-linux-musl) bun_target=bun-linux-arm64 ;;
    *) log "unsupported canary interaction target $target"; exit 1 ;;
  esac
  browserd="$STAGE_DIR/opengeni-browserd-$target"
  computer_native="$STAGE_DIR/opengeni-computer-native-$target"
  log "building the complete $target interaction runtime"
  (
    cd "$REPO_ROOT"
    # Helpers use host-native glibc; the parent agent remains portable musl.
    bun build --compile --target="$bun_target" packages/browserd/src/main.ts \
      --define "process.env.OPENGENI_RUNTIME_BUILD_ID=\"$RUNTIME_BUILD_ID\"" \
      --outfile "$browserd"
    # The compiled runtime carries Bun's own root list (see #5314).
    bun docker/distrust-embedded-roots.ts docker/distrusted-roots.pem "$browserd"
    bun docker/distrust-embedded-roots.ts --check docker/distrusted-roots.pem "$browserd"
  )
  test -s "$browserd"
  interp="$(readelf -l "$browserd" | sed -n 's/.*program interpreter: \(.*\)]/\1/p')"
  case "$target:$interp" in
    x86_64-unknown-linux-musl:/lib64/ld-linux-x86-64.so.2|aarch64-unknown-linux-musl:/lib/ld-linux-aarch64.so.1) ;;
    *) log "browserd must use the native glibc dynamic linker"; exit 1 ;;
  esac
  if readelf -d "$browserd" | grep -F 'libc.musl'; then
    log "browserd must not link musl libc"; exit 1
  fi
  # computer-native loads the session's libpipewire at runtime for GNOME
  # Wayland screen capture, which a static musl binary cannot do.
  native_target="${target%-musl}-gnu"
  (
    cd "$AGENT_DIR"
    rustup target add "$target" "$native_target"
    cargo zigbuild --locked --release --target "$native_target.2.28" -p opengeni-computer-native
  )
  cp "$AGENT_DIR/target/$native_target/release/opengeni-computer-native" "$computer_native"
  test -s "$computer_native"
  interp="$(readelf -l "$computer_native" | sed -n 's/.*program interpreter: \(.*\)]/\1/p')"
  case "$target:$interp" in
    x86_64-unknown-linux-musl:/lib64/ld-linux-x86-64.so.2|aarch64-unknown-linux-musl:/lib/ld-linux-aarch64.so.1) ;;
    *) log "computer-native must use the native glibc dynamic linker"; exit 1 ;;
  esac
  (
    cd "$AGENT_DIR"
    OPENGENI_EMBEDDED_BROWSERD="$browserd" \
    OPENGENI_EMBEDDED_COMPUTER_NATIVE="$computer_native" \
      cargo zigbuild --locked --release --target "$target" -p opengeni-agent
  )
  cp "$AGENT_DIR/target/$target/release/opengeni-agent" "$STAGE_DIR/opengeni-agent-$target"
  for component in $COMPONENTS; do
    asset="$component-$target"
    test -s "$STAGE_DIR/$asset"
    chmod 0755 "$STAGE_DIR/$asset"
    ( cd "$STAGE_DIR" && sha256_of_file "$asset" > "$asset.sha256" )
  done
done

# Nothing enters the image input directory until every requested target is
# built. A signature from an earlier bake never outlives its binary.
for target in $TARGETS; do
  for component in $COMPONENTS; do
    asset="$component-$target"
    rm -f "$BAKED_DIR/$asset.minisig"
    cp "$STAGE_DIR/$asset" "$STAGE_DIR/$asset.sha256" "$BAKED_DIR/"
  done
done

log "baked into $BAKED_DIR (unsigned until \`$0 sign\`):"
ls -l "$BAKED_DIR" >&2
