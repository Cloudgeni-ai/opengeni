#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
crate_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
bindgen_target=${1:-web}
output_dir=${2:-"$crate_dir/dist"}
profile=${3:-full}

case "$bindgen_target" in
  web) ;;
  *)
    echo "error: only the production-verified wasm-bindgen web target is supported" >&2
    exit 1
    ;;
esac

case "$profile" in
  full)
    cargo_features=""
    output_name=artifact_kernel
    ;;
  spreadsheet|document|presentation)
    cargo_features=$profile
    output_name="artifact_kernel_$profile"
    ;;
  *)
    echo "error: unsupported WebAssembly profile: $profile" >&2
    exit 1
    ;;
esac

"$script_dir/toolchain.sh"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "error: wasm-bindgen CLI is required to generate JavaScript glue" >&2
  echo "install the Cargo.lock-matched version with cargo install --locked wasm-bindgen-cli --version <version>" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: Bun is required for the generated WebAssembly ABI smoke test" >&2
  exit 1
fi

crate_bindgen_version=$(cargo tree \
  --locked \
  --manifest-path "$crate_dir/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --invert wasm-bindgen \
  --depth 0 \
  --prefix none | sed -n 's/^wasm-bindgen v//p')
cli_bindgen_version=$(wasm-bindgen --version | sed -n 's/^wasm-bindgen //p')

if [ -z "$crate_bindgen_version" ] || [ -z "$cli_bindgen_version" ]; then
  echo "error: could not determine wasm-bindgen crate/CLI versions" >&2
  exit 1
fi

if [ "$crate_bindgen_version" != "$cli_bindgen_version" ]; then
  echo "error: wasm-bindgen CLI $cli_bindgen_version does not match crate $crate_bindgen_version" >&2
  echo "install the matching CLI with: cargo install --locked wasm-bindgen-cli --version $crate_bindgen_version" >&2
  exit 1
fi

if [ -n "$cargo_features" ]; then
  cargo build \
    --locked \
    --manifest-path "$crate_dir/Cargo.toml" \
    --release \
    --target wasm32-unknown-unknown \
    --no-default-features \
    --features "$cargo_features"
else
  cargo build \
    --locked \
    --manifest-path "$crate_dir/Cargo.toml" \
    --release \
    --target wasm32-unknown-unknown
fi

wasm_path="$crate_dir/target/wasm32-unknown-unknown/release/opengeni_artifact_kernel_wasm.wasm"

if [ ! -f "$wasm_path" ]; then
  echo "error: expected WebAssembly output was not produced: $wasm_path" >&2
  exit 1
fi

mkdir -p "$output_dir"
wasm-bindgen \
  "$wasm_path" \
  --out-dir "$output_dir" \
  --out-name "$output_name" \
  --target "$bindgen_target" \
  --typescript

if [ "$profile" = full ]; then
  bun run "$script_dir/smoke.ts" "$output_dir"
else
  bun run "$script_dir/smoke-modality.ts" "$output_dir" "$profile"
fi
