#!/bin/sh
# shellcheck shell=sh
#
# minisign sign -> install-script verify FLOW test (dossier §17/§24, M11 gate).
#
# Proves end-to-end that:
#   1. an artifact signed with the release PRIVATE key is ACCEPTED by install.sh's
#      verify (both the minisign-binary path and, when openssl is present, the
#      pure-openssl ed25519 fallback);
#   2. a TAMPERED artifact (one byte flipped) is REJECTED (signature failure);
#   3. a TAMPERED checksum is REJECTED (checksum failure).
#
# It drives the REAL install.sh against a local mock release dir via the
# OPENGENI_INSTALL_BASE_URL override, so it exercises the exact code a user runs.
#
# Usage:  PRIV=.agent/secrets/agent-minisign.key sh agent/install/test/sign-verify-flow.sh
# Requires `minisign` (and optionally `openssl`) on PATH. On NixOS run it under:
#   nix shell nixpkgs#minisign nixpkgs#openssl -c sh agent/install/test/sign-verify-flow.sh
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
INSTALL_SH="$REPO_ROOT/agent/install/install.sh"
PRIV="${PRIV:-$REPO_ROOT/.agent/secrets/agent-minisign.key}"
ASSET="opengeni-agent-x86_64-unknown-linux-musl"

command -v minisign >/dev/null 2>&1 || { echo "FLOW: minisign not on PATH" >&2; exit 6; }
[ -f "$PRIV" ] || { echo "FLOW: private key not found at $PRIV" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

MOCK="$WORK/mock/agent/latest"
mkdir -p "$MOCK"

# A throwaway "binary".
printf 'opengeni-agent test artifact %s\n' "$(date +%s%N)" > "$MOCK/$ASSET"
# Sign it with the release private key (minisign default = prehashed ED).
minisign -S -W -s "$PRIV" -m "$MOCK/$ASSET" >/dev/null 2>&1
# Emit the checksum the installer expects.
( cd "$MOCK" && sha256sum "$ASSET" > "$ASSET.sha256" )

run_install() {
  # $1 = a label, rest = env overrides applied; returns the install RC.
  _dest="$WORK/dest-$1"; rm -rf "$_dest"
  OPENGENI_INSTALL_BASE_URL="file://$WORK/mock" \
  OPENGENI_INSTALL_DIR="$_dest" \
  OPENGENI_NO_RUN=1 \
    sh "$INSTALL_SH" </dev/null >"$WORK/log-$1" 2>&1
}

PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "FLOW 1: a validly-signed artifact is ACCEPTED"
if run_install accept; then
  if cmp -s "$WORK/dest-accept/opengeni-agent" "$MOCK/$ASSET"; then
    ok "valid artifact installed, bytes identical"
  else
    bad "installed bytes differ from source"
  fi
else
  bad "valid artifact was rejected (rc=$?); log:"; cat "$WORK/log-accept"
fi

echo "FLOW 2: a TAMPERED artifact is REJECTED (signature gate)"
# Flip the artifact AFTER signing; keep the (now-stale) sig, refresh the checksum
# so we isolate the SIGNATURE failure (not a checksum failure).
printf 'TAMPERED\n' >> "$MOCK/$ASSET"
( cd "$MOCK" && sha256sum "$ASSET" > "$ASSET.sha256" )
if run_install tamper; then
  bad "tampered artifact was ACCEPTED — verify is broken!"
else
  rc=$?
  if [ "$rc" -eq 5 ]; then ok "tampered artifact rejected with the signature exit code (5)"
  else bad "tampered artifact rejected but with rc=$rc (expected 5)"; cat "$WORK/log-tamper"; fi
fi

echo "FLOW 3: a TAMPERED checksum is REJECTED (checksum gate)"
# Re-sign a clean artifact, then corrupt only the checksum file.
printf 'clean again %s\n' "$(date +%s%N)" > "$MOCK/$ASSET"
minisign -S -W -s "$PRIV" -m "$MOCK/$ASSET" >/dev/null 2>&1
printf '%s  %s\n' "deadbeef$(printf '0%.0s' $(seq 1 56))" "$ASSET" > "$MOCK/$ASSET.sha256"
if run_install cksum; then
  bad "bad-checksum artifact was ACCEPTED — checksum gate is broken!"
else
  rc=$?
  if [ "$rc" -eq 4 ]; then ok "bad checksum rejected with the checksum exit code (4)"
  else bad "bad checksum rejected but with rc=$rc (expected 4)"; cat "$WORK/log-cksum"; fi
fi

echo ""
echo "FLOW RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
