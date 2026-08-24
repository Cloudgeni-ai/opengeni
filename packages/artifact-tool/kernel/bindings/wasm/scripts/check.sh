#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
crate_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../../../../../.." && pwd)
rust_runner="$repository_root/scripts/artifact-kernel-rust.ts"

"$script_dir/toolchain.sh"

bun "$rust_runner" ensure --target wasm32-unknown-unknown --component rustfmt --component clippy
bun "$rust_runner" cargo fmt --manifest-path "$crate_dir/Cargo.toml" --check
bun "$rust_runner" cargo test --locked --manifest-path "$crate_dir/Cargo.toml"
bun "$rust_runner" cargo clippy --locked --manifest-path "$crate_dir/Cargo.toml" --all-targets -- -D warnings
bun "$rust_runner" cargo check --locked --manifest-path "$crate_dir/Cargo.toml" --target wasm32-unknown-unknown
