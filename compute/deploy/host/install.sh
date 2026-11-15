#!/usr/bin/env bash
# Installs or upgrades the compute host agent from this bundle, on a
# systemd Linux machine with KVM (Ubuntu 24.04 and Debian 13 are tested).
# Run as root from the unpacked bundle:
#
#   ./install.sh --config host.env [--authority ca.pem] [--state-device /dev/nvme0n1]
#                [--reformat-state-device DEV] [--units-installed] [--no-start]
#
#   --config FILE        the host's configuration (see host.env.example),
#                        installed as /etc/compute/host.env; without it the
#                        installed one is kept
#   --authority FILE     the hosts' authority (ca.crt of the control
#                        service's hosts TLS Secret), installed as
#                        /etc/compute/ca.pem unless the host has one already:
#                        its renewals keep that one current
#   --state-device DEV   mount DEV at /var/lib/compute as the state volume,
#                        unless a state volume is already recorded for this
#                        host: a file system on DEV is kept (the state
#                        volume of a host whose boot disk was rebuilt), and
#                        only a blank DEV is formatted (XFS); without it
#                        /var/lib/compute must already be a mount point
#   --reformat-state-device DEV
#                        format DEV as a new, empty state volume even though
#                        it holds a file system or other data, all of which
#                        is lost; /var/lib/compute must not be mounted
#   --units-installed    the machine's own configuration installs this
#                        bundle's systemd units and enables them, as NixOS
#                        does from the unit files of the bundle it names:
#                        install.sh checks that the units in place are this
#                        bundle's (with the shared machine's drop-in where
#                        COMPUTE_MACHINE=shared) and does not write them
#   --no-start           install and check, but leave the services alone,
#                        and get no certificate
#
# What it does, each step only when not done already:
#   (what is "done" is checked by content, never by a file being there: a
#   machine reset during or just after an install can leave the files it
#   wrote in place but empty, so a run again repairs whatever is not whole;
#   and every file it writes reaches the disk before it takes its name)
#   - checks this bundle against its SHA256SUMS
#   - installs the packages the agent runs (iproute2, nftables, e2fsprogs,
#     xfsprogs, rsync) and its certificate script needs (curl, jq, openssl)
#   - installs this release under /opt/compute/releases/<version>, checks
#     that its agent binary runs on this host, and points
#     /opt/compute/current at it
#   - downloads the Firecracker release, jailer and guest kernel that
#     pins.env names, checking each SHA-256, under /opt/compute; Firecracker
#     binaries of earlier releases stay, and the agent keeps running memory
#     images they made (--retained-firecracker)
#   - sets up the state volume (state-volume) and records its filesystem
#     UUID, which the agent checks at every start, on the boot disk and on
#     the volume itself
#   - builds the base image from COMPUTE_BASE_IMAGE_REF into
#     /var/lib/compute/base.ext4
#   - installs the systemd units and the certificate's daily timer, gets
#     the host its certificate from the control service if it has none
#     current (compute-host-certificate), then starts the setup and the
#     guard if they are not running, and restarts the agent unless it runs
#     all of this already (agent-inputs)
#   - on a machine the host shares (COMPUTE_MACHINE=shared in host.env,
#     ADR 26), installs the guard's settings for it: systemd's watchdog of
#     the guard's service instead of the machine's, and the stop hook that
#     kills the VMs
#
# An upgrade is the same command with a newer bundle. Restarting the agent
# leaves its VMs running (ADR 9); a guard running another binary is handed
# over to this one's, which picks up the watchdog well inside its timeout.
# See docs/operations.md.
#
# COMPUTE_ETC, COMPUTE_OPT, COMPUTE_VAR, COMPUTE_UNITS, COMPUTE_DEV and
# COMPUTE_RUN (tests) stand for /etc/compute, /opt/compute,
# /var/lib/compute, /etc/systemd/system, /dev and /run.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
etc=${COMPUTE_ETC:-/etc/compute}
opt=${COMPUTE_OPT:-/opt/compute}
var=${COMPUTE_VAR:-/var/lib/compute}
unit_dir=${COMPUTE_UNITS:-/etc/systemd/system}
config=
authority=
state_device=
reformat_device=
units_installed=
start=1
while [ $# -gt 0 ]; do
  case "$1" in
    --config) config=$2; shift 2 ;;
    --authority) authority=$2; shift 2 ;;
    --state-device) state_device=$2; shift 2 ;;
    --reformat-state-device) reformat_device=$2; shift 2 ;;
    --units-installed) units_installed=1; shift ;;
    --no-start) start=; shift ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

log() { printf '[compute-install %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { echo "install.sh: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "run as root"
[ "$(uname -m)" = x86_64 ] || fail "compute hosts are x86_64 only"
[ -c "${COMPUTE_DEV:-/dev}/kvm" ] || fail "/dev/kvm is missing: the machine needs KVM (bare metal or nested virtualization)"
[ -d "${COMPUTE_RUN:-/run}/systemd/system" ] || fail "systemd is not running"

# put PART FINAL: gives PART, a file, link or directory written in full,
# the name FINAL in one rename, durably: what PART holds reaches the disk
# before the rename does, and the rename before this returns. File systems
# write names ahead of data, so without this a reset can leave FINAL with
# its new name on files it emptied; with it, FINAL is as it was or whole.
# A directory FINAL must be gone first.
put() {
  find "$1" -exec sync -- {} +
  mv -T -- "$1" "$2"
  sync -- "$(dirname -- "$2")"
}

# install_file MODE SOURCE TARGET: installs SOURCE as TARGET with MODE (as
# 644), durably, unless TARGET has that content and mode already.
install_file() {
  if cmp -s "$2" "$3" && [ "$(stat -c %a "$3")" = "$1" ]; then
    return 0
  fi
  rm -f "$3.part"
  install -m "$1" "$2" "$3.part"
  put "$3.part" "$3"
}

log "checking the bundle"
(cd "$here" && sha256sum -c --quiet --strict SHA256SUMS) || fail "the bundle does not match its SHA256SUMS"
version=$(cat "$here/VERSION")
# shellcheck source=pins.env
source "$here/pins.env"

# fetch URL FILE SHA256: downloads URL to FILE, failing unless it has that
# SHA-256.
fetch() {
  rm -f "$2.part"
  curl -fsSL --retry 5 -o "$2.part" "$1"
  if ! echo "$3  $2.part" | sha256sum -c --quiet -; then
    rm -f "$2.part"
    fail "$1 does not have the pinned SHA-256 $3"
  fi
  put "$2.part" "$2"
}

# has FILE SHA256: whether FILE is whole, with that SHA-256.
has() { echo "$2  $1" | sha256sum -c --quiet --status - 2>/dev/null; }

log "packages"
missing=
for tool in ip:iproute2 nft:nftables mkfs.ext4:e2fsprogs e2fsck:e2fsprogs mkfs.xfs:xfsprogs curl:curl findmnt:util-linux flock:util-linux \
  jq:jq openssl:openssl rsync:rsync; do
  command -v "${tool%%:*}" >/dev/null || missing="$missing ${tool#*:}"
done
if [ -n "$missing" ]; then
  command -v apt-get >/dev/null || fail "install these packages first:$missing"
  apt-get update -qq
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $missing ca-certificates >/dev/null
fi

log "release $version"
release=$opt/releases/$version
release_programs="compute-host check-host host-setup compute-host-certificate agent-inputs"
release_data="pins.env VERSION SHA256SUMS"
# Whether the release holds each of the bundle's files it is made of, as
# they are in the bundle.
release_intact() {
  local file
  for file in $release_programs $release_data; do
    cmp -s "$here/$file" "$release/$file" || return 1
  done
  for file in "$here"/guest/*; do
    cmp -s "$file" "$release/guest/${file##*/}" || return 1
  done
}
if ! release_intact; then
  rm -rf "$release.part"
  install -d -m 755 "$release.part" "$release.part/guest"
  # shellcheck disable=SC2086
  (cd "$here" && install -m 755 $release_programs "$release.part/" && install -m 644 $release_data "$release.part/")
  install -m 755 "$here"/guest/* "$release.part/guest/"
  # A running agent or guard keeps the files it started from.
  rm -rf "$release"
  put "$release.part" "$release"
fi
# A binary that cannot run here (built for another C library or processor,
# or damaged) must be refused before anything starts it: the guard handed
# over to it below would not start, and the watchdog would reset the host,
# ending every VM on it.
"$release/compute-host" --help >/dev/null 2>&1 ||
  fail "$release/compute-host does not run on this host; the running release is left as it is"
if [ "$(readlink "$opt/current" || true)" != "$release" ]; then
  ln -sfn "$release" "$opt/current.part"
  put "$opt/current.part" "$opt/current"
fi

log "firecracker $FC_VERSION"
fc=$opt/firecracker/$FC_VERSION
# Whether $fc holds the pinned release's firecracker and jailer, whole:
# their SHA-256s, recorded once its download was checked, still match.
# (Directories that earlier installs wrote have no record; they are
# downloaded again, once.)
fc_intact() {
  [ "$(awk '{ print $2 }' "$fc/SHA256SUMS" 2>/dev/null | tr '\n' ' ')" = "firecracker jailer " ] &&
    (cd "$fc" && sha256sum -c --quiet --strict SHA256SUMS >/dev/null 2>&1)
}
if ! fc_intact; then
  # One fixed place, emptied first, so failed attempts leave at most one
  # partial download behind.
  work=$opt/firecracker/.download
  rm -rf "$work" "$fc.part"
  install -d -m 700 "$work"
  fetch "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz" \
    "$work/firecracker.tgz" "$FC_SHA256_X86_64"
  tar -xzf "$work/firecracker.tgz" -C "$work"
  install -d -m 755 "$fc.part"
  install -m 755 "$work/release-$FC_VERSION-x86_64/firecracker-$FC_VERSION-x86_64" "$fc.part/firecracker"
  install -m 755 "$work/release-$FC_VERSION-x86_64/jailer-$FC_VERSION-x86_64" "$fc.part/jailer"
  (cd "$fc.part" && sha256sum firecracker jailer >SHA256SUMS)
  # VMs running keep the binaries they started from.
  rm -rf "$fc"
  put "$fc.part" "$fc"
  rm -rf "$work"
fi
retained=
for old in "$opt"/firecracker/*/firecracker; do
  case "$old" in
    "$fc/firecracker" | *.part/firecracker) ;;
    *) retained="$retained --retained-firecracker $old" ;;
  esac
done

log "guest kernel $GUEST_KERNEL"
kernel=$opt/kernel/$GUEST_KERNEL
install -d -m 755 "$opt/kernel"
has "$kernel" "$GUEST_KERNEL_SHA256" ||
  fetch "$GUEST_ARTIFACTS/$GUEST_KERNEL" "$kernel" "$GUEST_KERNEL_SHA256"
has "$kernel.config" "$GUEST_KERNEL_CONFIG_SHA256" ||
  fetch "$GUEST_ARTIFACTS/$GUEST_KERNEL.config" "$kernel.config" "$GUEST_KERNEL_CONFIG_SHA256"

install -d -m 700 "$etc"
cat >"$etc/installed.env.part" <<ENV
# Written by install.sh of release $version; do not edit.
COMPUTE_VERSION=$version
COMPUTE_FIRECRACKER=$fc/firecracker
COMPUTE_JAILER=$fc/jailer
COMPUTE_RETAINED_FIRECRACKER=${retained# }
COMPUTE_KERNEL=$kernel
ENV
if cmp -s "$etc/installed.env.part" "$etc/installed.env"; then
  rm -f "$etc/installed.env.part"
else
  put "$etc/installed.env.part" "$etc/installed.env"
fi
if [ -n "$config" ]; then
  install_file 600 "$config" "$etc/host.env"
fi
[ -s "$etc/host.env" ] || fail "no /etc/compute/host.env, or an empty one: pass --config (see host.env.example)"
if [ -n "$authority" ] && [ ! -s "$etc/ca.pem" ]; then
  install_file 644 "$authority" "$etc/ca.pem"
fi
# shellcheck source=host.env.example
source "$etc/host.env"

log "state volume"
"$here/state-volume" ${state_device:+--device "$state_device"} ${reformat_device:+--reformat "$reformat_device"}

log "base image ${COMPUTE_BASE_IMAGE_REF:?COMPUTE_BASE_IMAGE_REF is not set}"
# The base image is the OCI image with the bundle's guest programs (init,
# envd, bash) put in, so it is built again when either changes.
guest_digest=$(cd "$opt/current/guest" && find . -type f -print0 | LC_ALL=C sort -z |
  xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
base_id="$COMPUTE_BASE_IMAGE_REF guest-sha256:$guest_digest"
# base.ref names the image only once the image is on the disk, so a
# matching base.ref vouches for it.
if [ "$(cat "$var/base.ref" 2>/dev/null)" != "$base_id" ] || [ ! -s "$var/base.ext4" ]; then
  rm -f "$var/base.ext4.part" "$var/base.ref.part"
  "$opt/current/compute-host" build-image "$COMPUTE_BASE_IMAGE_REF" \
    --guest "$opt/current/guest" --output "$var/base.ext4.part"
  # A running agent keeps the base image it opened; the new one is used
  # from its next start.
  put "$var/base.ext4.part" "$var/base.ext4"
  echo "$base_id" >"$var/base.ref.part"
  put "$var/base.ref.part" "$var/base.ref"
fi

units="compute-host-setup.service compute-guard.service compute-host.service
  compute-host-certificate.service compute-host-certificate.timer"
machine=${COMPUTE_MACHINE:-dedicated}
case "$machine" in
  dedicated | shared) ;;
  *) fail "COMPUTE_MACHINE must be dedicated or shared, not $machine" ;;
esac
if [ -n "$units_installed" ]; then
  log "systemd units, as the machine's configuration installs them"
  systemctl daemon-reload
  for unit in $units; do
    fragment=$(systemctl show -p FragmentPath --value "$unit")
    if [ -z "$fragment" ] || ! cmp -s "$here/$unit" "$fragment"; then
      fail "$unit is not this bundle's unit${fragment:+ ($fragment differs)}: the machine's configuration installs the units of the bundle it runs"
    fi
  done
  # The shared machine's drop-in is in place exactly where this is one.
  shared_dropin=
  for dropin in $(systemctl show -p DropInPaths --value compute-guard.service); do
    cmp -s "$here/compute-guard-shared.conf" "$dropin" && shared_dropin=$dropin
  done
  case "$machine:$shared_dropin" in
    shared:) fail "compute-guard.service has no drop-in of this bundle's compute-guard-shared.conf on this shared machine" ;;
    dedicated:?*) fail "compute-guard.service has the shared machine's drop-in ($shared_dropin) on a dedicated one" ;;
  esac
else
  log "systemd units"
  # Each unit is written again unless it is this bundle's already: one a
  # reset left empty, which systemd takes as masked, is put right.
  for unit in $units; do
    install_file 644 "$here/$unit" "$unit_dir/$unit"
  done
  case "$machine" in
    shared)
      install -d -m 755 "$unit_dir/compute-guard.service.d"
      install_file 644 "$here/compute-guard-shared.conf" \
        "$unit_dir/compute-guard.service.d/shared-machine.conf"
      ;;
    dedicated) rm -f "$unit_dir/compute-guard.service.d/shared-machine.conf" ;;
  esac
  # Releases before the control service issued certificates renewed them
  # with a script of their own.
  rm -f /usr/local/sbin/compute-host-certificate
  systemctl daemon-reload
  systemctl enable -q compute-host-setup.service compute-guard.service compute-host.service \
    compute-host-certificate.timer
  # The links enabling them, and anything removed above, on the disk too.
  sync -f -- "$unit_dir"
fi

if [ -n "$start" ]; then
  log "certificate"
  "$opt/current/compute-host-certificate"
  systemctl start compute-host-certificate.timer
  systemctl start compute-host-setup.service
  # The guard runs the binary it was started from, so one running any
  # other file, of another release or replaced in this one, is handed over
  # to this one's by restarting it, once systemd keeps its watchdog open
  # (see compute-guard.service): the new guard takes it over. A guard of a
  # release before that store closes the watchdog as it ends, which feeds
  # it at whatever moment that is, so it runs on until the host starts
  # again or is replaced. Files are told apart by device and inode, which a
  # replaced binary's path does not change. The agent, restarted with the
  # guard, joins once the new guard is ready. On a shared machine the guard
  # feeds systemd's watchdog, and the hand-over is marked first, so that
  # the guard's stop hook leaves the VMs to the new guard (ADR 26).
  if ! systemctl is-active -q compute-guard.service; then
    systemctl start compute-guard.service
  else
    guard_pid=$(systemctl show -p MainPID --value compute-guard.service)
    guard_runs=$(stat -L -c %d:%i "/proc/$guard_pid/exe" 2>/dev/null || true)
    if [ "$guard_runs" != "$(stat -L -c %d:%i "$opt/current/compute-host")" ]; then
      if [ "$machine" = shared ]; then
        log "handing the guard over to release $version"
        "$opt/current/compute-host" hand-over-guard
      elif [ "$(systemctl show -p NFileDescriptorStore --value compute-guard.service)" -ge 1 ] 2>/dev/null; then
        log "handing the guard over to release $version"
        systemctl restart compute-guard.service
      else
        log "the guard of an earlier release keeps the watchdog itself: it runs on until the host starts again or is replaced"
      fi
    fi
  fi
  # An agent already running all of this, as the one systemd started at
  # boot before a startup script installed again, is left running: a
  # restart would only stop its lease renewals and cut short the wakes it
  # started (see agent-inputs).
  restarted=no
  if why=$("$opt/current/agent-inputs" current); then
    log "the agent runs release $version as installed already"
  else
    log "restarting the agent: ${why:-what it runs is not known}"
    systemctl restart compute-host.service
    restarted=yes
  fi
  # An agent left running that does not answer is restarted once, as an
  # install always did before.
  for _ in 1 2; do
    for _ in $(seq 60); do
      if "$opt/current/compute-host" status >/dev/null 2>&1; then
        log "the agent of release $version is up"
        exit 0
      fi
      sleep 1
    done
    [ "$restarted" = no ] || break
    log "the agent left running did not answer within a minute; restarting it"
    systemctl restart compute-host.service
    restarted=yes
  done
  journalctl -u compute-host.service -n 50 --no-pager >&2 || true
  fail "the agent did not answer within a minute"
fi
log "installed release $version; not started (--no-start)"
