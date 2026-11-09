#!/usr/bin/env bash
# Builds the static musl jq executables Opengeni ships for Linux.
#
# jq's own Linux release executables statically link glibc, so Opengeni builds
# jq itself: the checksum-pinned jq source release, with its bundled Oniguruma,
# linked statically against the musl libc of a checksum-pinned zig toolchain.
# The inputs are pinned and zig is hermetic, so every run on an x86_64 Linux
# host gives the same bytes; anyone can rebuild them and compare the result
# with the pins in packages/runtime/src/sandbox/shell-tools-manifest.ts.
#
#   scripts/build-static-jq.sh <out-dir>
#   scripts/build-static-jq.sh --check
#
# Writes <out-dir>/jq-<version>-<arch>-linux-musl for x86_64 and aarch64.
# `--check` builds into a temporary directory instead and fails unless both
# executables equal the committed ones in agent/vendor/jq/. Needs
# bash, curl, tar, xz, make and sha256sum. OPENGENI_SHELL_TOOLS_CACHE, when
# set, is a directory of downloads keyed by SHA-256 (as for
# scripts/fetch-shell-tools.ts).
set -euo pipefail

JQ_VERSION=1.8.2
JQ_SOURCE_URL="https://github.com/jqlang/jq/releases/download/jq-$JQ_VERSION/jq-$JQ_VERSION.tar.gz"
JQ_SOURCE_SHA256=71b8d6e8f5fe81f6c6d0d110e3892251f6ce76ed095abd315e26e6e1193af3af
ZIG_VERSION=0.16.0
ZIG_URL="https://ziglang.org/download/$ZIG_VERSION/zig-x86_64-linux-$ZIG_VERSION.tar.xz"
ZIG_SHA256=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
ARCHES="x86_64 aarch64"

log() { printf 'build-static-jq: %s\n' "$*" >&2; }

if [ "$#" -ne 1 ]; then
  log "usage: $0 <out-dir>"
  exit 2
fi
if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  # jq records its configure arguments (`jq --build-configuration`), which
  # name the build machine, so one host type keeps the output identical.
  log "run this on an x86_64 Linux host (for example a linux/amd64 container)"
  exit 2
fi
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
if [ "$1" = --check ]; then
  VENDOR_DIR="$(cd "$(dirname "$0")/../agent/vendor/jq" && pwd)"
  OUT_DIR="$WORK_DIR/out"
  mkdir "$OUT_DIR"
else
  VENDOR_DIR=""
  mkdir -p "$1"
  OUT_DIR="$(cd "$1" && pwd)"
fi

# fetch <url> <sha256> <file>: a verified download, reused from the cache.
fetch() {
  local cached=""
  if [ -n "${OPENGENI_SHELL_TOOLS_CACHE:-}" ]; then
    cached="$OPENGENI_SHELL_TOOLS_CACHE/$2"
    if [ -f "$cached" ] && printf '%s  %s\n' "$2" "$cached" | sha256sum -c --status; then
      cp "$cached" "$3"
      return
    fi
  fi
  curl -fsSL --retry 3 -o "$3" "$1"
  if ! printf '%s  %s\n' "$2" "$3" | sha256sum -c --status; then
    log "$1 does not match its pinned SHA-256"
    exit 1
  fi
  if [ -n "$cached" ]; then
    mkdir -p "$OPENGENI_SHELL_TOOLS_CACHE"
    cp "$3" "$cached"
  fi
}

fetch "$ZIG_URL" "$ZIG_SHA256" "$WORK_DIR/zig.tar.xz"
fetch "$JQ_SOURCE_URL" "$JQ_SOURCE_SHA256" "$WORK_DIR/jq.tar.gz"
mkdir "$WORK_DIR/zig"
tar -xJf "$WORK_DIR/zig.tar.xz" -C "$WORK_DIR/zig" --strip-components=1
export PATH="$WORK_DIR/zig:$PATH"
export ZIG_GLOBAL_CACHE_DIR="$WORK_DIR/zig-cache" ZIG_LOCAL_CACHE_DIR="$WORK_DIR/zig-cache"
export SOURCE_DATE_EPOCH=0 LC_ALL=C TZ=UTC

for arch in $ARCHES; do
  log "building jq $JQ_VERSION for $arch-linux-musl"
  # A fresh source tree for each architecture.
  rm -rf "$WORK_DIR/src"
  mkdir "$WORK_DIR/src"
  tar -xzf "$WORK_DIR/jq.tar.gz" -C "$WORK_DIR/src"
  (
    cd "$WORK_DIR/src/jq-$JQ_VERSION"
    # A fixed --build keeps configure in cross mode (it never runs what it
    # builds), and optimising also turns off zig's trapping UB sanitiser.
    ./configure \
      --build=x86_64-pc-linux-gnu --host="$arch-linux-musl" \
      CC="zig cc -target $arch-linux-musl" AR="zig ar" RANLIB="zig ranlib" LD="zig ld.lld" \
      CFLAGS="-O2 -g0" LDFLAGS="-s" \
      --with-oniguruma=builtin --enable-static --enable-all-static \
      --disable-shared --disable-docs --disable-valgrind \
      --disable-maintainer-mode --disable-dependency-tracking >/dev/null
    make -j"$(nproc)" >/dev/null
  )
  cp "$WORK_DIR/src/jq-$JQ_VERSION/jq" "$OUT_DIR/jq-$JQ_VERSION-$arch-linux-musl"
done

( cd "$OUT_DIR" && sha256sum jq-"$JQ_VERSION"-*-linux-musl )
if [ -n "$VENDOR_DIR" ]; then
  for arch in $ARCHES; do
    name="jq-$JQ_VERSION-$arch-linux-musl"
    if ! cmp -s "$OUT_DIR/$name" "$VENDOR_DIR/$name"; then
      log "$name differs from agent/vendor/jq/$name"
      exit 1
    fi
  done
  log "the committed executables are exactly what this script builds"
fi
