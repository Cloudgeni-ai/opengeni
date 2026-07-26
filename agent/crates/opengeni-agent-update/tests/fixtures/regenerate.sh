#!/bin/sh
# shellcheck shell=sh
#
# Regenerate the self-update FLOW test fixtures with a THROWAWAY test key.
# Requires the `minisign` binary (on NixOS: nix run nixpkgs#minisign -- ...).
#
#   sh tests/fixtures/regenerate.sh
#
# Produces under tests/fixtures/:
#   test-key.pub                              the throwaway public key (committed)
#   release/agent/stable/manifest.json[.minisig]
#   release/agent/stable/agent-v1.0.1[.minisig]
#
# The fixtures are committed so CI needs no signing tool; rerun this only when the
# fixture shape changes. NEVER use the production release key here.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
MINISIGN="${MINISIGN:-minisign}"
command -v "$MINISIGN" >/dev/null 2>&1 || { echo "minisign not on PATH" >&2; exit 1; }

REL="$HERE/release/agent/stable"
mkdir -p "$REL"
KEYDIR="$(mktemp -d)"
trap 'rm -rf "$KEYDIR"' EXIT

"$MINISIGN" -G -W -p "$KEYDIR/test.pub" -s "$KEYDIR/test.key" >/dev/null 2>&1
cp "$KEYDIR/test.pub" "$HERE/test-key.pub"

printf 'opengeni-agent v1.0.1 fixture artifact body\n' > "$REL/agent-v1.0.1"
"$MINISIGN" -S -W -s "$KEYDIR/test.key" -m "$REL/agent-v1.0.1" >/dev/null 2>&1

SHA="$(sha256sum "$REL/agent-v1.0.1" | cut -d' ' -f1)"
SIZE="$(wc -c < "$REL/agent-v1.0.1")"
cat > "$REL/manifest.json" <<EOF
{
  "channel": "stable",
  "version": "1.0.1",
  "min_supported": "1.0.0",
  "rollout_percent": 100,
  "cohort_salt": "fixture",
  "artifacts": [
    {"target":"x86_64-unknown-linux-musl","url":"agent/stable/agent-v1.0.1","size":$SIZE,"sha256":"$SHA","minisig_url":"agent/stable/agent-v1.0.1.minisig"}
  ],
  "notes_url":"https://x/notes",
  "signed_at_ms": 1700000000000,
  "force": false
}
EOF
"$MINISIGN" -S -W -s "$KEYDIR/test.key" -m "$REL/manifest.json" >/dev/null 2>&1

echo "regenerated fixtures under $HERE"
