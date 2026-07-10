#!/bin/sh
# shellcheck shell=sh
#
# OpenGeni self-hosted agent installer — Linux + macOS, STRICT POSIX sh.
# =============================================================================
#
#   curl -fsSL https://app.opengeni.ai/install.sh | sh
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
#                              https://app.opengeni.ai. Point this at a local
#                              mock release dir (file:// or http://localhost)
#                              to test the verify flow offline.
#   OPENGENI_AGENT_VERSION     Pin a version (e.g. 1.2.3). Default: "latest",
#                              which resolves the immutable per-version path the
#                              edge advertises. The direct GitHub-Releases asset
#                              URL is the documented fallback (see below).
#   OPENGENI_INSTALL_DIR       Install dir. Default: ~/.local/bin (no sudo).
#   OPENGENI_SYSTEM=1          Install to /usr/local/bin (needs sudo/root).
#   OPENGENI_ENROLL_TOKEN      Non-interactive enroll token (CI/automation/fleet):
#                              the script runs `enroll --token <tok>
#                              --non-interactive` itself — the token IS the grant,
#                              so there is NO device-approve step. The workspace is
#                              encoded in the token; OPENGENI_WORKSPACE_ID is not
#                              needed on this path.
#   OPENGENI_NO_RUN=1          Do not start a foreground run; just print the
#                              enroll+run command (the default when stdin is not
#                              a TTY, e.g. piped from curl).
#   OPENGENI_API_URL           Control-plane API base URL for enrollment. Carried
#                              into BOTH the non-interactive enroll (forwarded as
#                              --api-url below) and the interactive `enroll`/`run`
#                              (the agent reads $OPENGENI_API_URL via clap). Set it
#                              to target a specific deployment instead of the
#                              hosted public origin default.
#   OPENGENI_WORKSPACE_ID      The workspace (UUID) an INTERACTIVE device-flow
#                              enroll binds to (the user who approves must hold a
#                              grant in it). Honored by the agent's `enroll`/`run`
#                              via clap ($OPENGENI_WORKSPACE_ID); the one-liner
#                              from the Machines page sets it so no UUID is typed.
#                              Not used on the OPENGENI_ENROLL_TOKEN path.
#   OPENGENI_INSTALL_REPLACE_APP=1  macOS only. Force-replace an EXISTING
#                              Developer-ID/Apple-Development-signed
#                              "OpenGeni Agent.app" bundle. Off by default: a
#                              non-ad-hoc bundle holds the user's Screen
#                              Recording / Accessibility (TCC) grants, and any
#                              binary swap breaks them, so the installer preserves
#                              it and only re-points the CLI symlink unless this is
#                              set. (An ad-hoc bundle — our own prior install — is
#                              always replaced in place: its grants break on any
#                              update regardless.)
#
# macOS install shape. On macOS the verified binary is installed INSIDE an app
# bundle at "$HOME/Applications/OpenGeni Agent.app" (a STABLE CFBundleIdentifier,
# ai.opengeni.agent) and ~/.local/bin/opengeni-agent is a SYMLINK into that bundle
# — one code-signing identity for both the CLI and the background app. macOS TCC
# (Screen Recording / Accessibility) grants attach to that identity + bundle id, so
# the agent's screen/computer-use features work from either entry point. The two
# system permission prompts fire at `opengeni-agent enroll`, not on first use.
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
# Default release-asset base URL. A DEPLOYED control plane REWRITES the next line
# at serve time to its OWN origin, so `curl <control-plane>/install.sh | sh` pulls
# the per-SHA agent baked into that exact deployment (zero version drift, and no
# dependency on the public CDN — a private/air-gapped control plane may not even
# resolve it). The committed default is the public archive, for a from-source or
# standalone install. The OPENGENI_INSTALL_BASE_URL env override always wins.
# Keep this line's shape stable: apps/api/src/routes/install.ts rewrites it by
# exact match (DEFAULT_BASE_REWRITES).
OPENGENI_INSTALL_DEFAULT_BASE_URL="https://app.opengeni.ai"
BASE_URL="${OPENGENI_INSTALL_BASE_URL:-$OPENGENI_INSTALL_DEFAULT_BASE_URL}"
VERSION="${OPENGENI_AGENT_VERSION:-latest}"

# --- macOS app-bundle identity (constants) -----------------------------------
# The bundle id is the STABLE anchor for macOS TCC (Screen Recording /
# Accessibility) grants: the OS keys a grant to the code-signing identity + bundle
# id, so this MUST NOT change across releases or the user re-approves every update.
# It matches the id the release workflow signs the notarized bundle with and the
# id the agent's enroll-time preflight prompts under.
OPENGENI_APP_BUNDLE_ID="ai.opengeni.agent"
OPENGENI_APP_NAME="OpenGeni Agent"
# The optional prebuilt bundle asset the release serves once Apple secrets are set
# (a Developer-ID-signed + notarized .app zipped with its .app dir as the archive
# root). Absent today → the installer assembles an ad-hoc bundle locally instead.
OPENGENI_APP_BUNDLE_ASSET="OpenGeni-Agent.app.zip"

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

# --- macOS app-bundle helpers ------------------------------------------------
# Everything below is only ever called on Darwin (main() branches on `uname -s`),
# so it may lean on macOS-guaranteed tools (codesign, ditto, unzip).

# The CFBundleShortVersionString for the assembled bundle. Prefer a pinned VERSION;
# on "latest" ask the (already verified) binary; else a neutral placeholder — the
# version is cosmetic, the bundle id (not the version) anchors the TCC grant.
resolve_app_version() {
  _bin="$1"
  if [ "$VERSION" != "latest" ]; then printf '%s' "$VERSION"; return; fi
  _v="$("$_bin" --version 2>/dev/null | awk 'NR==1{print $NF}')"
  if [ -n "$_v" ]; then printf '%s' "$_v"; else printf '%s' "0.0.0"; fi
}

# Write the bundle's Info.plist. LSUIElement=true keeps the background agent out of
# the Dock. Kept in sync with the release workflow's plist (same keys + bundle id).
write_info_plist() {
  _plist="$1"; _ver="$2"
  cat > "$_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$OPENGENI_APP_NAME</string>
    <key>CFBundleDisplayName</key><string>$OPENGENI_APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$OPENGENI_APP_BUNDLE_ID</string>
    <key>CFBundleExecutable</key><string>opengeni-agent</string>
    <key>CFBundleShortVersionString</key><string>$_ver</string>
    <key>CFBundleVersion</key><string>$_ver</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSUIElement</key><true/>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
PLIST
}

# True iff an app bundle exists AND carries a NON-ad-hoc code signature (a real
# Apple identity — Developer ID / Apple Development — so a TeamIdentifier is set).
# WHY it matters: such a bundle HOLDS the user's TCC grants; replacing its binary
# breaks them (TCC keys on the identity/cdhash) and forces a re-approve. So we
# never overwrite one. An ad-hoc bundle (`Signature=adhoc`, `TeamIdentifier=not
# set` — our own prior install) is safe to replace in place: its grants break on
# any binary update regardless of what we do.
macos_bundle_is_signed_nonadhoc() {
  _app="$1"
  [ -d "$_app" ] || return 1
  command -v codesign >/dev/null 2>&1 || return 1
  _info="$(codesign -dv "$_app" 2>&1)" || return 1
  case "$_info" in *Signature=adhoc*) return 1 ;; esac
  case "$_info" in *"TeamIdentifier=not set"*) return 1 ;; esac
  case "$_info" in *TeamIdentifier=*) return 0 ;; esac
  return 1
}

# Point the CLI symlink at the bundle's binary and echo its path.
# WHY a symlink INTO the bundle (not a second copy): the CLI (`opengeni-agent …`)
# and the background app must be the SAME binary / code-signing identity. A second
# copy would have its own cdhash → its own (missing) TCC grants → screen capture
# silently fails from the CLI. The symlink guarantees the process the user runs is
# the exact signed binary that holds the grants.
link_macos_cli() {
  _app="$1"; _install_dir="$2"
  mkdir -p "$_install_dir" 2>/dev/null || die 2 "cannot create install dir $_install_dir"
  ln -sf "$_app/Contents/MacOS/opengeni-agent" "$_install_dir/opengeni-agent"
  printf '%s' "$_install_dir/opengeni-agent"
}

# Probe the login keychain for a "Developer ID Application" code-signing identity
# and remember the chosen one in two globals: OPENGENI_SIGN_IDENTITY_HASH (the
# 40-hex SHA-1 to pass to `codesign --sign`, empty if none) and
# OPENGENI_SIGN_IDENTITY_NAME (the human label, for the log line). Called directly
# (NOT via `$(...)`) so the globals survive — a command substitution runs in a
# subshell and would drop them. When several identities are present it
# deterministically picks the FIRST that `security` lists and logs that choice.
# WHY: macOS keys TCC (Screen Recording / Accessibility) grants to the signing
# identity, so re-signing every update with the SAME Developer ID keeps the grants;
# an ad-hoc signature loses them on any update.
OPENGENI_SIGN_IDENTITY_HASH=""
OPENGENI_SIGN_IDENTITY_NAME=""
macos_developer_id_identity() {
  OPENGENI_SIGN_IDENTITY_HASH=""
  OPENGENI_SIGN_IDENTITY_NAME=""
  command -v security >/dev/null 2>&1 || return 0
  # `security find-identity -v -p codesigning` lines look like:
  #   1) <40-hex-sha1> "Developer ID Application: Name (TEAMID)"
  _ids="$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application')" \
    || _ids=""
  [ -n "$_ids" ] || return 0
  _n="$(printf '%s\n' "$_ids" | grep -c 'Developer ID Application')"
  _line="$(printf '%s\n' "$_ids" | head -n1)"
  _hash="$(printf '%s\n' "$_line" | awk '{print $2}')"
  [ -n "$_hash" ] || return 0
  OPENGENI_SIGN_IDENTITY_HASH="$_hash"
  OPENGENI_SIGN_IDENTITY_NAME="$(printf '%s\n' "$_line" | sed -n 's/.*"\(.*\)".*/\1/p')"
  if [ "$_n" -gt 1 ]; then
    log "found $_n Developer ID Application identities; deterministically using the first: $OPENGENI_SIGN_IDENTITY_NAME ($_hash)"
  fi
}

# Code-sign a STAGED bundle (it lives in a temp dir, NOT ~/Applications yet): strip
# quarantine/provenance xattrs, sign with the user's Developer ID when present else
# ad-hoc, then hard-verify. WHY temp-dir + `xattr -cr`: signing in place on a live
# bundle repeatedly failed `codesign --verify --deep --strict` with "invalid
# resource directory" (a sealed leftover *.cstemp / macOS provenance xattrs); a
# clean staged copy scrubbed of xattrs is what actually verifies. A `--verify
# --strict` failure here is FATAL (the caller never swaps a broken bundle in).
# NOTE: POSIX sh has no locals — every var here is global. Use `_bundle` (not the
# caller's `_app`) so this never clobbers the install path the caller swaps in.
macos_sign_bundle() {
  _bundle="$1"

  # Strip quarantine/provenance xattrs the download or copy may have set — the
  # suspected cause of the in-place "invalid resource directory" verify failures.
  if command -v xattr >/dev/null 2>&1; then
    xattr -cr "$_bundle" 2>/dev/null || true
  fi

  if ! command -v codesign >/dev/null 2>&1; then
    log "warning: codesign not found (unexpected on macOS); skipping signing + verification"
    return 0
  fi

  macos_developer_id_identity
  if [ -n "$OPENGENI_SIGN_IDENTITY_HASH" ]; then
    # Signing with the user's identity may pop a one-time Keychain consent prompt —
    # that is expected and desirable (it is what makes the TCC grants durable).
    if codesign --force --sign "$OPENGENI_SIGN_IDENTITY_HASH" \
        --identifier "$OPENGENI_APP_BUNDLE_ID" "$_bundle" >/dev/null 2>&1; then
      log "signed with Developer ID \"$OPENGENI_SIGN_IDENTITY_NAME\" (approve the Keychain prompt if it appears); grants will survive updates that re-sign with this identity"
    else
      log "warning: Developer ID signing failed; falling back to ad-hoc (grants will NOT survive updates)"
      codesign --force --sign - --identifier "$OPENGENI_APP_BUNDLE_ID" "$_bundle" >/dev/null 2>&1 \
        || log "warning: ad-hoc codesign failed; the app runs but macOS may re-prompt for permissions"
    fi
  else
    codesign --force --sign - --identifier "$OPENGENI_APP_BUNDLE_ID" "$_bundle" >/dev/null 2>&1 \
      || log "warning: ad-hoc codesign failed; the app runs but macOS may re-prompt for permissions"
    log "ad-hoc signed (no Developer ID identity found); grants will not survive updates"
  fi

  # Hard-verify the freshly-signed STAGED bundle before it is swapped into place.
  codesign --verify --strict "$_bundle" >/dev/null 2>&1 \
    || die 2 "codesign --verify --strict FAILED for the freshly-signed bundle; not installing"
}

# Atomically replace the installed bundle at $2 with the staged+verified bundle at
# $1: move any existing bundle aside to a dot-prefixed .bak, move the new one into
# place, drop the .bak on success. On ANY failure restore the .bak and die loudly —
# the user is NEVER left without a working bundle.
macos_swap_bundle_into_place() {
  _new="$1"; _dst="$2"
  _bak=""
  if [ -e "$_dst" ] || [ -L "$_dst" ]; then
    _bak="$(dirname "$_dst")/.$(basename "$_dst").bak.$$"
    rm -rf "$_bak" 2>/dev/null || true
    mv "$_dst" "$_bak" || die 2 "cannot move the existing bundle aside ($_dst)"
  fi
  if mv "$_new" "$_dst" 2>/dev/null; then
    if [ -n "$_bak" ]; then rm -rf "$_bak" 2>/dev/null || true; fi
    return 0
  fi
  # The install failed: put the old bundle back so the user keeps a working app.
  if [ -n "$_bak" ]; then
    if mv "$_bak" "$_dst" 2>/dev/null; then
      die 2 "failed to install the new bundle to $_dst; restored the previous bundle"
    fi
    die 2 "failed to install the new bundle to $_dst AND could not restore the backup at $_bak"
  fi
  die 2 "failed to install the new bundle to $_dst"
}

# Assemble an app bundle around the verified binary and symlink the CLI into it.
# Assembled in a temp dir, signed (Developer ID when available, else ad-hoc) +
# verified there, then atomically swapped into ~/Applications — NEVER signed in
# place (see macos_sign_bundle for why). Echoes the CLI path on stdout (logs go to
# stderr via log()).
install_macos_local_bundle() {
  _bin="$1"; _install_dir="$2"
  _app="$HOME/Applications/$OPENGENI_APP_NAME.app"

  # Preserve a real-Apple-signed bundle unless explicitly told to replace it.
  if macos_bundle_is_signed_nonadhoc "$_app"; then
    if [ "${OPENGENI_INSTALL_REPLACE_APP:-0}" != "1" ]; then
      log "kept the existing signed \"$OPENGENI_APP_NAME.app\" (its signature holds your macOS Screen Recording/Accessibility grants). Set OPENGENI_INSTALL_REPLACE_APP=1 to replace it."
      link_macos_cli "$_app" "$_install_dir"
      return 0
    fi
    log "OPENGENI_INSTALL_REPLACE_APP=1 — replacing the existing signed app bundle"
  fi

  # Assemble FRESH in a temp dir. Reached only for an absent bundle, an ad-hoc
  # bundle (safe to replace), or an explicit forced replace.
  _stage="$TMPDIR_OG/local-bundle-stage"
  rm -rf "$_stage"
  _staged_app="$_stage/$OPENGENI_APP_NAME.app"
  mkdir -p "$_staged_app/Contents/MacOS" || die 2 "cannot create the staging bundle"
  cp "$_bin" "$_staged_app/Contents/MacOS/opengeni-agent" || die 2 "cannot populate the staging bundle"
  chmod 0755 "$_staged_app/Contents/MacOS/opengeni-agent"
  write_info_plist "$_staged_app/Contents/Info.plist" \
    "$(resolve_app_version "$_staged_app/Contents/MacOS/opengeni-agent")"

  macos_sign_bundle "$_staged_app"

  mkdir -p "$HOME/Applications" || die 2 "cannot create $HOME/Applications"
  macos_swap_bundle_into_place "$_staged_app" "$_app"
  log "installed app bundle at $_app"
  link_macos_cli "$_app" "$_install_dir"
}

# Non-fatal probe: does the release serve the prebuilt bundle asset? A successful
# fetch of its small .sha256 sidecar means yes; any failure (404 / redirect to a
# missing GitHub asset) means no → we assemble locally. NEVER die here.
bundle_asset_available() {
  _url="$(asset_url "$OPENGENI_APP_BUNDLE_ASSET").sha256"
  _probe="$TMPDIR_OG/bundle-probe.sha256"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$_url" -o "$_probe" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$_url" -O "$_probe" 2>/dev/null
  else
    return 1
  fi
}

# Download + verify (BOTH gates) + install the prebuilt Developer-ID/notarized
# bundle. Preferred over local assembly when available because its grants SURVIVE
# updates (a stable Apple identity), which an ad-hoc bundle cannot offer. Echoes
# the CLI path on stdout.
install_macos_prebuilt_bundle() {
  _install_dir="$1"
  _zip_url="$(asset_url "$OPENGENI_APP_BUNDLE_ASSET")"
  _zip="$TMPDIR_OG/$OPENGENI_APP_BUNDLE_ASSET"
  _zip_sha="$_zip.sha256"
  _zip_sig="$_zip.minisig"

  log "downloading prebuilt bundle $OPENGENI_APP_BUNDLE_ASSET + checksum + signature"
  fetch "$_zip_url" "$_zip" || die 3 "failed to download $_zip_url"
  fetch "${_zip_url}.sha256" "$_zip_sha" || die 3 "failed to download ${_zip_url}.sha256"
  fetch "${_zip_url}.minisig" "$_zip_sig" || die 3 "failed to download ${_zip_url}.minisig"

  # SAME two gates as the bare binary: checksum then pinned-key minisign.
  want="$(cut -d' ' -f1 < "$_zip_sha")"
  got="$(sha256_of "$_zip")"
  if [ "$want" != "$got" ]; then
    err "checksum mismatch for the bundle: expected $want got $got"
    exit 4
  fi
  log "sha256 checksum OK (bundle)"
  verify_signature "$_zip" "$_zip_sig"

  _apps="$HOME/Applications"
  _app="$_apps/$OPENGENI_APP_NAME.app"
  if macos_bundle_is_signed_nonadhoc "$_app" && [ "${OPENGENI_INSTALL_REPLACE_APP:-0}" != "1" ]; then
    log "kept the existing signed \"$OPENGENI_APP_NAME.app\" (its signature holds your macOS grants). Set OPENGENI_INSTALL_REPLACE_APP=1 to replace it."
  else
    # Extract into a temp staging dir, scrub the download's quarantine xattrs, verify
    # the (already Developer-ID + notarized) signature there, then atomically swap it
    # into ~/Applications. We do NOT re-sign a prebuilt bundle — that would break its
    # notarization; xattr-scrub + verify + atomic swap is all this path needs.
    _stage="$TMPDIR_OG/prebuilt-bundle-stage"
    rm -rf "$_stage"
    mkdir -p "$_stage" || die 2 "cannot create the staging dir"
    # ditto/unzip both ship with macOS; the archive's root entry is the .app dir.
    if command -v ditto >/dev/null 2>&1; then
      ditto -x -k "$_zip" "$_stage" || die 3 "failed to extract the app bundle"
    else
      unzip -oq "$_zip" -d "$_stage" || die 3 "failed to extract the app bundle"
    fi
    _staged_app="$_stage/$OPENGENI_APP_NAME.app"
    [ -d "$_staged_app" ] || die 3 "the archive did not contain \"$OPENGENI_APP_NAME.app\""
    if command -v xattr >/dev/null 2>&1; then
      xattr -cr "$_staged_app" 2>/dev/null || true
    fi
    if command -v codesign >/dev/null 2>&1; then
      codesign --verify --strict "$_staged_app" >/dev/null 2>&1 \
        || die 2 "codesign --verify --strict FAILED for the prebuilt bundle; not installing"
    fi
    mkdir -p "$_apps" || die 2 "cannot create $_apps"
    macos_swap_bundle_into_place "$_staged_app" "$_app"
    log "installed notarized app bundle at $_app"
  fi
  link_macos_cli "$_app" "$_install_dir"
}

main() {
  asset="$(detect_asset)"
  TMPDIR_OG="$(mktemp -d 2>/dev/null || mktemp -d -t opengeni)"
  os="$(uname -s)"

  # macOS: prefer a prebuilt Developer-ID + notarized bundle when the release serves
  # one — its TCC grants survive updates. Absent today (Apple secrets unset) → fall
  # through to the bare-binary download + local ad-hoc bundle assembly below.
  if [ "$os" = "Darwin" ] && bundle_asset_available; then
    log "prebuilt macOS bundle available; installing it (version: $VERSION) from $BASE_URL"
    install_dir="$(resolve_install_dir)"
    dest="$(install_macos_prebuilt_bundle "$install_dir")"
    path_hint "$install_dir"
    finish "$dest"
    return 0
  fi

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

  install_dir="$(resolve_install_dir)"
  if [ "$os" = "Darwin" ]; then
    # macOS: install the verified binary INSIDE an ad-hoc-signed app bundle and make
    # the CLI a symlink into it, so CLI + background app share ONE code-signing
    # identity (the anchor TCC grants attach to). See install_macos_local_bundle.
    dest="$(install_macos_local_bundle "$bin_tmp" "$install_dir")"
  else
    # Linux: atomic install — chmod then rename into place so a re-install never
    # leaves a half-written binary on PATH.
    mkdir -p "$install_dir" 2>/dev/null || die 2 "cannot create install dir $install_dir"
    dest="$install_dir/opengeni-agent"
    chmod 0755 "$bin_tmp"
    mv -f "$bin_tmp" "$dest" || die 2 "cannot install to $dest (try OPENGENI_SYSTEM=1 with sudo, or set OPENGENI_INSTALL_DIR)"
    log "installed verified binary to $dest"
  fi

  path_hint "$install_dir"
  finish "$dest"
}

# PATH hint (the current shell is not refreshed by an install).
path_hint() {
  _install_dir="$1"
  case ":${PATH}:" in
    *":$_install_dir:"*) : ;;
    *) log "NOTE: add $_install_dir to your PATH:  export PATH=\"$_install_dir:\$PATH\"" ;;
  esac
}

# Print the enroll+run instructions, or — in CI mode — enroll non-interactively.
# Per §23.0 the installer NEVER installs a service and only starts a foreground
# run when explicitly asked on an interactive TTY.
finish() {
  _bin="$1"
  echo ""
  if [ -n "${OPENGENI_ENROLL_TOKEN:-}" ]; then
    log "non-interactive enroll (OPENGENI_ENROLL_TOKEN set)"
    # Forward OPENGENI_API_URL explicitly so the exchange targets THIS deployment
    # (not a retired separate API host) even when the agent's env-inherit path is
    # ever bypassed. The agent also reads $OPENGENI_API_URL via clap, so the env
    # alone would suffice — this is belt-and-suspenders. The workspace is encoded
    # in the token, so no --workspace-id is needed on this path.
    if [ -n "${OPENGENI_API_URL:-}" ]; then
      "$_bin" --api-url "$OPENGENI_API_URL" enroll --token "$OPENGENI_ENROLL_TOKEN" --non-interactive
    else
      "$_bin" enroll --token "$OPENGENI_ENROLL_TOKEN" --non-interactive
    fi
    log "enrolled. Start the agent (foreground) with:  $_bin run"
    return 0
  fi

  # Concise post-install: at most 3 short lines, one clear next command. The
  # always-on service + uninstall hints fold into a single `--help` pointer.
  #
  # The interactive device-flow enroll needs the workspace id (and, for a
  # non-default deployment, the api url). When this ran as `curl | sh`, those env
  # vars existed ONLY for this piped process — they do NOT survive into the user's
  # shell, and the pipe has no TTY so we cannot enroll here. So a bare `enroll`
  # they paste later would fail with "enrollment requires a workspace id". When we
  # know them, bake them into the printed command so the copy-paste is correct;
  # otherwise the single next step is exactly `opengeni-agent enroll`.
  _enroll_env=""
  if [ -n "${OPENGENI_WORKSPACE_ID:-}" ]; then
    _enroll_env="OPENGENI_WORKSPACE_ID=$OPENGENI_WORKSPACE_ID"
  fi
  if [ -n "${OPENGENI_API_URL:-}" ]; then
    if [ -n "$_enroll_env" ]; then
      _enroll_env="$_enroll_env OPENGENI_API_URL=$OPENGENI_API_URL"
    else
      _enroll_env="OPENGENI_API_URL=$OPENGENI_API_URL"
    fi
  fi
  printf '%s\n' "opengeni-agent installed."
  if [ -n "$_enroll_env" ]; then
    printf '%s\n' "Next: $_enroll_env $_bin enroll   (then: $_bin run)"
  else
    printf '%s\n' "Next: $_bin enroll   (then: $_bin run)"
  fi
  printf '%s\n' "Always-on service, uninstall, and more: $_bin --help"

  # Only auto-start a foreground run when on a real TTY and not opted out.
  if [ "${OPENGENI_NO_RUN:-0}" != "1" ] && [ -t 0 ]; then
    printf '%s\n' ""
    log "starting a foreground run (Ctrl-C to stop; set OPENGENI_NO_RUN=1 to skip)"
    exec "$_bin" run
  fi
}

# Run the installer — UNLESS sourced with OPENGENI_INSTALL_LIB=1, which lets the
# darwin bundle-assembly simulation (agent/install/test/macos-bundle-sim.sh) load
# these helper functions and exercise them with mocked codesign/security/xattr,
# without the network download + real install. A normal `curl … | sh` never sets it.
if [ "${OPENGENI_INSTALL_LIB:-0}" != "1" ]; then
  main "$@"
fi
