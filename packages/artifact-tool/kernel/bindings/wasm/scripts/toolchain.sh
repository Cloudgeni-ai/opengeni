#!/bin/sh

set -eu

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is required" >&2
  exit 1
fi

if ! command -v rustc >/dev/null 2>&1; then
  echo "error: rustc is required" >&2
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "error: rustup is required to verify the wasm32-unknown-unknown target" >&2
  exit 1
fi

if ! rustup target list --installed | grep -qx 'wasm32-unknown-unknown'; then
  echo "error: missing Rust target wasm32-unknown-unknown" >&2
  echo "install it explicitly with: rustup target add wasm32-unknown-unknown" >&2
  exit 1
fi
