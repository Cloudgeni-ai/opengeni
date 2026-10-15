#!/bin/sh
# Install or update the Opengeni desktop app on macOS or Linux.
#
#   curl -fsSL https://<your-opengeni-server>/desktop/install.sh | sh
#
# macOS: installs Opengeni.app into /Applications (or ~/Applications when
# /Applications isn't writable) and opens it.
# Linux: installs the .deb with apt or the .rpm with dnf, yum or zypper (these
# ask for your password), otherwise the AppImage into ~/Applications.
#
# Every download is checked against the release's SHA256SUMS. On macOS the app
# must also pass Apple's signature and notarization checks.
#
# Options, as environment variables:
#   OPENGENI_DESKTOP_VERSION=1.2.3       install this version instead of the newest
#   OPENGENI_DESKTOP_FORMAT=appimage     Linux only: deb, rpm or appimage
#   OPENGENI_DESKTOP_NO_LAUNCH=1         don't open the app afterwards
set -eu

# Set to the server's own address when the server serves this script.
OPENGENI_DESKTOP_DEFAULT_BASE_URL=""
BASE_URL="${OPENGENI_DESKTOP_BASE_URL:-$OPENGENI_DESKTOP_DEFAULT_BASE_URL}"
REPOSITORY="${OPENGENI_DESKTOP_GITHUB_REPOSITORY:-Cloudgeni-ai/opengeni}"
VERSION="${OPENGENI_DESKTOP_VERSION:-}"
FORMAT="${OPENGENI_DESKTOP_FORMAT:-}"
NO_LAUNCH="${OPENGENI_DESKTOP_NO_LAUNCH:-}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Opengeni: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || fail "this installer needs $1."; }

case "$(uname -s)" in
Darwin) system=mac ;;
Linux) system=linux ;;
MINGW* | MSYS* | CYGWIN*) fail "on Windows, download the installer from https://github.com/$REPOSITORY/releases" ;;
*) fail "this installer is for macOS and Linux." ;;
esac
need curl

WORK="$(mktemp -d 2>/dev/null || mktemp -d -t opengeni-desktop)"
trap 'rm -rf "$WORK"' EXIT INT TERM

download() {
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1" || fail "couldn't download $1"
}

# The release folder: a pinned version, the version this server offers, or the
# newest desktop release on GitHub.
resolve_release() {
  if [ -n "$VERSION" ]; then
    RELEASE_URL="https://github.com/$REPOSITORY/releases/download/desktop-v$VERSION"
    return
  fi
  if [ -n "$BASE_URL" ]; then
    location="$(curl -fsS -o /dev/null -w '%{redirect_url}' "${BASE_URL%/}/desktop/latest/SHA256SUMS")" ||
      fail "couldn't reach $BASE_URL"
    case "$location" in
    https://*/desktop-v*/SHA256SUMS) ;;
    *) fail "$BASE_URL didn't offer a desktop release." ;;
    esac
    RELEASE_URL="${location%/SHA256SUMS}"
    VERSION="${RELEASE_URL##*/desktop-v}"
    return
  fi
  download "https://api.github.com/repos/$REPOSITORY/git/matching-refs/tags/desktop-v" "$WORK/tags.json"
  VERSION="$(tr -s ',{}' '\n' <"$WORK/tags.json" |
    sed -n 's|.*"ref": *"refs/tags/desktop-v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*|\1|p' |
    sort -t . -k 1,1n -k 2,2n -k 3,3n | tail -n 1)"
  [ -n "$VERSION" ] || fail "no desktop release is published yet."
  RELEASE_URL="https://github.com/$REPOSITORY/releases/download/desktop-v$VERSION"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# Download one release file into $WORK and check it against SHA256SUMS.
fetch_verified() {
  name="$1"
  download "$RELEASE_URL/SHA256SUMS" "$WORK/SHA256SUMS"
  expected="$(awk -v file="$name" '$2 == file { print $1 }' "$WORK/SHA256SUMS")"
  [ -n "$expected" ] || fail "$name isn't part of Opengeni $VERSION."
  say "Downloading Opengeni $VERSION..."
  download "$RELEASE_URL/$name" "$WORK/$name"
  [ "$(sha256_of "$WORK/$name")" = "$expected" ] || fail "$name didn't match its checksum, so nothing was installed."
}

# Run a command as root: directly when already root, otherwise through sudo,
# which asks for the password on the terminal even when this script is piped.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    need sudo
    sudo "$@"
  fi
}

install_mac() {
  name="Opengeni-$VERSION-mac.zip"
  fetch_verified "$name"
  ditto -x -k "$WORK/$name" "$WORK/unpacked" || fail "couldn't unpack $name."
  app="$WORK/unpacked/Opengeni.app"
  [ -d "$app" ] || fail "$name didn't contain Opengeni.app."
  codesign --verify --deep --strict "$app" 2>/dev/null ||
    fail "Opengeni.app's signature didn't verify, so nothing was installed."
  spctl --assess --type execute "$app" 2>/dev/null ||
    fail "macOS didn't accept Opengeni.app, so nothing was installed."

  # Keep an existing copy where it is; otherwise /Applications when writable.
  if [ -d "$HOME/Applications/Opengeni.app" ] && [ ! -d /Applications/Opengeni.app ]; then
    destination="$HOME/Applications"
  elif [ -w /Applications ]; then
    destination=/Applications
  else
    destination="$HOME/Applications"
  fi
  mkdir -p "$destination"

  # A running copy closes first and reopens below.
  if pgrep -xq Opengeni; then
    say "Closing Opengeni to update it..."
    osascript -e 'tell application id "ai.opengeni.desktop" to quit' >/dev/null 2>&1 || true
    tries=0
    while pgrep -xq Opengeni && [ "$tries" -lt 20 ]; do
      sleep 0.5
      tries=$((tries + 1))
    done
    if pgrep -xq Opengeni; then fail "Opengeni is still open. Quit it, then run this again."; fi
  fi

  target="$destination/Opengeni.app"
  rm -rf "$target.previous"
  if [ -d "$target" ]; then mv "$target" "$target.previous"; fi
  if ditto "$app" "$target"; then
    rm -rf "$target.previous"
  else
    rm -rf "$target"
    if [ -d "$target.previous" ]; then mv "$target.previous" "$target"; fi
    fail "couldn't copy Opengeni.app to $destination."
  fi
  say "Installed Opengeni $VERSION in $destination."
  if [ -z "$NO_LAUNCH" ]; then open "$target"; fi
}

linux_format() {
  if [ -n "$FORMAT" ]; then
    case "$FORMAT" in
    deb | rpm | appimage) printf '%s' "$FORMAT" ;;
    *) fail "OPENGENI_DESKTOP_FORMAT must be deb, rpm or appimage." ;;
    esac
  elif command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
    printf deb
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
    printf rpm
  else
    printf appimage
  fi
}

install_linux() {
  case "$(uname -m)" in
  x86_64 | amd64) appimage_arch=x86_64 deb_arch=amd64 rpm_arch=x86_64 ;;
  aarch64 | arm64) appimage_arch=arm64 deb_arch=arm64 rpm_arch=aarch64 ;;
  *) fail "Opengeni runs on x86_64 and arm64 Linux, not $(uname -m)." ;;
  esac
  format="$(linux_format)"
  case "$format" in
  deb)
    name="Opengeni-$VERSION-linux-$deb_arch.deb"
    fetch_verified "$name"
    # apt reads the file as an unprivileged user, and installs its dependencies.
    chmod 0755 "$WORK"
    chmod 0644 "$WORK/$name"
    as_root apt-get install -y "$WORK/$name"
    command_name=opengeni
    ;;
  rpm)
    name="Opengeni-$VERSION-linux-$rpm_arch.rpm"
    fetch_verified "$name"
    if command -v dnf >/dev/null 2>&1; then
      as_root dnf install -y "$WORK/$name"
    elif command -v zypper >/dev/null 2>&1; then
      as_root zypper --non-interactive install --allow-unsigned-rpm "$WORK/$name"
    else
      as_root yum install -y "$WORK/$name"
    fi
    command_name=opengeni
    ;;
  appimage)
    name="Opengeni-$VERSION-linux-$appimage_arch.AppImage"
    fetch_verified "$name"
    mkdir -p "$HOME/Applications"
    command_name="$HOME/Applications/Opengeni.AppImage"
    mv -f "$WORK/$name" "$command_name"
    chmod 0755 "$command_name"
    ;;
  esac
  say "Installed Opengeni $VERSION."
  # Opening it needs a desktop session; over SSH there's nothing to show.
  if [ -z "$NO_LAUNCH" ] && [ "$(id -u)" -ne 0 ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    nohup "$command_name" >/dev/null 2>&1 &
  else
    say "Open it from your app launcher, or run: $command_name"
  fi
}

resolve_release
if [ "$system" = mac ]; then install_mac; else install_linux; fi
