#!/usr/bin/env bash
# OpenGeni canonical browser launcher — the SINGLE container-safe entrypoint for
# Chrome, shared by BOTH launch paths:
#   - the HUMAN path: XFCE panel/menu "Web Browser" -> exo-open --launch WebBrowser
#     -> (helpers.rc WebBrowser=opengeni-browser) -> this wrapper; AND the
#     debian x-www-browser alternative also points here.
#   - the AGENT computer-use path: launched the same way (one wrapper, one flag set).
#
# WHY a wrapper (the bug it fixes): the box runs as ROOT (uid=0). Google Chrome
# REFUSES to start as root without --no-sandbox ("Running as root without
# --no-sandbox is not supported", zygote_host_impl_linux.cc), exits 1, and exo
# surfaces its generic "Failed to execute default Web Browser. Input/output error."
# The stock debian-sensible-browser helper runs google-chrome-stable with NO flags,
# so the menu browser hard-fails. This wrapper supplies the container-safe flags so
# the human menu path launches reliably — exactly the flags proven live to load a page.
#
# Flags:
#   --no-sandbox            : MANDATORY — box runs as root; Chrome's setuid/zygote
#                             sandbox cannot initialize as uid 0 (single-tenant
#                             disposable sandbox, so dropping the sandbox is acceptable).
#   --disable-dev-shm-usage : Modal /dev/shm is tiny; force Chrome to use a temp dir
#                             instead of shared memory (avoids renderer crashes).
#   --disable-gpu           : headless Xvfb has no GPU; avoids GL init churn/spam.
#   --user-data-dir         : a FIXED, WRITABLE profile dir under /tmp (NOT /workspace)
#                             so the profile never trips an I/O error on the mounted
#                             /workspace and survives a HOME with odd perms.
#   --no-first-run / --no-default-browser-check : skip first-run UI nags in a kiosk box.
#
# OPENGENI_BROWSER_BIN lets the image point this at google-chrome-stable (amd64) or
# firefox-esr (arm64) without forking the script. Firefox ignores the Chrome flags
# it doesn't know, but it DOES need --no-remote/profile handling, so we branch.
set -euo pipefail

BIN="${OPENGENI_BROWSER_BIN:-/usr/bin/google-chrome-stable}"
# Resolve robustly across arch: if the configured binary isn't executable (e.g. an
# arm64 image that ships firefox-esr instead of chrome), fall back to whichever real
# browser IS present so the wrapper never dead-ends on a missing path.
if [ ! -x "$BIN" ]; then
  for cand in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/firefox-esr /usr/bin/firefox; do
    if [ -x "$cand" ]; then BIN="$cand"; break; fi
  done
fi

# A writable, per-box profile/cache root on /tmp (tmpfs/local — never the /workspace
# mount, which is where the I/O-error dialog came from). Created on every launch so a
# fresh box with no /tmp state still works; idempotent if it already exists.
PROFILE_DIR="${OPENGENI_BROWSER_PROFILE:-/tmp/opengeni-browser-profile}"
mkdir -p "$PROFILE_DIR" 2>/dev/null || true

# Quiet the GTK a11y bus warnings on every launch (org.a11y.Bus not provided).
export NO_AT_BRIDGE=1
export GTK_A11Y=none

case "$BIN" in
  *firefox*)
    exec "$BIN" --no-remote --profile "$PROFILE_DIR" "$@"
    ;;
  *)
    exec "$BIN" \
      --no-sandbox \
      --disable-dev-shm-usage \
      --disable-gpu \
      --no-first-run \
      --no-default-browser-check \
      --user-data-dir="$PROFILE_DIR" \
      "$@"
    ;;
esac
