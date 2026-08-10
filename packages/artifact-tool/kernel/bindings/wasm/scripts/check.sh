#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
crate_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

"$script_dir/toolchain.sh"

if ! cargo fmt --version >/dev/null 2>&1; then
  echo "error: rustfmt is required; install it with rustup component add rustfmt" >&2
  exit 1
fi

if ! cargo clippy --version >/dev/null 2>&1; then
  echo "error: Clippy is required; install it with rustup component add clippy" >&2
  exit 1
fi

cargo fmt --manifest-path "$crate_dir/Cargo.toml" --check
cargo test --locked --manifest-path "$crate_dir/Cargo.toml"
cargo clippy --locked --manifest-path "$crate_dir/Cargo.toml" --all-targets -- -D warnings
cargo check --locked --manifest-path "$crate_dir/Cargo.toml" --target wasm32-unknown-unknown
