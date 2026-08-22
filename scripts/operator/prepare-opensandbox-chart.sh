#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lock_file="$repo_root/deploy/stacks/opensandbox-source.lock"
out_dir="${1:-$repo_root/.agent/generated/opensandbox}"

# shellcheck disable=SC1090
source "$lock_file"

command -v curl >/dev/null
command -v helm >/dev/null
command -v sha256sum >/dev/null

mkdir -p "$out_dir"
archive="$out_dir/opensandbox-${OPENSANDBOX_SOURCE_SHA}.tar.gz"
source_dir="$out_dir/source"
chart_archive="$out_dir/opensandbox-0.2.0.tgz"

curl -fsSL "https://codeload.github.com/opensandbox-group/OpenSandbox/tar.gz/${OPENSANDBOX_SOURCE_SHA}" -o "$archive"
printf '%s  %s\n' "$OPENSANDBOX_SOURCE_ARCHIVE_SHA256" "$archive" | sha256sum -c - >&2

rm -rf "$source_dir"
mkdir -p "$source_dir"
tar -xzf "$archive" -C "$source_dir" --strip-components=1

chart_dir="$source_dir/kubernetes/charts/opensandbox"
rm -rf "$chart_dir/charts"
mkdir -p "$chart_dir/charts"
cp -a "$source_dir/kubernetes/charts/opensandbox-controller" "$chart_dir/charts/opensandbox-controller"
cp -a "$source_dir/kubernetes/charts/opensandbox-server" "$chart_dir/charts/opensandbox-server"
cp -a "$source_dir/kubernetes/charts/opensandbox-node-agent" "$chart_dir/charts/opensandbox-node-agent"

printf '%s  %s\n' "$OPENSANDBOX_BATCHSANDBOX_CRD_SHA256" "$source_dir/kubernetes/charts/opensandbox-controller/templates/crds/batchsandboxes.yaml" | sha256sum -c - >&2
printf '%s  %s\n' "$OPENSANDBOX_POOL_CRD_SHA256" "$source_dir/kubernetes/charts/opensandbox-controller/templates/crds/pools.yaml" | sha256sum -c - >&2
printf '%s  %s\n' "$OPENSANDBOX_SNAPSHOT_CRD_SHA256" "$source_dir/kubernetes/charts/opensandbox-controller/templates/crds/sandboxsnapshots.yaml" | sha256sum -c - >&2

helm lint "$chart_dir" >&2
rm -f "$chart_archive"
tar \
  --sort=name \
  --mtime="UTC 1970-01-01" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -C "$(dirname "$chart_dir")" \
  -cf - \
  opensandbox | gzip -n > "$chart_archive"
printf '%s  %s\n' "$OPENSANDBOX_PACKAGED_CHART_SHA256" "$chart_archive" | sha256sum -c - >&2

printf '%s\n' "$chart_archive"