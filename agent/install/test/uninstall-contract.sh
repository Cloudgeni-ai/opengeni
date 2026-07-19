#!/bin/sh
# shellcheck shell=sh
# Local contract tests for the retry-safe POSIX uninstaller. The fake agent
# records argv only; no service manager, enrollment, or network is contacted.

set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
SCRIPT="$ROOT/install/uninstall.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

fail() { printf '%s\n' "FAIL: $*" >&2; exit 1; }

make_fake_agent() {
  dir="$1"
  mkdir -p "$dir"
  cat > "$dir/opengeni-agent" <<'FAKE'
#!/bin/sh
printf '%s\n' "$*" >> "$OPENGENI_TEST_AGENT_LOG"
case "$*" in
  "service uninstall") exit "${OPENGENI_TEST_SERVICE_STATUS:-0}" ;;
  "uninstall --purge") exit "${OPENGENI_TEST_PURGE_STATUS:-0}" ;;
  "uninstall --purge --local-only") exit 0 ;;
esac
exit 0
FAKE
  chmod 0755 "$dir/opengeni-agent"
}

# An ambiguous native-service failure is the earliest fence: do not attempt a
# remote revoke and preserve binary + credentials for recovery.
case_service="$WORK/service-failure"
make_fake_agent "$case_service/bin"
mkdir -p "$case_service/config"
printf 'credentials\n' > "$case_service/config/credentials.json"
OPENGENI_INSTALL_DIR="$case_service/bin" \
OPENGENI_CONFIG_DIR="$case_service/config" \
OPENGENI_TEST_AGENT_LOG="$case_service/agent.log" \
OPENGENI_TEST_SERVICE_STATUS=1 \
  sh "$SCRIPT" --purge >"$case_service/out" 2>"$case_service/err" \
  && fail "service failure unexpectedly succeeded"
test -x "$case_service/bin/opengeni-agent" || fail "binary removed after service failure"
test -f "$case_service/config/credentials.json" || fail "credentials removed after service failure"
test "$(wc -l < "$case_service/agent.log" | tr -d ' ')" = 1 || fail "work continued after service failure"
grep -qx 'service uninstall' "$case_service/agent.log" || fail "service cleanup was not first"
grep -q 'service cleanup was not confirmed' "$case_service/err" || fail "service recovery warning missing"

# An ambiguous remote revoke must preserve both retry inputs after service
# cleanup succeeded. The fake binary returns failure for exactly the purge call.
case_remote="$WORK/remote-failure"
make_fake_agent "$case_remote/bin"
mkdir -p "$case_remote/config"
printf 'credentials\n' > "$case_remote/config/credentials.json"
OPENGENI_INSTALL_DIR="$case_remote/bin" \
OPENGENI_CONFIG_DIR="$case_remote/config" \
OPENGENI_TEST_AGENT_LOG="$case_remote/agent.log" \
OPENGENI_TEST_PURGE_STATUS=1 \
  sh "$SCRIPT" --purge >"$case_remote/out" 2>"$case_remote/err" \
  && fail "remote failure unexpectedly succeeded"
test -x "$case_remote/bin/opengeni-agent" || fail "retry binary was removed after remote failure"
test -f "$case_remote/config/credentials.json" || fail "credentials were removed after remote failure"
printf '%s\n' 'service uninstall' 'uninstall --purge' > "$case_remote/expected.log"
cmp -s "$case_remote/expected.log" "$case_remote/agent.log" || fail "cleanup/revoke argv order drifted"
grep -q 'keeping binary and credentials' "$case_remote/err" || fail "retry warning missing"

# The escape hatch is only legal with purge and must make its remote-state risk
# visible while allowing local cleanup after confirmed service removal.
case_local="$WORK/local-only"
make_fake_agent "$case_local/bin"
mkdir -p "$case_local/config"
printf 'credentials\n' > "$case_local/config/credentials.json"
OPENGENI_INSTALL_DIR="$case_local/bin" \
OPENGENI_CONFIG_DIR="$case_local/config" \
OPENGENI_TEST_AGENT_LOG="$case_local/agent.log" \
  sh "$SCRIPT" --purge --local-only >"$case_local/out" 2>"$case_local/err"
test ! -e "$case_local/bin/opengeni-agent" || fail "local-only did not remove binary"
test ! -d "$case_local/config" || fail "local-only did not remove credentials"
printf '%s\n' 'service uninstall' 'uninstall --purge --local-only' > "$case_local/expected.log"
cmp -s "$case_local/expected.log" "$case_local/agent.log" || fail "local-only argv order drifted"
grep -q 'dashboard enrollment may remain active' "$case_local/err" || fail "local-only warning missing"

if OPENGENI_INSTALL_DIR="$case_local/bin" sh "$SCRIPT" --local-only >/dev/null 2>&1; then
  fail "--local-only without --purge unexpectedly succeeded"
fi

printf '%s\n' 'uninstall-contract OK: cleanup fence, retry retention, local-only warning'
