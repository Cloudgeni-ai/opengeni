#!/bin/sh
# Prove the headless enrollment grant stays in the child environment and never
# appears in the POSIX installer's child argv.

set -eu

AGENT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
INSTALL_SH="$AGENT_DIR/install/install.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

fail() { printf '%s\n' "FAIL: $*" >&2; exit 1; }

# shellcheck disable=SC1090
OPENGENI_INSTALL_LIB=1 . "$INSTALL_SH"

FAKE="$WORK/fake-agent"
cat > "$FAKE" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$OPENGENI_TEST_ARGV_LOG"
printf '%s' "${OPENGENI_ENROLL_TOKEN-}" > "$OPENGENI_TEST_TOKEN_LOG"
EOF
chmod 0755 "$FAKE"

export OPENGENI_ENROLL_TOKEN='oget_test-secret-never-in-argv'
export OPENGENI_API_URL='https://api.example.test'
export OPENGENI_TEST_ARGV_LOG="$WORK/argv"
export OPENGENI_TEST_TOKEN_LOG="$WORK/token"
finish "$FAKE" >/dev/null

cat > "$WORK/expected" <<'EOF'
--api-url
https://api.example.test
enroll
--non-interactive
EOF
cmp -s "$WORK/expected" "$WORK/argv" || fail "headless enroll argv drifted"
if grep -Fq -- '--token' "$WORK/argv"; then
  fail "headless enrollment token flag leaked into argv"
fi
if grep -Fq -- "$OPENGENI_ENROLL_TOKEN" "$WORK/argv"; then
  fail "headless enrollment token value leaked into argv"
fi
[ "$(cat "$WORK/token")" = "$OPENGENI_ENROLL_TOKEN" ] \
  || fail "fake child did not inherit OPENGENI_ENROLL_TOKEN"

printf '%s\n' 'enroll-token-argv OK: POSIX child uses environment, not argv'