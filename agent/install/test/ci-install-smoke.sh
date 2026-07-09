#!/usr/bin/env bash
# CI install-smoke (Unix): prove install.sh PARSES + VERIFIES + INSTALLS the
# freshly-built binary, against a locally-signed mock release. Used by agent-ci.yml
# on ubuntu-latest + macos-26 (dossier §23.3). Requires `minisign` on PATH.
#
# It generates a THROWAWAY minisign key, signs the just-built binary, builds a mock
# release tree, embeds the throwaway pubkey into a COPY of install.sh (so the
# pinned-key verify path is exercised end-to-end without the production key), and
# runs the real script with OPENGENI_INSTALL_BASE_URL at the mock dir.
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$AGENT_DIR"

# sha256 of $1 (sha256sum, else shasum), written to stdout as the "<hash>  <name>"
# line install.sh expects.
sha256_line() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

# Resolve the built binary + the asset name install.sh expects for this host.
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux)  case "$arch" in x86_64|amd64) asset="opengeni-agent-x86_64-unknown-linux-musl";; aarch64|arm64) asset="opengeni-agent-aarch64-unknown-linux-musl";; esac ;;
  Darwin) asset="opengeni-agent-universal-apple-darwin" ;;
  *) echo "unsupported OS $os" >&2; exit 1 ;;
esac
built="target/release/opengeni-agent"
[ -x "$built" ] || { echo "built binary not found at $built" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mock="$work/mock/agent/latest"
mkdir -p "$mock"
cp "$built" "$mock/$asset"

# Throwaway key + sign + checksum.
minisign -G -W -p "$work/k.pub" -s "$work/k.key" >/dev/null 2>&1
minisign -S -W -s "$work/k.key" -m "$mock/$asset" >/dev/null 2>&1
( cd "$mock" && sha256_line "$asset" > "$asset.sha256" )

# A copy of install.sh with the throwaway pubkey pinned in place of the real one.
pub="$(sed -n '2p' "$work/k.pub")"
sed "s#^OPENGENI_MINISIGN_PUBKEY=.*#OPENGENI_MINISIGN_PUBKEY='$pub'#" install/install.sh > "$work/install.sh"

# Run the REAL (key-swapped) install in CI mode.
OPENGENI_INSTALL_BASE_URL="file://$work/mock" \
OPENGENI_INSTALL_DIR="$work/bin" \
OPENGENI_NO_RUN=1 \
  sh "$work/install.sh" </dev/null

# Assert it installed. Linux copies the verified bytes unchanged. On macOS the
# installer intentionally wraps the verified binary in an app bundle and signs
# that staged bundle (ad-hoc when no Developer ID is available), so Mach-O bytes
# must change. Requiring `cmp` there made every macOS smoke fail after a correct
# install; verify the installed bundle's signature and exact binary identity
# instead.
test -x "$work/bin/opengeni-agent"
if [ "$os" = "Darwin" ]; then
  app="$HOME/Applications/OpenGeni Agent.app"
  test -d "$app"
  codesign --verify --strict "$app"
  want_version="$("$built" --version)"
  got_version="$("$work/bin/opengeni-agent" --version)"
  [ "$got_version" = "$want_version" ] || {
    echo "installed binary version differs: got '$got_version', expected '$want_version'" >&2
    exit 1
  }
else
  cmp "$work/bin/opengeni-agent" "$built"
fi
echo "install-smoke OK: verified + installed $asset"

# A tampered artifact MUST be rejected (exit 5).
echo TAMPER >> "$mock/$asset"
( cd "$mock" && sha256_line "$asset" > "$asset.sha256" )
set +e
OPENGENI_INSTALL_BASE_URL="file://$work/mock" OPENGENI_INSTALL_DIR="$work/bin2" OPENGENI_NO_RUN=1 sh "$work/install.sh" </dev/null
rc=$?
set -e
[ "$rc" -eq 5 ] || { echo "tampered artifact NOT rejected (rc=$rc, expected 5)" >&2; exit 1; }
echo "install-smoke OK: tampered artifact rejected (rc=5)"
