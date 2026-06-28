#!/usr/bin/env bash
#
# Cross-stack round-trip driver (the M0 acceptance, dossier V11).
#
# Sequences the two halves so BOTH fixtures exist for the bidirectional check:
#
#   1. Rust encodes the canonical corpus -> agent/tests/fixtures/rust_encoded.txt
#   2. The TS test encodes its corpus -> ts_encoded.txt, then decodes the Rust
#      fixture and asserts equality + byte-identity.
#   3. The Rust test decodes the TS fixture and asserts equality + byte-identity.
#
# A green run proves a Rust-encoded message decodes correctly in TS and a
# TS-encoded message decodes in Rust — the two generated stacks agree on the wire.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${AGENT_DIR}/.." && pwd)"
CARGO="${CARGO:-${HOME}/.cargo/bin/cargo}"

echo "==> [1/3] Rust: generate encoded fixtures"
( cd "${AGENT_DIR}" && "${CARGO}" run -q -p opengeni-agent-proto --example gen_fixtures --features test-corpus )

echo "==> [2/3] TypeScript: encode + decode-Rust + byte-equality"
( cd "${REPO_ROOT}" && bun test packages/agent-proto/test/roundtrip.test.ts )

echo "==> [3/3] Rust: decode-TS + byte-equality"
( cd "${AGENT_DIR}" && "${CARGO}" test -p opengeni-agent-proto )

echo "==> round-trip PASSED: Rust <-> TS wire stacks agree"
