#!/usr/bin/env bash
#
# THE single "regenerate the wire protocol everywhere" command.
#
# The wire protocol is defined ONCE in agent/proto/opengeni_agent.proto and
# code-generated to BOTH stacks so the control plane (TypeScript) and the agent
# (Rust) can never drift:
#
#   * Rust: `opengeni-agent-proto`'s build.rs compiles the proto via prost+protox
#     on every `cargo build`. We force a rebuild here so a stale target/ can't
#     hide drift.
#   * TypeScript: ts-proto generates `packages/agent-proto/src/gen/`.
#
# Run this after any edit to opengeni_agent.proto. CI re-runs it and fails if the
# working tree changed (i.e. someone edited generated code by hand or forgot to
# regenerate). protoc is resolved from nixpkgs for reproducibility on NixOS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${AGENT_DIR}/.." && pwd)"
CARGO="${CARGO:-${HOME}/.cargo/bin/cargo}"

echo "==> Rust codegen (prost via build.rs)"
# Touch the proto so build.rs's rerun-if-changed fires, then build the proto crate.
touch "${AGENT_DIR}/proto/opengeni_agent.proto"
( cd "${AGENT_DIR}" && "${CARGO}" build -p opengeni-agent-proto )

echo "==> TypeScript codegen (ts-proto)"
bash "${REPO_ROOT}/packages/agent-proto/scripts/codegen.sh"

echo "==> codegen complete (Rust + TypeScript regenerated from opengeni_agent.proto)"
