#!/bin/sh
# shellcheck shell=sh
# Local contract tests for the retry-safe POSIX uninstaller. The fake agent
# records argv only; no service manager, enrollment, or network is contacted.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SCRIPT="$ROOT/install/uninstall.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

fail() { printf '%s\n' "FAIL: $*" >&2; exit 1; }

make_fake_agent() {
  dir="$1"
  mkdir -p "$dir"
  cat > "$dir/opengeni-agent" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$OPENGENI_TEST_AGENT_LOG"
case "$*" in
  "uninstall --purge") exit "${OPENGENI_TEST_PURGE_STATUS:-0}" ;;
  "uninstall --purge --local-only") exit 0 ;;
  "service uninstall") exit 0 ;;
esac
exit 0
SH
  chmod 0755 "$dir/opengeni-agent"
}

# An ambiguous remote revoke must preserve both retry inputs and stop before any
# service/binary cleanup. The fake binary returns failure for exactly this call.
case_one="$WORK/remote-failure"
make_fake_agent "$case_one/bin"
mkdir -p "$case_one/config"
printf 'credentials\n' > "$case_one/config/credentials.json"
OPENGENI_INSTALL_DIR="$case_one/bin" \
OPENGENI_CONFIG_DIR="$case_one/config" \
OPENGENI_TEST_AGENT_LOG="$case_one/agent.log" \
OPENGENI_TEST_PURGE_STATUS=1 \
  sh "$SCRIPT" --purge >"$case_one/out" 2>"$case_one/err" && fail "remote failure unexpectedly succeeded"
test -x "$case_one/bin/opengeni-agent" || fail "retry binary was removed after remote failure"
test -f "$case_one/config/credentials.json" || fail "credentials were removed after remote failure"
grep -qx 'uninstall --purge' "$case_one/agent.log" || fail "purge argv was not exact"
grep -q 'keeping binary and credentials' "$case_one/err" || fail "retry warning missing"

# The escape hatch is only legal with purge and must make its remote-state risk
# visible while allowing local cleanup.
case_two="$WORK/local-only"
make_fake_agent "$case_two/bin"
mkdir -p "$case_two/config"
printf 'credentials\n' > "$case_two/config/credentials.json"
OPENGENI_INSTALL_DIR="$case_two/bin" \
OPENGENI_CONFIG_DIR="$case_two/config" \
OPENGENI_TEST_AGENT_LOG="$case_two/agent.log" \
  sh "$SCRIPT" --purge --local-only >"$case_two/out" 2>"$case_two/err"
test ! -e "$case_two/bin/opengeni-agent" || fail "local-only did not remove binary"
test ! -d "$case_two/config" || fail "local-only did not remove credentials"
grep -qx 'uninstall --purge --local-only' "$case_two/agent.log" || fail "local-only argv was not exact"
grep -q 'dashboard enrollment may remain active' "$case_two/err" || fail "local-only warning missing"

if OPENGENI_INSTALL_DIR="$case_two/bin" sh "$SCRIPT" --local-only >/dev/null 2>&1; then
  fail "--local-only without --purge unexpectedly succeeded"
fi

printf '%s\n' 'uninstall-contract OK: retry retention and local-only warning'