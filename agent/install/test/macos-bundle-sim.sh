#!/bin/sh
# shellcheck shell=sh
#
# macOS app-bundle assembly SIMULATION (dossier §23; the REPLACE_APP incident).
#
# install.sh's darwin bundle path signs + verifies + atomically installs an app
# bundle around the verified binary. This test SOURCES install.sh as a library
# (OPENGENI_INSTALL_LIB=1, which skips `main`) and drives the bundle helpers with
# MOCKED codesign / security / xattr on PATH, so the darwin-only logic is exercised
# on any host (Linux CI included) with no real signing or network.
#
# It proves:
#   1. a "Developer ID Application" identity present  -> signed with it
#      (`codesign --sign <hash>`, log "signed with Developer ID …");
#   2. no Developer ID identity                       -> ad-hoc signed
#      (`codesign --sign -`, log "ad-hoc signed (no Developer ID identity found)");
#   3. several Developer ID identities                -> the FIRST is chosen
#      (deterministic) and logged;
#   4. an atomic-swap FAILURE                         -> the previous bundle is
#      restored from its .bak and the installer dies loudly (rc 2).
#
# Usage:  sh agent/install/test/macos-bundle-sim.sh
set -eu

WORK="$(mktemp -d)"
BIN="$WORK/bin"
mkdir -p "$BIN"

# --- Mock external macOS tools on PATH --------------------------------------
# security: emit the identity list from $MOCK_SECURITY_FILE (empty list if unset).
cat > "$BIN/security" <<'SH'
#!/bin/sh
# Only `find-identity -v -p codesigning` is used by install.sh.
if [ -n "${MOCK_SECURITY_FILE:-}" ] && [ -f "$MOCK_SECURITY_FILE" ]; then
  cat "$MOCK_SECURITY_FILE"
else
  echo "     0 valid identities found"
fi
SH

# codesign: record each invocation to $MOCK_CODESIGN_LOG; honor the -dv / --verify /
# sign forms. `codesign -dv <app>` (bundle-signed probe) returns 1 (not signed).
cat > "$BIN/codesign" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "${MOCK_CODESIGN_LOG:-/dev/null}"
case " $* " in
  *" -dv "*|*" -d "*) echo "no signature" >&2; exit 1 ;;
  *" --verify "*) [ "${MOCK_CODESIGN_VERIFY_FAIL:-0}" = "1" ] && exit 1; exit 0 ;;
  *) [ "${MOCK_CODESIGN_SIGN_FAIL:-0}" = "1" ] && exit 1; exit 0 ;;
esac
SH

# xattr: record + succeed (the real one strips extended attributes).
cat > "$BIN/xattr" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "${MOCK_XATTR_LOG:-/dev/null}"
exit 0
SH

chmod 0755 "$BIN/security" "$BIN/codesign" "$BIN/xattr"
PATH="$BIN:$PATH"; export PATH

# --- Load install.sh as a library (skips main) ------------------------------
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# Pin a version so resolve_app_version never execs the (fake) binary.
OPENGENI_AGENT_VERSION="9.9.9"; export OPENGENI_AGENT_VERSION
# shellcheck source=/dev/null  # dynamic path; install.sh is loaded as a library here
OPENGENI_INSTALL_LIB=1 . "$REPO_ROOT/agent/install/install.sh"
set +e   # sourcing turned on `set -e`; drive assertions manually + trap `die` in subshells.

# Our own cleanup (replaces install.sh's EXIT trap, which targets its own TMPDIR_OG).
trap 'rm -rf "$WORK"' EXIT INT TERM

# Give the sourced helpers a scratch dir to stage bundles in.
TMPDIR_OG="$WORK/og-tmp"; mkdir -p "$TMPDIR_OG"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# A throwaway "verified binary".
FAKE_BIN="$WORK/opengeni-agent-universal-apple-darwin"
printf 'fake mach-o\n' > "$FAKE_BIN"

# Run install_macos_local_bundle in an isolated HOME, capturing its logs.
# $1=label (unique HOME + log), rest handled by env the caller already set.
run_local_install() {
  _home="$WORK/home-$1"; rm -rf "$_home"; mkdir -p "$_home"
  MOCK_CODESIGN_LOG="$WORK/codesign-$1.log"; : > "$MOCK_CODESIGN_LOG"
  export MOCK_CODESIGN_LOG
  HOME="$_home" install_macos_local_bundle "$FAKE_BIN" "$_home/bin" \
    >"$WORK/out-$1" 2>"$WORK/log-$1"
}

echo "SIM 1: a Developer ID Application identity is present -> signed with it"
DEVID_HASH="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
printf '  1) %s "Developer ID Application: Jorgen (TEAM123)"\n     1 valid identities found\n' \
  "$DEVID_HASH" > "$WORK/sec-one"
MOCK_SECURITY_FILE="$WORK/sec-one" run_local_install one
if grep -q -- "--sign $DEVID_HASH" "$WORK/codesign-one.log"; then
  ok "codesign invoked with the Developer ID hash"
else
  bad "codesign was NOT invoked with the Developer ID hash"; cat "$WORK/codesign-one.log"
fi
if grep -q 'signed with Developer ID "Developer ID Application: Jorgen (TEAM123)"' "$WORK/log-one"; then
  ok "logged the Developer ID signing line"
else
  bad "missing the Developer ID signing log line"; cat "$WORK/log-one"
fi
if [ -d "$WORK/home-one/Applications/OpenGeni Agent.app" ]; then
  ok "bundle installed under \$HOME/Applications"
else
  bad "bundle not installed"; ls -la "$WORK/home-one/Applications" 2>&1
fi

echo "SIM 2: NO Developer ID identity -> ad-hoc signed"
MOCK_SECURITY_FILE="" run_local_install adhoc
if grep -q -- "--sign - " "$WORK/codesign-adhoc.log" || grep -q -- "--sign -$" "$WORK/codesign-adhoc.log"; then
  ok "codesign invoked ad-hoc (--sign -)"
else
  bad "codesign was NOT invoked ad-hoc"; cat "$WORK/codesign-adhoc.log"
fi
if grep -q 'ad-hoc signed (no Developer ID identity found)' "$WORK/log-adhoc"; then
  ok "logged the ad-hoc fallback line"
else
  bad "missing the ad-hoc fallback log line"; cat "$WORK/log-adhoc"
fi

echo "SIM 3: several Developer ID identities -> the FIRST is chosen deterministically"
FIRST_HASH="1111111111111111111111111111111111111111"
SECOND_HASH="2222222222222222222222222222222222222222"
{
  printf '  1) %s "Developer ID Application: First (TEAMAAA)"\n' "$FIRST_HASH"
  printf '  2) %s "Developer ID Application: Second (TEAMBBB)"\n' "$SECOND_HASH"
  printf '     2 valid identities found\n'
} > "$WORK/sec-many"
MOCK_SECURITY_FILE="$WORK/sec-many" run_local_install many
if grep -q -- "--sign $FIRST_HASH" "$WORK/codesign-many.log" \
   && ! grep -q -- "--sign $SECOND_HASH" "$WORK/codesign-many.log"; then
  ok "signed with the FIRST identity, not the second"
else
  bad "did not deterministically pick the first identity"; cat "$WORK/codesign-many.log"
fi
if grep -q 'found 2 Developer ID Application identities; deterministically using the first' "$WORK/log-many"; then
  ok "logged the multi-identity disambiguation"
else
  bad "missing the multi-identity log line"; cat "$WORK/log-many"
fi

echo "SIM 4: an atomic-swap failure restores the previous bundle (.bak) and dies (rc 2)"
DST="$WORK/apps/OpenGeni Agent.app"
mkdir -p "$DST/Contents/MacOS"
printf 'ORIGINAL\n' > "$DST/Contents/marker"
# Force the "move the new bundle into place" mv to fail by handing it a source that
# does not exist; the move-aside + restore paths use the real mv.
( macos_swap_bundle_into_place "$WORK/does-not-exist.app" "$DST" ) >"$WORK/swap-out" 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then ok "swap failure exited with rc 2 (die)"; else bad "swap failure rc=$rc (expected 2)"; cat "$WORK/swap-out"; fi
if [ -f "$DST/Contents/marker" ] && grep -q ORIGINAL "$DST/Contents/marker"; then
  ok "previous bundle restored from .bak"
else
  bad "previous bundle was NOT restored"; ls -la "$WORK/apps" 2>&1
fi
# No .bak litter should remain in the apps dir.
if ls "$WORK/apps"/.*.bak.* >/dev/null 2>&1; then
  bad "a .bak backup was left behind after restore"; ls -la "$WORK/apps"
else
  ok "no .bak backup left behind"
fi

echo ""
echo "SIM RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
