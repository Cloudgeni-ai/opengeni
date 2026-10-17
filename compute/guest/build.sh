#!/usr/bin/env bash
# Builds the three programs every sandbox image gets, as static Linux
# binaries in one directory (OUT, default ./guest-out):
#
#   compute-guest  our init, PID 1 (this workspace, for musl)
#   envd           E2B's in-guest daemon, from a pinned commit of E2B's
#                  runtime (Apache-2.0)
#   bash           GNU bash, put at /bin/bash in images that have none
#                  (the E2B SDK runs commands and terminals with it)
#
# None of them is committed; images are built from this directory
# (`compute-host build-image --guest <OUT>`). Needs cargo with the
# x86_64-unknown-linux-musl target, musl-gcc, Go (the version envd's
# go.mod asks for), git and curl. ENVD_SRC may name a checkout of the
# runtime at the pinned commit to build from instead of fetching it.
set -euo pipefail

# envd: E2B's runtime at this commit answers the E2B JS SDK 2.56.0 (envd
# 0.10.0). Change both together, and the conformance suite with them.
ENVD_REPO=https://github.com/e2b-dev/runtime.git
ENVD_COMMIT=8dcde5b50ee73b56a412405163fca7b487aa2e5c
ENVD_VERSION=0.10.0

BASH_VERSION_PINNED=5.2.37
BASH_SHA256=9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff

here=$(cd "$(dirname "$0")" && pwd)
OUT=$(mkdir -p "${OUT:-$PWD/guest-out}" && cd "${OUT:-$PWD/guest-out}" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
log() { printf '[guest-build %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

log "compute-guest"
(cd "$here/.." && cargo build --release --target x86_64-unknown-linux-musl -p compute-guest)
target=${CARGO_TARGET_DIR:-$here/../target}
install -m 0755 "$target/x86_64-unknown-linux-musl/release/compute-guest" "$OUT/compute-guest"
strip "$OUT/compute-guest"

log "envd $ENVD_VERSION at ${ENVD_COMMIT:0:12}"
src=${ENVD_SRC:-}
if [ -z "$src" ]; then
  src=$work/runtime
  git init -q "$src"
  git -C "$src" fetch -q --depth 1 "$ENVD_REPO" "$ENVD_COMMIT"
  git -C "$src" checkout -q FETCH_HEAD
fi
if [ -d "$src/.git" ] && [ "$(git -C "$src" rev-parse HEAD)" != "$ENVD_COMMIT" ]; then
  echo "ENVD_SRC is not at $ENVD_COMMIT" >&2
  exit 1
fi
(cd "$src/packages/envd" && CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -buildid= -X=main.commitSHA=${ENVD_COMMIT:0:7}" -o "$OUT/envd" .)
version=$("$OUT/envd" -version)
if [ "$version" != "$ENVD_VERSION" ]; then
  echo "envd says it is $version, not $ENVD_VERSION" >&2
  exit 1
fi

log "bash $BASH_VERSION_PINNED"
curl -fsSL -o "$work/bash.tar.gz" "https://ftp.gnu.org/gnu/bash/bash-$BASH_VERSION_PINNED.tar.gz"
echo "$BASH_SHA256  $work/bash.tar.gz" | sha256sum -c --quiet
tar -xzf "$work/bash.tar.gz" -C "$work"
(cd "$work/bash-$BASH_VERSION_PINNED" &&
  CC=musl-gcc CFLAGS="-Os" ./configure -q --enable-static-link --without-bash-malloc \
    --disable-nls >/dev/null &&
  make -s -j"$(nproc)" >/dev/null 2>&1)
install -m 0755 "$work/bash-$BASH_VERSION_PINNED/bash" "$OUT/bash"
strip "$OUT/bash"

printf 'envd %s %s\nbash %s\n' "$ENVD_VERSION" "$ENVD_COMMIT" "$BASH_VERSION_PINNED" >"$OUT/VERSIONS"
ls -l "$OUT"
log "done"
