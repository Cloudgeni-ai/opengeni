#!/usr/bin/env bash
# Read-only reproducibility manifest. No identity, IP, account or secret output.
set -euo pipefail
LAB_DIR="${LAB_DIR:-/lab}"
uname -srmo
lscpu
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
cat /proc/mdstat
for path in /proc/sys/vm/page-cluster /sys/module/zswap/parameters/compressor \
  /sys/kernel/mm/lru_gen/enabled /sys/kernel/mm/transparent_hugepage/enabled \
  /proc/sys/vm/nr_hugepages; do
  if [ -r "$path" ]; then printf '%s: ' "$path"; cat "$path"; fi
done
for binary in firecracker compute-pager cloud-hypervisor firecracker-prefault firecracker-prefault-gated; do
  if [ -f "$LAB_DIR/bin/$binary" ]; then sha256sum "$LAB_DIR/bin/$binary"; fi
done
sha256sum "$LAB_DIR/vmlinux" "$LAB_DIR/base.ext4"
