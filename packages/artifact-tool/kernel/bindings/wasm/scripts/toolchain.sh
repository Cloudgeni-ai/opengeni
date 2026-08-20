#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../../../../../.." && pwd)
bun "$repository_root/scripts/artifact-kernel-rust.ts" ensure --target wasm32-unknown-unknown
