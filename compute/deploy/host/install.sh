#!/usr/bin/env bash
# Installs or upgrades the compute host agent from this bundle, on a
# systemd Linux machine with KVM (Ubuntu 24.04 and Debian 13 are tested).
# Run as root from the unpacked bundle:
#
#   ./install.sh --config host.env [--authority ca.pem] [--state-device /dev/nvme0n1] [--no-start]
#
#   --config FILE        the host's configuration (see host.env.example),
#                        installed as /etc/compute/host.env; without it the
#                        installed one is kept
#   --authority FILE     the hosts' authority (ca.crt of the control
#                        service's hosts TLS Secret), installed as
#                        /etc/compute/ca.pem unless the host has one already:
#                        its renewals keep that one current
#   --state-device DEV   format DEV as the state volume (XFS) and mount it
#                        at /var/lib/compute, unless a state volume is
#                        already recorded for this host; without it
#                        /var/lib/compute must already be a mount point
#   --no-start           install and check, but leave the services alone,
#                        and get no certificate
#
# What it does, each step only when not done already:
#   - checks this bundle against its SHA256SUMS
#   - installs the packages the agent runs (iproute2, nftables, e2fsprogs,
#     xfsprogs) and its certificate script needs (curl, jq, openssl)
#   - installs this release under /opt/compute/releases/<version> and
#     points /opt/compute/current at it
#   - downloads the Firecracker release, jailer and guest kernel that
#     pins.env names, checking each SHA-256, under /opt/compute; Firecracker
#     binaries of earlier releases stay, and the agent keeps running memory
#     images they made (--retained-firecracker)
#   - records the state volume's filesystem UUID, which the agent checks at
#     every start
#   - builds the base image from COMPUTE_BASE_IMAGE_REF into
#     /var/lib/compute/base.ext4
#   - installs the systemd units and the certificate's daily timer, gets
#     the host its certificate from the control service if it has none
#     current (compute-host-certificate), then starts the setup and the
#     guard if they are not running, and restarts the agent
#
# An upgrade is the same command with a newer bundle. Restarting the agent
# leaves its VMs running (ADR 9); the guard is never restarted, because the
# watchdog resets the machine when it ends. See docs/operations.md.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config=
authority=
state_device=
start=1
while [ $# -gt 0 ]; do
  case "$1" in
    --config) config=$2; shift 2 ;;
    --authority) authority=$2; shift 2 ;;
    --state-device) state_device=$2; shift 2 ;;
    --no-start) start=; shift ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

log() { printf '[compute-install %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "install.sh: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "run as root"
[ "$(uname -m)" = x86_64 ] || fail "compute hosts are x86_64 only"
[ -c /dev/kvm ] || fail "/dev/kvm is missing: the machine needs KVM (bare metal or nested virtualization)"
[ -d /run/systemd/system ] || fail "systemd is not running"

log "checking the bundle"
(cd "$here" && sha256sum -c --quiet SHA256SUMS) || fail "the bundle does not match its SHA256SUMS"
version=$(cat "$here/VERSION")
# shellcheck source=pins.env
source "$here/pins.env"

# fetch URL FILE SHA256: downloads URL to FILE, failing unless it has that
# SHA-256.
fetch() {
  curl -fsSL --retry 5 -o "$2.part" "$1"
  if ! echo "$3  $2.part" | sha256sum -c --quiet -; then
    rm -f "$2.part"
    fail "$1 does not have the pinned SHA-256 $3"
  fi
  mv "$2.part" "$2"
}

log "packages"
missing=
for tool in ip:iproute2 nft:nftables mkfs.ext4:e2fsprogs mkfs.xfs:xfsprogs curl:curl findmnt:util-linux \
  jq:jq openssl:openssl; do
  command -v "${tool%%:*}" >/dev/null || missing="$missing ${tool#*:}"
done
if [ -n "$missing" ]; then
  command -v apt-get >/dev/null || fail "install these packages first:$missing"
  apt-get update -qq
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $missing ca-certificates >/dev/null
fi

log "release $version"
release=/opt/compute/releases/$version
if [ ! -x "$release/compute-host" ] || ! cmp -s "$here/compute-host" "$release/compute-host"; then
  rm -rf "$release.part"
  install -d -m 755 "$release.part" "$release.part/guest"
  install -m 755 "$here/compute-host" "$here/check-host" "$here/host-setup" \
    "$here/compute-host-certificate" "$release.part/"
  install -m 644 "$here/pins.env" "$here/VERSION" "$here/SHA256SUMS" "$release.part/"
  install -m 755 "$here"/guest/* "$release.part/guest/"
  rm -rf "$release"
  mv "$release.part" "$release"
fi
ln -sfn "$release" /opt/compute/current.part
mv -T /opt/compute/current.part /opt/compute/current

log "firecracker $FC_VERSION"
fc=/opt/compute/firecracker/$FC_VERSION
if [ ! -x "$fc/firecracker" ] || [ ! -x "$fc/jailer" ]; then
  # One fixed place, emptied first, so failed attempts leave at most one
  # partial download behind.
  work=/opt/compute/firecracker/.download
  rm -rf "$work"
  install -d -m 700 "$work"
  fetch "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz" \
    "$work/firecracker.tgz" "$FC_SHA256_X86_64"
  tar -xzf "$work/firecracker.tgz" -C "$work"
  install -d -m 755 "$fc"
  install -m 755 "$work/release-$FC_VERSION-x86_64/firecracker-$FC_VERSION-x86_64" "$fc/firecracker"
  install -m 755 "$work/release-$FC_VERSION-x86_64/jailer-$FC_VERSION-x86_64" "$fc/jailer"
  rm -rf "$work"
fi
retained=
for old in /opt/compute/firecracker/*/firecracker; do
  [ "$old" = "$fc/firecracker" ] || retained="$retained --retained-firecracker $old"
done

log "guest kernel $GUEST_KERNEL"
kernel=/opt/compute/kernel/$GUEST_KERNEL
if [ ! -f "$kernel" ]; then
  install -d -m 755 /opt/compute/kernel
  fetch "$GUEST_ARTIFACTS/$GUEST_KERNEL" "$kernel" "$GUEST_KERNEL_SHA256"
  fetch "$GUEST_ARTIFACTS/$GUEST_KERNEL.config" "$kernel.config" "$GUEST_KERNEL_CONFIG_SHA256"
fi

install -d -m 700 /etc/compute
cat >/etc/compute/installed.env.part <<ENV
# Written by install.sh of release $version; do not edit.
COMPUTE_VERSION=$version
COMPUTE_FIRECRACKER=$fc/firecracker
COMPUTE_JAILER=$fc/jailer
COMPUTE_RETAINED_FIRECRACKER=${retained# }
COMPUTE_KERNEL=$kernel
ENV
mv /etc/compute/installed.env.part /etc/compute/installed.env
if [ -n "$config" ]; then
  install -m 600 "$config" /etc/compute/host.env
fi
[ -f /etc/compute/host.env ] || fail "no /etc/compute/host.env: pass --config (see host.env.example)"
if [ -n "$authority" ] && [ ! -s /etc/compute/ca.pem ]; then
  install -m 644 "$authority" /etc/compute/ca.pem
fi
# shellcheck source=host.env.example
source /etc/compute/host.env

log "state volume"
install -d -m 755 /var/lib/compute
# The marker names the state volume this host uses. It is written whole
# (see below); one with no UUID in it, from an interrupted older write,
# counts as none (the GCP startup script uses the same test).
recorded=$(tr -d '[:space:]' 2>/dev/null </etc/compute/state-volume.uuid || true)
if [ -z "$recorded" ] && [ -n "$state_device" ]; then
  if mountpoint -q /var/lib/compute; then
    # An earlier attempt formatted and mounted this device but stopped
    # before recording it; anything else mounted there is refused.
    have=$(findmnt -no UUID /var/lib/compute || true)
    want=$(blkid -s UUID -o value "$state_device" 2>/dev/null || true)
    [ -n "$have" ] && [ "$have" = "$want" ] ||
      fail "/var/lib/compute is mounted already, not from $state_device; leave out --state-device"
  else
    mkfs.xfs -q -f -m reflink=1 "$state_device"
    uuid=$(blkid -s UUID -o value "$state_device")
    [ -n "$uuid" ] || fail "$state_device has no file system UUID after formatting"
    sed -i '\# /var/lib/compute #d' /etc/fstab
    echo "UUID=$uuid /var/lib/compute xfs noatime,nofail 0 2" >>/etc/fstab
    systemctl daemon-reload
    mount /var/lib/compute
  fi
fi
mountpoint -q /var/lib/compute || fail "/var/lib/compute is not a mount point: mount the state volume there, or pass --state-device"
mounted=$(findmnt -no UUID /var/lib/compute || true)
[ -n "$mounted" ] || fail "the file system on /var/lib/compute has no UUID; use one that has (XFS does)"
if [ -n "$recorded" ]; then
  [ "$recorded" = "$mounted" ] ||
    fail "/var/lib/compute holds $mounted, not the state volume $recorded recorded for this host"
else
  echo "$mounted" >/etc/compute/state-volume.uuid.part
  mv /etc/compute/state-volume.uuid.part /etc/compute/state-volume.uuid
fi
[ "$(findmnt -no FSTYPE /var/lib/compute)" = xfs ] ||
  log "warning: the state volume is not XFS; saves and clones copy instead of sharing extents"
install -d -m 700 /var/lib/compute/state

log "base image ${COMPUTE_BASE_IMAGE_REF:?COMPUTE_BASE_IMAGE_REF is not set}"
# The base image is the OCI image with the bundle's guest programs (init,
# envd, bash) put in, so it is built again when either changes.
guest_digest=$(cd /opt/compute/current/guest && find . -type f -print0 | LC_ALL=C sort -z |
  xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
base_id="$COMPUTE_BASE_IMAGE_REF guest-sha256:$guest_digest"
if [ "$(cat /var/lib/compute/base.ref 2>/dev/null)" != "$base_id" ] || [ ! -f /var/lib/compute/base.ext4 ]; then
  rm -f /var/lib/compute/base.ext4.part
  /opt/compute/current/compute-host build-image "$COMPUTE_BASE_IMAGE_REF" \
    --guest /opt/compute/current/guest --output /var/lib/compute/base.ext4.part
  # A running agent keeps the base image it opened; the new one is used
  # from its next start.
  mv /var/lib/compute/base.ext4.part /var/lib/compute/base.ext4
  echo "$base_id" >/var/lib/compute/base.ref
fi

log "systemd units"
for unit in compute-host-setup.service compute-guard.service compute-host.service \
  compute-host-certificate.service compute-host-certificate.timer; do
  install -m 644 "$here/$unit" "/etc/systemd/system/$unit"
done
# Releases before the control service issued certificates renewed them
# with a script of their own.
rm -f /usr/local/sbin/compute-host-certificate
systemctl daemon-reload
systemctl enable -q compute-host-setup.service compute-guard.service compute-host.service \
  compute-host-certificate.timer

if [ -n "$start" ]; then
  log "certificate"
  /opt/compute/current/compute-host-certificate
  systemctl start compute-host-certificate.timer
  systemctl start compute-host-setup.service
  # Started once, never restarted (see compute-guard.service).
  systemctl is-active -q compute-guard.service || systemctl start compute-guard.service
  systemctl restart compute-host.service
  for _ in $(seq 60); do
    if /opt/compute/current/compute-host status >/dev/null 2>&1; then
      log "the agent of release $version is up"
      exit 0
    fi
    sleep 1
  done
  journalctl -u compute-host.service -n 50 --no-pager >&2 || true
  fail "the agent did not answer within a minute"
fi
log "installed release $version; not started (--no-start)"
