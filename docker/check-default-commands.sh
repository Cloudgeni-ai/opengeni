#!/bin/sh
# The general commands every default Opengeni sandbox image ships: the headless
# image (docker/sandbox.Dockerfile, the compute and Docker default) and the
# desktop image (docker/desktop.Dockerfile, the Modal default and the compute
# desktop tier). Agents reach for these without checking first, so a missing
# one costs a wasted call. Both images run this as their last build step, so a
# command that goes missing fails the image build;
# scripts/sandbox-default-commands.test.ts keeps that step in place.
#
# Task-specific tools (database clients, cloud CLIs, kubectl, docker) are not
# listed: images may ship them, but this list is what every default box has.
#
#   check-default-commands.sh          check the image (presence, then behaviour)
#   check-default-commands.sh --list   print the expected commands, one per line
set -eu

DEFAULT_COMMANDS="
bash sh
bun bunx node npm npx
python python3 pip uv uvx
ogtool anydoc
git curl wget ssh jq rg
awk sed grep find xargs sort diff patch bc
tar gzip zip unzip
file strings xxd sha256sum base64 uuidgen
pdftotext pdfinfo
ps pgrep pkill free time
ip ss nc netstat
"

if [ "${1:-}" = "--list" ]; then
  for name in $DEFAULT_COMMANDS; do printf '%s\n' "$name"; done
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo "usage: check-default-commands.sh [--list]" >&2
  exit 2
fi

# The executable PATH resolves NAME to, ignoring shell builtins and keywords:
# `command -v time` answers "time" in bash even without GNU time installed.
# A dangling symlink does not count.
resolve() {
  saved_ifs=$IFS
  IFS=:
  set -f
  for dir in $PATH; do
    if [ -n "$dir" ] && [ -f "$dir/$1" ] && [ -x "$dir/$1" ]; then
      IFS=$saved_ifs
      set +f
      printf '%s\n' "$dir/$1"
      return 0
    fi
  done
  IFS=$saved_ifs
  set +f
  return 1
}

missing=""
for name in $DEFAULT_COMMANDS; do
  resolve "$name" >/dev/null || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "default sandbox commands missing from this image:$missing" >&2
  exit 1
fi

# Behaviour, where the name alone could be the wrong program.
fail() {
  echo "default sandbox command check failed: $*" >&2
  exit 1
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# bunx is Bun itself, started under that name.
[ "$(bunx --version)" = "$(bun --version)" ] || fail "bunx is not bun"
# npm and npx run on this image's node.
npm --version >/dev/null || fail "npm does not run"
npx --version >/dev/null || fail "npx does not run"
# GNU time, for `/usr/bin/time -v` resource reports.
"$(resolve time)" -v true 2>"$work/time" || fail "time -v does not run"
grep -q 'Maximum resident set size' "$work/time" || fail "time is not GNU time"
# zip and unzip agree on an archive.
printf 'opengeni\n' >"$work/member"
(cd "$work" && zip -q archive.zip member) || fail "zip does not write an archive"
[ "$(unzip -p "$work/archive.zip" member)" = opengeni ] || fail "unzip does not read zip's archive"
# binutils strings, xxd and file read bytes.
[ "$(printf 'opengeni\000' | strings)" = opengeni ] || fail "strings does not print strings"
[ "$(printf A | xxd -p)" = 41 ] || fail "xxd does not dump bytes"
file -b "$work/member" | grep -q text || fail "file does not identify a text file"
# iproute2's ss and ip.
ss -V >/dev/null || fail "ss does not run"
ip -V >/dev/null || fail "ip does not run"

echo "default sandbox commands: all $(printf '%s\n' $DEFAULT_COMMANDS | wc -l | tr -d ' ') present"
