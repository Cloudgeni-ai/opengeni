#!/usr/bin/env bash
# Builds and pushes the GKE side's sandbox image from the lab guest's root
# filesystem, so both systems run the same files.
#
# Usage: image.sh ROOTFS_TAR IMAGE
#   ROOTFS_TAR  a tar (optionally zstd) of base.ext4's files, made on the lab
#               host with: sudo tar -C <mounted base.ext4> -c . | zstd
#   IMAGE       where to push, such as REGION-docker.pkg.dev/PROJECT/REPO/guest:TAG
#
# Needs docker, logged in to the registry, and curl.
set -euo pipefail

rootfs="${1:?usage: image.sh ROOTFS_TAR IMAGE}"
image="${2:?usage: image.sh ROOTFS_TAR IMAGE}"
here="$(cd "$(dirname "$0")" && pwd)"
# Agent Sandbox's runtime server at the release the benchmark used.
runtime_ref="${RUNTIME_REF:-v1.0.7}"

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
cp "$here/Dockerfile" "$context/"
curl -fsSL -o "$context/main.py" \
  "https://raw.githubusercontent.com/kubernetes-sigs/agent-sandbox/${runtime_ref}/examples/python-runtime-sandbox/main.py"

# The lab image points resolv.conf at the kernel's boot-time answer; a pod
# gets its own from the kubelet, mounted over a plain file.
case "$rootfs" in
  *.zst) zstd -dc "$rootfs" ;;
  *) cat "$rootfs" ;;
esac | tar --delete -f - ./etc/resolv.conf | docker import - compare-guest-base:local
docker build --build-arg BASE=compare-guest-base:local -t "$image" "$context"
docker push "$image"
docker inspect --format '{{index .RepoDigests 0}}' "$image"
