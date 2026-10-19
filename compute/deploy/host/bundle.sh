#!/usr/bin/env bash
# Builds the host agent's release bundle, a tarball that install.sh
# installs from:
#
#   VERSION=0.1.0 OUT=dist deploy/host/bundle.sh
#
# produces $OUT/compute-host-$VERSION-x86_64-linux.tar.gz and its .sha256.
# The bundle holds the agent as a static (musl) binary, the guest programs
# every sandbox image gets (guest/build.sh: compute-guest, envd, bash), the
# systemd units, install.sh, pins.env (Firecracker, jailer and the guest
# kernel, downloaded and checked at install) and SHA256SUMS of all of it.
# Builds are reproducible: the same commit and toolchain give the same
# bytes (paths remapped, archive entries sorted and dated from
# SOURCE_DATE_EPOCH, by default the commit's time). GUEST may name a
# directory guest/build.sh already filled, to reuse it. Linux only.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
compute=$(cd "$here/../.." && pwd)
VERSION=${VERSION:?set VERSION, such as 0.1.0 or the commit}
OUT=$(mkdir -p "${OUT:-$PWD/dist}" && cd "${OUT:-$PWD/dist}" && pwd)
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$compute" log -1 --format=%ct 2>/dev/null || echo 0)}
export SOURCE_DATE_EPOCH
log() { printf '[host-bundle %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

if command -v rustup >/dev/null &&
  ! rustup target list --installed | grep -qx x86_64-unknown-linux-musl; then
  rustup target add x86_64-unknown-linux-musl
fi
# musl-gcc compiles the crates' C; Rust links against its own bundled musl.
# The checkout, the cargo home and the target directory are wherever this
# machine keeps them, so their paths are mapped to fixed ones, in the Rust
# and in the C (debug lines and __FILE__ both).
target=$(mkdir -p "${CARGO_TARGET_DIR:-$compute/target}" && cd "${CARGO_TARGET_DIR:-$compute/target}" && pwd)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
export CC_x86_64_unknown_linux_musl=musl-gcc
export CFLAGS_x86_64_unknown_linux_musl="-ffile-prefix-map=$compute=/compute -ffile-prefix-map=$cargo_home=/cargo -ffile-prefix-map=$target=/target"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$compute=/compute --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$target=/target"
export CARGO_TARGET_DIR=$target

log "compute-host (musl, static)"
(cd "$compute" && cargo build --locked --release --target x86_64-unknown-linux-musl -p compute-host)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
name=compute-host-$VERSION-x86_64-linux
dir=$work/$name
mkdir -p "$dir/guest"
install -m 755 "$target/x86_64-unknown-linux-musl/release/compute-host" "$dir/compute-host"

if [ -n "${GUEST:-}" ]; then
  log "guest programs from $GUEST"
  cp -p "$GUEST/compute-guest" "$GUEST/envd" "$GUEST/bash" "$GUEST/VERSIONS" "$dir/guest/"
else
  log "guest programs"
  OUT=$dir/guest "$compute/guest/build.sh"
fi
chmod 755 "$dir/guest/compute-guest" "$dir/guest/envd" "$dir/guest/bash"
chmod 644 "$dir/guest/VERSIONS"

install -m 755 "$here/install.sh" "$here/check-host" "$here/host-setup" "$dir/"
install -m 644 "$here/pins.env" "$here/host.env.example" "$here/compute-host.service" \
  "$here/compute-guard.service" "$here/compute-host-setup.service" "$dir/"
echo "$VERSION" >"$dir/VERSION"
(cd "$dir" && find . -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs sha256sum >SHA256SUMS)

log "archive"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
  -C "$work" -cf - "$name" | gzip -n -9 >"$OUT/$name.tar.gz"
(cd "$OUT" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
cat "$OUT/$name.tar.gz.sha256"
