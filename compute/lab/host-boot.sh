#!/usr/bin/env bash
# The memory settings a lab host loses at every boot: swap on
# $LAB_DIR/swapfile with zswap in front of it, and no transparent huge
# pages. host-setup.sh runs this last; ci/gate.sh's lab-setup step runs it
# alone on a lab whose files are already prepared (CI restores them from
# its cache onto a fresh runner), since the tests that compress paused VMs
# refuse to start without zswap.
#
# Idempotent, and needs no package manager. Run as a login user with
# passwordless sudo:
#   [LAB_DIR=/lab] [SWAP_SIZE=4G] bash host-boot.sh
set -euo pipefail

LAB_DIR="${LAB_DIR:-/lab}"
# Empty: as large as the host's memory, but never more than a quarter of the
# space free where it goes, so the lab's disk keeps room for sandboxes and
# builds (a fixed 256G once filled a 300G disk).
SWAP_SIZE="${SWAP_SIZE:-}"

log() { printf '[host-boot %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

cd "$LAB_DIR"
log "swap and zswap"
if ! swapon --show=NAME --noheadings | grep "$LAB_DIR/swapfile" >/dev/null; then
  if [ ! -f swapfile ]; then
    if [ -z "$SWAP_SIZE" ]; then
      memory_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
      free_kib="$(df -Pk . | awk 'NR == 2 { print $4 }')"
      quarter_kib=$((free_kib / 4))
      SWAP_SIZE="$(( memory_kib < quarter_kib ? memory_kib : quarter_kib ))K"
    fi
    log "swap file of $SWAP_SIZE"
    sudo fallocate -l "$SWAP_SIZE" swapfile
    sudo chmod 600 swapfile
    sudo mkswap -q swapfile
  fi
  sudo swapon swapfile
fi
echo 1 | sudo tee /sys/module/zswap/parameters/enabled >/dev/null
echo zstd | sudo tee /sys/module/zswap/parameters/compressor >/dev/null || true
echo 40 | sudo tee /sys/module/zswap/parameters/max_pool_percent >/dev/null
# Keep the experiments' own memory decisions explicit: no transparent huge pages.
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled >/dev/null
log "zswap $(cat /sys/module/zswap/parameters/enabled) ($(cat /sys/module/zswap/parameters/compressor)), swap $(swapon --show=NAME,SIZE --noheadings | tr -s ' ' | paste -sd, -)"
