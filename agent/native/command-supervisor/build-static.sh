#!/bin/sh
# Shared source/flags/path contract for independently built desktop/API/worker
# artifacts. This script never executes the target ELF on the build host.
set -eu
test "$#" = 2 || { echo 'usage: build-static.sh SOURCE OUT_DIRECTORY' >&2; exit 1; }
source_file=$1
output_directory=$2
mkdir -p "$output_directory"
compiler=${CC:-musl-gcc}
"$compiler" -Os -static -fno-pie -no-pie -s -fno-ident -Wl,--build-id=none \
  -std=c11 -Wall -Wextra -Werror -Wformat=2 -Wshadow \
  "$source_file" -o "$output_directory/opengeni-command-supervisor"
artifact="$output_directory/opengeni-command-supervisor"
size=$(wc -c < "$artifact" | tr -d ' ')
test "$size" -ge 64 && test "$size" -le 262144
if readelf -l "$artifact" | grep -Eq 'INTERP|DYNAMIC'; then
  echo 'native command artifact must be static' >&2
  exit 1
fi
machine=$(od -An -tu2 -j18 -N2 "$artifact" | tr -d ' ')
case "$machine" in
  62) target=linux-amd64 ;;
  183) target=linux-arm64 ;;
  *) echo 'unsupported native command artifact target' >&2; exit 1 ;;
esac
source_hash=$(sha256sum "$source_file" | cut -d ' ' -f1)
artifact_hash=$(sha256sum "$artifact" | cut -d ' ' -f1)
cp "$source_file" "$output_directory/supervisor.c"
printf '{"version":1,"sourceFileSha256":"%s","artifactSha256":"%s","byteSize":%s,"target":"%s"}\n' \
  "$source_hash" "$artifact_hash" "$size" "$target" > "$output_directory/artifact.json"
chmod 0444 "$output_directory/supervisor.c" "$output_directory/artifact.json"
chmod 0555 "$artifact"
