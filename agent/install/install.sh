#!/bin/sh
# shellcheck shell=sh
#
# OpenGeni self-hosted agent installer — Linux + macOS, STRICT POSIX sh.
# =============================================================================
#
#   curl -fsSL https://get.opengeni.ai/install.sh | sh
#
# READ THIS BEFORE PIPING IT TO A SHELL. This script downloads the
# `opengeni-agent` binary for your OS/arch, VERIFIES it two independent ways
# (a minisign signature against a public key PINNED in this script's body, AND
# a sha256 checksum), installs it to a per-user path, and then PRINTS the exact
# command to enroll + run it. It installs NO background service by default and
# contains NO secrets. The pinned public key travels WITH this audited script,
# so a compromised CDN or mirror cannot serve a binary that verifies.
#
# Run model (dossier §23.0): the default is a FOREGROUND `opengeni-agent run`,
# tied to its own lifetime — the machine is online while it runs and offline
# when it stops. An always-on service is an explicit opt-in
# (`opengeni-agent service install`), never installed by this script.
#
# Environment overrides (all optional):
#   OPENGENI_INSTALL_BASE_URL  Release asset base URL. Default:
#                              https://get.opengeni.ai. Point this at a local
#                              mock release dir (file:// or http://localhost)
#                              to test the verify flow offline.
#   OPENGENI_AGENT_VERSION     Pin a version (e.g. 1.2.3). Default: "latest",
#                              which resolves the immutable per-version path the
#                              edge advertises. The direct GitHub-Releases asset
#                              URL is the documented fallback (see below).
#   OPENGENI_INSTALL_DIR       Install dir. Default: ~/.local/bin (no sudo).
#   OPENGENI_SYSTEM=1          Install to /usr/local/bin (needs sudo/root).
#   OPENGENI_ENROLL_TOKEN      Non-interactive enroll token (CI/automation): the
#                              script runs `enroll --non-interactive` itself.
#   OPENGENI_NO_RUN=1          Do not start a foreground run; just print the
#                              enroll+run command (the default when stdin is not
#                              a TTY, e.g. piped from curl).
#   OPENGENI_API_URL           Control-plane API base URL for enrollment.
#
# Immutable-per-version + GH-Releases fallback. The edge serves the latest
# release at $BASE/install.sh and immutable copies at $BASE/v/<ver>/install.sh.
# Assets resolve to $BASE/agent/<ver>/<asset> (immutable per version). If the
# edge is down, the SAME assets are mirrored on the GitHub Release:
#   https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-v<ver>/<asset>
# point OPENGENI_INSTALL_BASE_URL there (with OPENGENI_AGENT_VERSION pinned) to
# install straight from GitHub Releases — the verify is identical.
#
# Exit codes (so a CI harness can assert on the failure mode):
#   0  success           3  download failed
#   2  usage/bad env     4  checksum mismatch
#   5  signature verify failed   6  no verify tool (openssl/minisign) available
#   7  unsupported OS/arch
# =============================================================================

set -eu

# --- The PINNED minisign public key (base64 line of opengeni-agent-minisign.pub).
# This is the SECOND line of agent/install/opengeni-agent-minisign.pub. It is the
# trust root: a binary is rejected unless its .minisig verifies against THIS key.
# Rotating the release key means shipping a new install script (audited) — by
# design.
OPENGENI_MINISIGN_PUBKEY='RWSaqgF1EVFuci7hXvDJO7cBh2xf2k0XKhCpvl23aWKG+nMAGfZ6D2Pn'

# --- Defaults / config -------------------------------------------------------
BASE_URL="${OPENGENI_INSTALL_BASE_URL:-https://get.opengeni.ai}"
VERSION="${OPENGENI_AGENT_VERSION:-latest}"

log()  { printf '%s\n' "opengeni-install: $*" >&2; }
err()  { printf '%s\n' "opengeni-install: ERROR: $*" >&2; }
die()  { err "$2"; exit "$1"; }

# A temp dir we always clean up, so a failed/partial download never lingers.
TMPDIR_OG=""
cleanup() { if [ -n "$TMPDIR_OG" ]; then rm -rf "$TMPDIR_OG" 2>/dev/null || true; fi; }
trap cleanup EXIT INT TERM

# --- OS / arch detection → the release asset name ----------------------------
# Mirrors the cargo target triples (dossier §23.1). Linux is the static musl
# build (zero glibc dep — runs on any distro); macOS is a single universal binary.
detect_asset() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64)  echo "opengeni-agent-x86_64-unknown-linux-musl" ;;
        aarch64|arm64) echo "opengeni-agent-aarch64-unknown-linux-musl" ;;
        *) die 7 "unsupported Linux arch: $arch" ;;
      esac
      ;;
    Darwin)
      # One universal binary covers Intel + Apple Silicon.
      echo "opengeni-agent-universal-apple-darwin"
      ;;
    *) die 7 "unsupported OS: $os (this installer is Linux + macOS; use install.ps1 on Windows)" ;;
  esac
}

# --- Download helper (curl, then wget) ---------------------------------------
# Writes URL to OUT. Returns non-zero on any HTTP/transport failure (set -e in
# the caller turns that into the download-failed exit).
fetch() {
  _url="$1"; _out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$_url" -o "$_out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$_url" -O "$_out"
  else
    die 3 "neither curl nor wget is available to download $_url"
  fi
}

# --- sha256 of a file (the first available tool) -----------------------------
sha256_of() {
  _f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$_f" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$_f" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$_f" | sed 's/^.*= //'
  else
    die 6 "no sha256 tool (sha256sum/shasum/openssl) available"
  fi
}

# --- minisign signature verify ----------------------------------------------
# Two paths, both verifying the SAME ed25519 signature against the pinned key:
#   1. the `minisign`/`rsign2` binary if present (simplest, exact upstream impl);
#   2. otherwise a self-contained `openssl` ed25519 verify, reconstructing the
#      raw public key from the pinned base64 — so verification works on a stock
#      box with only openssl, never silently skipped.
# A minisign pubkey base64 decodes to: 2-byte algo ("Ed") + 8-byte key id +
# 32-byte ed25519 public key. A .minisig's first base64 (the "untrusted comment"
# signature line) decodes to: 2-byte algo + 8-byte key id + 64-byte signature.
# minisign signs the raw FILE bytes (legacy "E" mode is over the file; "ED"
# prehashes with BLAKE2b — our release signer uses the prehashed form, so the
# openssl path verifies the BLAKE2b-512 hash). We therefore prefer the minisign
# binary and only use openssl for the legacy/un-prehashed signature.
verify_signature() {
  _file="$1"; _sig="$2"

  if command -v minisign >/dev/null 2>&1; then
    minisign -Vm "$_file" -x "$_sig" -P "$OPENGENI_MINISIGN_PUBKEY" >/dev/null 2>&1 \
      || die 5 "minisign signature verification FAILED for $(basename "$_file")"
    log "minisign signature verified (minisign binary)"
    return 0
  fi
  if command -v rsign >/dev/null 2>&1; then
    # rsign2 takes the pubkey via a file; write the pinned key out.
    _pk="$TMPDIR_OG/minisign.pub"
    printf 'untrusted comment: opengeni-agent pinned\n%s\n' "$OPENGENI_MINISIGN_PUBKEY" > "$_pk"
    rsign verify -p "$_pk" -x "$_sig" "$_file" >/dev/null 2>&1 \
      || die 5 "rsign2 signature verification FAILED for $(basename "$_file")"
    log "minisign signature verified (rsign2)"
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    verify_signature_openssl "$_file" "$_sig"
    return 0
  fi
  die 6 "no signature-verify tool (minisign, rsign2, or openssl) available"
}

# Pure-openssl ed25519 verify of a minisign detached signature. Reconstructs a
# DER-wrapped ed25519 public key from the pinned base64 and verifies the
# signature over the file's BLAKE2b-512 prehash (minisign "ED" algorithm) — the
# form our release signer emits. Fails closed on any mismatch.
verify_signature_openssl() {
  _file="$1"; _sig="$2"

  # Decode the pinned pubkey: skip the 2-byte algo + 8-byte keyid, take 32 bytes.
  pk_raw="$TMPDIR_OG/pk.raw"
  printf '%s' "$OPENGENI_MINISIGN_PUBKEY" | b64decode > "$TMPDIR_OG/pk.bin" \
    || die 5 "could not decode the pinned public key"
  dd if="$TMPDIR_OG/pk.bin" of="$pk_raw" bs=1 skip=10 count=32 2>/dev/null
  [ "$(wc -c < "$pk_raw")" -eq 32 ] || die 5 "pinned public key has an unexpected length"

  # The signature line is the SECOND line of the .minisig (the base64 right after
  # the "untrusted comment:" line). Decode: 2-byte algo + 8-byte keyid + 64-byte
  # signature.
  sig_b64="$(sed -n '2p' "$_sig")"
  printf '%s' "$sig_b64" | b64decode > "$TMPDIR_OG/sig.bin" \
    || die 5 "could not decode the signature"
  algo="$(dd if="$TMPDIR_OG/sig.bin" bs=1 count=2 2>/dev/null)"
  dd if="$TMPDIR_OG/sig.bin" of="$TMPDIR_OG/sig.raw" bs=1 skip=10 count=64 2>/dev/null
  [ "$(wc -c < "$TMPDIR_OG/sig.raw")" -eq 64 ] || die 5 "signature has an unexpected length"

  # Wrap the raw 32-byte ed25519 key in the fixed 12-byte SubjectPublicKeyInfo DER
  # prefix openssl expects (SEQ/SEQ/OID 1.3.101.112/BITSTRING). Emit it via POSIX
  # printf octal escapes (no xxd/hex tooling needed): the hex bytes
  # 30 2a 30 05 06 03 2b 65 70 03 21 00 are octal \060\052\060\005\006\003\053\145\160\003\041\000.
  printf '\060\052\060\005\006\003\053\145\160\003\041\000' > "$TMPDIR_OG/pk.der"
  cat "$pk_raw" >> "$TMPDIR_OG/pk.der"
  if command -v openssl >/dev/null 2>&1; then
    openssl pkey -pubin -inform DER -in "$TMPDIR_OG/pk.der" \
      -out "$TMPDIR_OG/pk.pem" 2>/dev/null \
      || die 5 "could not load the pinned ed25519 public key into openssl"
  fi

  # Determine the signed bytes: "ED" => BLAKE2b-512 prehash of the file; "Ed" =>
  # the file bytes directly. openssl's ed25519 verify is one-shot over a file.
  case "$algo" in
    ED)
      if openssl dgst -blake2b512 -binary "$_file" > "$TMPDIR_OG/prehash" 2>/dev/null; then
        _signed="$TMPDIR_OG/prehash"
      else
        die 6 "openssl lacks BLAKE2b-512; install minisign to verify this prehashed signature"
      fi
      ;;
    Ed) _signed="$_file" ;;
    *)  die 5 "unrecognized minisign algorithm in the signature" ;;
  esac

  openssl pkeyutl -verify -pubin -inkey "$TMPDIR_OG/pk.pem" -rawin \
    -in "$_signed" -sigfile "$TMPDIR_OG/sig.raw" >/dev/null 2>&1 \
    || die 5 "ed25519 signature verification FAILED for $(basename "$_file")"
  log "minisign signature verified (openssl ed25519)"
}

# base64 decode from stdin → stdout, portable across coreutils/busybox/macOS.
b64decode() {
  if base64 --help 2>&1 | grep -q -- '-d'; then base64 -d
  elif base64 --help 2>&1 | grep -q -- '-D'; then base64 -D
  else openssl base64 -d; fi
}

# --- The asset URL for a name. Immutable per version; "latest" goes to the
# edge's latest-pointer.
asset_url() {
  _name="$1"
  if [ "$VERSION" = "latest" ]; then
    echo "$BASE_URL/agent/latest/$_name"
  else
    echo "$BASE_URL/agent/v$VERSION/$_name"
  fi
}

# --- Resolve the per-user install dir (no sudo by default) -------------------
resolve_install_dir() {
  if [ -n "${OPENGENI_INSTALL_DIR:-}" ]; then
    echo "$OPENGENI_INSTALL_DIR"; return
  fi
  if [ "${OPENGENI_SYSTEM:-0}" = "1" ]; then
    echo "/usr/local/bin"; return
  fi
  echo "${HOME}/.local/bin"
}

main() {
  asset="$(detect_asset)"
  TMPDIR_OG="$(mktemp -d 2>/dev/null || mktemp -d -t opengeni)"
  log "installing $asset (version: $VERSION) from $BASE_URL"

  bin_url="$(asset_url "$asset")"
  sha_url="${bin_url}.sha256"
  sig_url="${bin_url}.minisig"

  bin_tmp="$TMPDIR_OG/$asset"
  sha_tmp="$TMPDIR_OG/$asset.sha256"
  sig_tmp="$TMPDIR_OG/$asset.minisig"

  log "downloading binary + checksum + signature"
  fetch "$bin_url" "$bin_tmp" || die 3 "failed to download $bin_url"
  fetch "$sha_url" "$sha_tmp" || die 3 "failed to download $sha_url"
  fetch "$sig_url" "$sig_tmp" || die 3 "failed to download $sig_url"

  # GATE 1: checksum.
  want="$(cut -d' ' -f1 < "$sha_tmp")"
  got="$(sha256_of "$bin_tmp")"
  if [ "$want" != "$got" ]; then
    err "checksum mismatch: expected $want got $got"
    exit 4
  fi
  log "sha256 checksum OK"

  # GATE 2: minisign signature against the pinned key (fail-closed, no skip).
  verify_signature "$bin_tmp" "$sig_tmp"

  # Atomic install: chmod then rename into place so a re-install never leaves a
  # half-written binary on PATH.
  install_dir="$(resolve_install_dir)"
  mkdir -p "$install_dir" 2>/dev/null || die 2 "cannot create install dir $install_dir"
  dest="$install_dir/opengeni-agent"
  chmod 0755 "$bin_tmp"
  mv -f "$bin_tmp" "$dest" || die 2 "cannot install to $dest (try OPENGENI_SYSTEM=1 with sudo, or set OPENGENI_INSTALL_DIR)"
  log "installed verified binary to $dest"

  # PATH hint (the current shell is not refreshed).
  case ":${PATH}:" in
    *":$install_dir:"*) : ;;
    *) log "NOTE: add $install_dir to your PATH:  export PATH=\"$install_dir:\$PATH\"" ;;
  esac

  finish "$dest"
}

# Print the enroll+run instructions, or — in CI mode — enroll non-interactively.
# Per §23.0 the installer NEVER installs a service and only starts a foreground
# run when explicitly asked on an interactive TTY.
finish() {
  _bin="$1"
  echo ""
  if [ -n "${OPENGENI_ENROLL_TOKEN:-}" ]; then
    log "non-interactive enroll (OPENGENI_ENROLL_TOKEN set)"
    "$_bin" enroll --token "$OPENGENI_ENROLL_TOKEN" --non-interactive
    log "enrolled. Start the agent (foreground) with:  $_bin run"
    return 0
  fi

  printf '%s\n' "opengeni-agent installed at: $_bin"
  printf '%s\n' ""
  printf '%s\n' "Next steps (the agent runs in the FOREGROUND — it does NOT install a service):"
  printf '%s\n' "  1. Enroll this machine:   $_bin enroll"
  printf '%s\n' "  2. Run it (online while this runs, offline when you stop it):"
  printf '%s\n' "       $_bin run"
  printf '%s\n' ""
  printf '%s\n' "Want an always-on machine instead? That is opt-in:  $_bin service install"
  printf '%s\n' "Uninstall any time:  $_bin uninstall   (or curl -fsSL $BASE_URL/uninstall.sh | sh)"

  # Only auto-start a foreground run when on a real TTY and not opted out.
  if [ "${OPENGENI_NO_RUN:-0}" != "1" ] && [ -t 0 ]; then
    printf '%s\n' ""
    log "starting a foreground run (Ctrl-C to stop; set OPENGENI_NO_RUN=1 to skip)"
    exec "$_bin" run
  fi
}

main "$@"
