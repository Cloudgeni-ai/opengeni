#!/usr/bin/env bash
#
# Generate the TypeScript wire-protocol types from the single source of truth
# (agent/proto/opengeni_agent.proto) using ts-proto.
#
# This is the TS half of the "never drift" guarantee: the SAME .proto drives both
# the Rust (prost) types and these TS types. Run `agent/scripts/codegen.sh` to
# regenerate BOTH at once.
#
# protoc is resolved from nixpkgs so this is reproducible on NixOS (where a
# downloaded protoc would not run). Set PROTOC to override.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${PKG_DIR}/../.." && pwd)"
PROTO_DIR="${REPO_ROOT}/agent/proto"
OUT_DIR="${PKG_DIR}/src/gen"
PLUGIN="${PKG_DIR}/node_modules/.bin/protoc-gen-ts_proto"

if [[ ! -x "${PLUGIN}" ]]; then
  echo "error: ts-proto plugin not found at ${PLUGIN} — run 'bun install' first" >&2
  exit 1
fi

# Resolve protoc: prefer an explicit PROTOC, else a protoc on PATH, else nixpkgs.
if [[ -n "${PROTOC:-}" ]]; then
  PROTOC_BIN="${PROTOC}"
elif command -v protoc >/dev/null 2>&1; then
  PROTOC_BIN="$(command -v protoc)"
elif command -v nix >/dev/null 2>&1; then
  echo "resolving protoc via nixpkgs#protobuf ..." >&2
  PROTOC_STORE="$(nix build nixpkgs#protobuf --no-link --print-out-paths)"
  PROTOC_BIN="${PROTOC_STORE}/bin/protoc"
else
  echo "error: no protoc found (set PROTOC, install protoc, or provide nix)" >&2
  exit 1
fi

echo "using protoc: ${PROTOC_BIN}" >&2
mkdir -p "${OUT_DIR}"
# Clean stale generated files so a removed message can't linger.
rm -f "${OUT_DIR}"/*.ts

"${PROTOC_BIN}" \
  --plugin="protoc-gen-ts_proto=${PLUGIN}" \
  --ts_proto_out="${OUT_DIR}" \
  --ts_proto_opt=esModuleInterop=true \
  --ts_proto_opt=forceLong=string \
  --ts_proto_opt=useOptionals=none \
  --ts_proto_opt=oneof=unions \
  --ts_proto_opt=outputIndex=false \
  --ts_proto_opt=snakeToCamel=true \
  --ts_proto_opt=unrecognizedEnum=false \
  --proto_path="${PROTO_DIR}" \
  "${PROTO_DIR}/opengeni_agent.proto"

echo "generated TS types into ${OUT_DIR}" >&2
ls -1 "${OUT_DIR}"
