#!/bin/sh
# Real minisign fixtures; no release private key, network, install, or service.
# Exercise the installer with minisign hidden from PATH and with crypto tools
# independently capable/unavailable. Bootstrap archives are synthetic, containing
# the trusted test runner's minisign, with pins changed only in installer copies.
set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MINISIGN="$(command -v minisign)"
OPENSSL="$(command -v openssl || true)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
mkdir -p "$WORK/tools" "$WORK/stage" "$WORK/mirror" "$WORK/mock/agent/latest"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# A minimal PATH: hide installed minisign/rsign, retain ordinary system tools.
for tool in sh mkdir rm cat dd wc cmp sed awk cut grep basename base64 chmod tar gzip unzip curl wget timeout sha256sum shasum; do
  location="$(command -v "$tool" || true)"
  [ -z "$location" ] || ln -s "$location" "$WORK/tools/$tool"
done
ln -s "$(command -v uname)" "$WORK/tools/uname"
if [ -n "$OPENSSL" ]; then ln -s "$OPENSSL" "$WORK/tools/openssl"; fi

# Generate signed raw Ed and prehashed ED fixtures with upstream minisign.
"$MINISIGN" -G -W -p "$WORK/key.pub" -s "$WORK/key.sec" >/dev/null 2>&1
PUB="$(sed -n '2p' "$WORK/key.pub")"
printf 'signature portability fixture\n' > "$WORK/artifact"
for algorithm in Ed ED; do
  if [ "$algorithm" = Ed ]; then legacy=-l; else legacy=; fi
  "$MINISIGN" -S -W $legacy -s "$WORK/key.sec" -m "$WORK/artifact" \
    -x "$WORK/$algorithm.minisig" -t 'fixture artifact' >/dev/null 2>&1
done
cp "$WORK/artifact" "$WORK/tampered"
printf 'tampered\n' >> "$WORK/tampered"
sed '3s/fixture artifact/changed artifact/' "$WORK/ED.minisig" > "$WORK/comment.minisig"
printf 'untrusted comment: fixture\nAA==\ntrusted comment: fixture\nAA==\n' > "$WORK/invalid.minisig"
sed -n '2p' "$WORK/ED.minisig" | base64 -d > "$WORK/packet"
for mutation in key-id algorithm; do
  if [ "$mutation" = key-id ]; then
    printf 'EDbad-key!' > "$WORK/mutated-packet"
    dd if="$WORK/packet" bs=1 skip=10 >> "$WORK/mutated-packet" 2>/dev/null
  else
    printf 'XX' > "$WORK/mutated-packet"
    dd if="$WORK/packet" bs=1 skip=2 >> "$WORK/mutated-packet" 2>/dev/null
  fi
  encoded="$(base64 < "$WORK/mutated-packet" | tr -d '\r\n')"
  awk -v encoded="$encoded" 'NR == 2 { print encoded; next } { print }' "$WORK/ED.minisig" > "$WORK/$mutation.minisig"
  if "$MINISIGN" -Vm "$WORK/artifact" -P "$PUB" -x "$WORK/$mutation.minisig" >/dev/null 2>&1; then
    echo "invalid $mutation fixture unexpectedly accepted" >&2; exit 1
  fi
done

# Build the platform's exact expected archive shape around a trusted verifier.
make_archive() {
  _archive_stage="$1"; _archive_destination="$2"
  case "$(uname -s)" in
    Darwin) (cd "$_archive_stage" && zip -q "$_archive_destination" minisign) ;;
    Linux) (cd "$_archive_stage" && tar -czf "$_archive_destination" minisign-linux) ;;
    *) echo 'unsupported test host' >&2; exit 7 ;;
  esac
}
case "$(uname -s)" in
  Darwin)
    ARCHIVE=minisign-0.11-macos.zip
    ORIGINAL_SHA=e7c410ae8b8960d7087392472b040bda9b2f307c76df0384ac37f9ad103fc893
    HELPER_MEMBER=minisign
    ;;
  Linux)
    ARCHIVE=minisign-0.11-linux.tar.gz
    ORIGINAL_SHA=f0a0954413df8531befed169e447a66da6868d79052ed7e892e50a4291af7ae0
    case "$(uname -m)" in
      x86_64|amd64) HELPER_MEMBER=minisign-linux/x86_64/minisign ;;
      aarch64|arm64) HELPER_MEMBER=minisign-linux/aarch64/minisign ;;
      *) echo 'unsupported test architecture' >&2; exit 7 ;;
    esac
    mkdir -p "$WORK/stage/$(dirname "$HELPER_MEMBER")"
    ;;
esac
cp "$MINISIGN" "$WORK/stage/$HELPER_MEMBER"
make_archive "$WORK/stage" "$WORK/mirror/$ARCHIVE"
FIXTURE_SHA="$(sha256 "$WORK/mirror/$ARCHIVE")"
sed -e "s#^OPENGENI_MINISIGN_PUBKEY=.*#OPENGENI_MINISIGN_PUBKEY='$PUB'#" \
  -e "s#_bootstrap_sha=$ORIGINAL_SHA#_bootstrap_sha=$FIXTURE_SHA#" \
  "$ROOT/agent/install/install.sh" > "$WORK/install.sh"

cat > "$WORK/run.sh" <<'SH'
#!/bin/sh
set -eu
OPENGENI_INSTALL_LIB=1 . "$1"
TMPDIR_OG="$2"
case "$5" in
  verify) verify_signature "$3" "$4" ;;
  twice) verify_signature "$3" "$4"; verify_signature "$3" "$6" ;;
  download)
    BASE_URL="$6"; VERSION=latest
    download_verified_asset artifact "$TMPDIR_OG/artifact"
    ;;
esac
SH

passed=0
run_case() {
  expected="$1"; label="$2"; path="$3"; source="$4"; file="$5"; signature="$6"; mode="${7:-verify}"; extra="${8:-}"
  temp="$WORK/temp-$label"
  mkdir -p "$temp"
  rc=0
  PATH="$path" OPENGENI_MINISIGN_BOOTSTRAP_BASE_URL="${MIRROR:-file://$WORK/mirror}" \
    sh "$WORK/run.sh" "$source" "$temp" "$file" "$signature" "$mode" "$extra" > "$WORK/log-$label" 2>&1 || rc=$?
  if [ "$rc" -ne "$expected" ]; then
    echo "FAIL: $label (expected $expected, got $rc)" >&2
    cat "$WORK/log-$label" >&2
    exit 1
  fi
  passed=$((passed+1))
  echo "PASS: $label"
}

# Disable capabilities independently; an installed command name alone proves
# nothing. Wrappers delegate all other operations to the actual host OpenSSL.
make_crypto_path() {
  _crypto_label="$1"; _crypto_command="$2"
  _crypto_path="$WORK/tools-$_crypto_label"
  mkdir -p "$_crypto_path"
  for location in "$WORK/tools/"*; do
    [ "$(basename "$location")" = openssl ] || ln -s "$location" "$_crypto_path/$(basename "$location")"
  done
  cat > "$_crypto_path/openssl" <<'SH'
#!/bin/sh
case "$1" in
  pkey) [ "$TEST_MISSING_CRYPTO" != key ] || exit 1 ;;
  pkeyutl) [ "$TEST_MISSING_CRYPTO" != verify ] || exit 1 ;;
  dgst) [ "$TEST_MISSING_CRYPTO" != blake2 ] || [ "${2:-}" != -blake2b512 ] || exit 1 ;;
esac
[ -n "$TEST_REAL_OPENSSL" ] || exit 1
exec "$TEST_REAL_OPENSSL" "$@"
SH
  chmod 0755 "$_crypto_path/openssl"
  TEST_MISSING_CRYPTO="$_crypto_command"; export TEST_MISSING_CRYPTO
  TEST_REAL_OPENSSL="$OPENSSL"; export TEST_REAL_OPENSSL
}

make_crypto_path no-key key
for algorithm in Ed ED; do
  run_case 0 "bootstrap-$algorithm" "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/$algorithm.minisig"
  grep -q 'pinned temporary verifier' "$WORK/log-bootstrap-$algorithm"
  run_case 5 "bootstrap-tampered-$algorithm" "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/tampered" "$WORK/$algorithm.minisig"
done
run_case 0 bootstrap-cache "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/ED.minisig" twice "$WORK/Ed.minisig"
[ "$(grep -c 'downloading pinned minisign verifier' "$WORK/log-bootstrap-cache")" -eq 1 ]
run_case 5 bootstrap-comment "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/comment.minisig"
run_case 5 bootstrap-invalid-signature "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/invalid.minisig"
run_case 5 bootstrap-key-id "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/key-id.minisig"
run_case 5 bootstrap-algorithm "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/algorithm.minisig"
sed "s#^OPENGENI_MINISIGN_PUBKEY=.*#OPENGENI_MINISIGN_PUBKEY='AA=='#" "$WORK/install.sh" > "$WORK/bad-key.sh"
run_case 5 bootstrap-invalid-key "$WORK/tools-no-key" "$WORK/bad-key.sh" "$WORK/artifact" "$WORK/ED.minisig"

make_crypto_path no-verify verify
run_case 0 bootstrap-no-pkeyutl "$WORK/tools-no-verify" "$WORK/install.sh" "$WORK/artifact" "$WORK/ED.minisig"
make_crypto_path no-blake2 blake2
run_case 0 bootstrap-no-blake2 "$WORK/tools-no-blake2" "$WORK/install.sh" "$WORK/artifact" "$WORK/ED.minisig"

# When the real tool is capable, a bad signature never downloads a verifier.
# On macOS this additionally exercises /usr/bin/openssl (stock LibreSSL).
unset TEST_MISSING_CRYPTO TEST_REAL_OPENSSL
for algorithm in Ed ED; do
  run_case 0 "native-$algorithm" "$WORK/tools" "$WORK/install.sh" "$WORK/artifact" "$WORK/$algorithm.minisig"
  run_case 5 "native-tampered-$algorithm" "$WORK/tools" "$WORK/install.sh" "$WORK/tampered" "$WORK/$algorithm.minisig"
  if grep -q 'openssl ed25519' "$WORK/log-native-$algorithm"; then
    ! grep -q 'downloading pinned minisign verifier' "$WORK/log-native-tampered-$algorithm"
  fi
done
run_case 5 native-comment "$WORK/tools" "$WORK/install.sh" "$WORK/artifact" "$WORK/comment.minisig"
run_case 5 native-invalid-key "$WORK/tools" "$WORK/bad-key.sh" "$WORK/artifact" "$WORK/ED.minisig"
run_case 5 native-invalid-signature "$WORK/tools" "$WORK/install.sh" "$WORK/artifact" "$WORK/invalid.minisig"
run_case 5 native-key-id "$WORK/tools" "$WORK/install.sh" "$WORK/artifact" "$WORK/key-id.minisig"
run_case 5 native-algorithm "$WORK/tools" "$WORK/install.sh" "$WORK/artifact" "$WORK/algorithm.minisig"
if [ "$(uname -s)" = Darwin ]; then
  rm -f "$WORK/tools/openssl"
  ln -s /usr/bin/openssl "$WORK/tools/openssl"
  for algorithm in Ed ED; do
    run_case 0 "system-macos-$algorithm" "$WORK/tools" "$WORK/install.sh" "$WORK/artifact" "$WORK/$algorithm.minisig"
  done
fi

# A downloaded archive with runnable attacker bytes must fail its immutable pin
# before extraction/execution. An authenticated but unusable tool is exit 6.
mkdir -p "$WORK/evil/$(dirname "$HELPER_MEMBER")" "$WORK/evil-mirror"
cat > "$WORK/evil/$HELPER_MEMBER" <<'SH'
#!/bin/sh
: > "$TEST_EXECUTION_MARKER"
exit 0
SH
chmod 0755 "$WORK/evil/$HELPER_MEMBER"
make_archive "$WORK/evil" "$WORK/evil-mirror/$ARCHIVE"
TEST_EXECUTION_MARKER="$WORK/should-not-execute"; export TEST_EXECUTION_MARKER
TEST_MISSING_CRYPTO=key TEST_REAL_OPENSSL="$OPENSSL"; export TEST_MISSING_CRYPTO TEST_REAL_OPENSSL
MIRROR="file://$WORK/evil-mirror"
run_case 4 bootstrap-tampered-archive "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/ED.minisig"
[ ! -e "$TEST_EXECUTION_MARKER" ]
printf '#!/bin/sh\nexit 127\n' > "$WORK/evil/$HELPER_MEMBER"
rm -f "$WORK/evil-mirror/$ARCHIVE"
make_archive "$WORK/evil" "$WORK/evil-mirror/$ARCHIVE"
UNUSABLE_SHA="$(sha256 "$WORK/evil-mirror/$ARCHIVE")"
sed "s#_bootstrap_sha=$FIXTURE_SHA#_bootstrap_sha=$UNUSABLE_SHA#" "$WORK/install.sh" > "$WORK/unusable.sh"
run_case 6 bootstrap-unusable-tool "$WORK/tools-no-key" "$WORK/unusable.sh" "$WORK/artifact" "$WORK/ED.minisig"
unset MIRROR

# SHA-256 remains the first gate for every downloaded executable.
cp "$WORK/artifact" "$WORK/mock/agent/latest/artifact"
cp "$WORK/ED.minisig" "$WORK/mock/agent/latest/artifact.minisig"
printf '%064d  artifact\n' 0 > "$WORK/mock/agent/latest/artifact.sha256"
run_case 4 artifact-checksum "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/ED.minisig" download "file://$WORK/mock"
! grep -q 'downloading pinned minisign verifier' "$WORK/log-artifact-checksum"

# Unsupported CPU/OS cannot select an arbitrary archive or execute a helper.
rm "$WORK/tools-no-key/uname"
printf '#!/bin/sh\nprintf "unsupported\\n"\n' > "$WORK/tools-no-key/uname"
chmod 0755 "$WORK/tools-no-key/uname"
run_case 7 bootstrap-unsupported-platform "$WORK/tools-no-key" "$WORK/install.sh" "$WORK/artifact" "$WORK/ED.minisig"
! grep -q 'downloading pinned minisign verifier' "$WORK/log-bootstrap-unsupported-platform"
echo "SIGNATURE PORTABILITY: $passed passed"
