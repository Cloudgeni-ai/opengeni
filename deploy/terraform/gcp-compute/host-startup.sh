#!/usr/bin/env bash
# A compute host's startup script on Google Cloud, run as root at every
# boot from the instance template's metadata (main.tf). It runs the
# deployment's prelude if it has one, prepares the state volume, fetches and checks the host bundle the template names,
# writes /etc/compute/host.env and runs the bundle's install.sh with the
# hosts' authority from the metadata, which gets the host its certificate
# from the control service and starts the guard and the agent. A new
# bundle reaches a host when the host is replaced or rebooted with a
# template naming it, or when the operator runs its install.sh in place
# (operations.md, Upgrades).
#
# A host reset during or just after its install (as an instance group
# update may do) can come back with what the install wrote in place but
# empty, so nothing here is taken as done because a file is there: the
# bundle is checked whole before it is used, and fetched again when it is
# not, and install.sh repairs the rest.
#
# COMPUTE_ETC, COMPUTE_OPT and COMPUTE_VAR (tests) stand for /etc/compute,
# /opt/compute and /var/lib/compute; install.sh takes them too.
set -euo pipefail
export PATH=$PATH:/snap/bin
etc=${COMPUTE_ETC:-/etc/compute}
opt=${COMPUTE_OPT:-/opt/compute}
var=${COMPUTE_VAR:-/var/lib/compute}

meta() { curl -fsS -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/$1"; }
attr() { meta "instance/attributes/$1"; }
# Metadata that may be absent, such as an attribute the template leaves out:
# empty when the metadata server says it is not there, a failed attempt
# (tried again) on any other error, so a configured setting is never
# mistaken for an absent one.
optional_meta() {
  local body status
  body=$(mktemp)
  status=$(curl -sS -o "$body" -w '%{http_code}' -H Metadata-Flavor:Google \
    "http://metadata.google.internal/computeMetadata/v1/$1") || status=error
  case "$status" in
    200) cat "$body" ;;
    404) ;;
    *) rm -f "$body"; log "reading $1 failed ($status)" >&2; return 1 ;;
  esac
  rm -f "$body"
}
optional_attr() { optional_meta "instance/attributes/$1"; }
log() { echo "compute-startup: $*"; }

# put PART FINAL: gives PART, a file or directory written in full, the
# name FINAL in one rename, durably: what PART holds reaches the disk
# before the rename does, and the rename before this returns, so a reset
# leaves FINAL as it was or whole, never named but empty.
put() {
  find "$1" -exec sync -- {} +
  mv -T -- "$1" "$2"
  sync -- "$(dirname -- "$2")"
}

# Every step below is safe to run again, and several reach the network
# (the bundle's store, the control service, the base image's registry),
# so a failed attempt runs again, after a wait growing to five minutes, until the host is installed. A host whose one attempt failed
# would otherwise run without ever registering, and nothing would replace
# it: the instance group has no health check (main.tf).
if [ -z "${COMPUTE_STARTUP_ATTEMPT:-}" ]; then
  attempt=1 wait=15
  until COMPUTE_STARTUP_ATTEMPT=$attempt bash "$0"; do
    log "attempt $attempt failed; trying again in ${wait}s"
    sleep "$wait"
    attempt=$((attempt + 1)) wait=$((wait * 2 > 300 ? 300 : wait * 2))
  done
  exit 0
fi

# --- The deployment's own prelude (host_startup_prelude), such as joining
# an overlay network, before anything else reaches the network.
prelude=$(optional_attr compute-prelude)
if [ -n "$prelude" ]; then
  log "running the prelude"
  bash -euo pipefail -c "$prelude"
fi

NAME=$(meta instance/name)
# The instance's public address, if it has one (assign_external_ip). The
# cloud maps it onto the VPC address, so sandboxes could reach the host
# through it: the agent blocks it for them.
PUBLIC=$(optional_meta instance/network-interfaces/0/access-configs/0/external-ip)
# The address the control service dials: the VPC's, the public one
# (advertise_public_address), or that of the interface advertise_interface
# names once it has one.
interface=$(optional_attr compute-advertise)
advertise_public=$(optional_attr compute-advertise-public)
if [ "$advertise_public" = true ]; then
  [ -n "$PUBLIC" ] || { log "the instance has no public address to advertise"; exit 1; }
  ADDRESS=$PUBLIC
elif [ -n "$interface" ]; then
  ADDRESS=
  for _ in $(seq 120); do
    # Until the interface exists, ip fails; that is waited out too.
    ADDRESS=$({ ip -4 -o addr show dev "$interface" 2>/dev/null || true; } |
      awk '{ sub("/.*", "", $4); print $4; exit }')
    [ -n "$ADDRESS" ] && break
    sleep 1
  done
  [ -n "$ADDRESS" ] || { log "$interface has no IPv4 address"; exit 1; }
else
  ADDRESS=$(meta instance/network-interfaces/0/ip)
fi
ZONE=$(meta instance/zone)
ZONE=${ZONE##*/}
BUNDLE_URL=$(attr compute-bundle-url)
BUNDLE_SHA256=$(attr compute-bundle-sha256)

# --- The state volume: local NVMe SSDs, striped, or the "state" disk.
state_device=
# install.sh records the volume it set up; a record with no UUID in it
# is none (the same test as install.sh's). With no record, as on a first
# boot or on a host whose boot disk was rebuilt from a newer image while
# its state disk or SSDs kept their data, install.sh is given the device:
# it keeps a file system it finds there and formats only a blank device.
recorded=$(tr -d '[:space:]' 2>/dev/null <"$etc/state-volume.uuid" || true)
if [ -z "$recorded" ]; then
  mapfile -t nvme < <(ls /dev/disk/by-id/google-local-nvme-ssd-* 2>/dev/null || true)
  if [ "${#nvme[@]}" -eq 1 ]; then
    state_device=${nvme[0]}
  elif [ "${#nvme[@]}" -gt 1 ]; then
    state_device=/dev/md/compute-state
    # The SSDs may be striped already, their array's record (mdadm.conf)
    # gone with the boot disk: an array the kernel assembled from them
    # under another name is used as it is, and SSDs carrying an array's
    # superblock are assembled again. Only SSDs with none are striped
    # anew, as creating an array over them would write over its data.
    first=$(basename "$(readlink -f "${nvme[0]}")")
    held=
    for holder in /sys/class/block/"$first"/holders/md*; do
      [ -e "$holder" ] && held=${holder##*/} && break
    done
    if [ -n "$held" ]; then
      state_device=/dev/$held
    elif [ ! -e /dev/md/compute-state ]; then
      striped=
      for ssd in "${nvme[@]}"; do
        mdadm --examine "$ssd" >/dev/null 2>&1 && striped=1
      done
      if [ -n "$striped" ]; then
        mdadm --assemble /dev/md/compute-state "${nvme[@]}"
      else
        mdadm --create /dev/md/compute-state --level=0 --raid-devices="${#nvme[@]}" "${nvme[@]}" --run
      fi
    fi
    mdadm --detail --scan >/etc/mdadm/mdadm.conf.part
    put /etc/mdadm/mdadm.conf.part /etc/mdadm/mdadm.conf
  else
    state_device=/dev/disk/by-id/google-state
  fi
else
  # A rebooted host: its striped local SSDs come back as the same array.
  mdadm --assemble --scan >/dev/null 2>&1 || true
  mountpoint -q "$var" || mount "$var" || true
fi

# --- The bundle.
# A bundle is unpacked into a directory named for its SHA-256 with a
# record, .unpacked, of the SHA-256 of the SHA256SUMS that came in it, the
# last file written before the directory takes its name. The bundle is
# whole while its SHA256SUMS is still that one and its files all match it:
# a reset can leave the directory with empty files (an empty install.sh
# runs, does nothing and succeeds), or an earlier startup script's
# directory has no record; either is fetched again.
bundle=$opt/bundles/$BUNDLE_SHA256
bundle_intact() {
  [ -s "$1/.unpacked" ] && [ -s "$1/SHA256SUMS" ] &&
    [ "$(cat "$1/.unpacked")" = "$(sha256sum <"$1/SHA256SUMS" | cut -d' ' -f1)" ] &&
    (cd "$1" && sha256sum -c --quiet --strict SHA256SUMS >/dev/null 2>&1)
}
if ! bundle_intact "$bundle"; then
  [ ! -e "$bundle" ] || log "the bundle in $bundle is not whole; fetching it again"
  # One fixed place, emptied first, so failed attempts leave at most one
  # partial download behind.
  work=$opt/bundles/.download
  rm -rf "$work" "$bundle.part"
  install -d -m 700 "$work"
  case "$BUNDLE_URL" in
    gs://*) gcloud storage cp --quiet "$BUNDLE_URL" "$work/bundle.tar.gz" ;;
    *) curl -fsSL --retry 5 -o "$work/bundle.tar.gz" "$BUNDLE_URL" ;;
  esac
  echo "$BUNDLE_SHA256  $work/bundle.tar.gz" | sha256sum -c --quiet - ||
    { log "$BUNDLE_URL does not have SHA-256 $BUNDLE_SHA256"; exit 1; }
  mkdir -p "$bundle.part"
  tar -xzf "$work/bundle.tar.gz" -C "$bundle.part" --strip-components=1
  (cd "$bundle.part" && sha256sum -c --quiet --strict SHA256SUMS) ||
    { log "$BUNDLE_URL does not match the SHA256SUMS in it"; exit 1; }
  sha256sum <"$bundle.part/SHA256SUMS" | cut -d' ' -f1 >"$bundle.part/.unpacked"
  rm -rf "$work" "$bundle"
  put "$bundle.part" "$bundle"
fi

# --- The hosts' authority, the host's first trust in the control service;
# install.sh gets the host its certificate, for its instance name, with the
# instance's identity token, and renews it daily.
install -d -m 700 "$etc"
attr compute-host-authority >"$etc/authority.pem.new"

# --- The host's configuration. The memory profile is always named: the
# agent would otherwise pick nested on any host that is itself a VM.
huge_pages=0
profile=$(attr compute-memory-profile)
args=$(optional_attr compute-host-args)
if [ "$profile" = nested ]; then
  percent=$(attr compute-huge-pages-pct)
  huge_pages=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) * percent / 100 / 2048))
fi
args="--memory-profile $profile $args"
if [ -n "$PUBLIC" ]; then
  args="$args --block $PUBLIC/32"
fi
umask 077
cat >"$etc/host.env.new" <<ENV
COMPUTE_CONTROL=$(attr compute-control)
COMPUTE_NAME=$NAME
COMPUTE_ADDRESS=$ADDRESS:7443
COMPUTE_ZONE=$ZONE
COMPUTE_STORE=$(attr compute-store)
COMPUTE_BASE_IMAGE_REF=$(attr compute-base-image)
COMPUTE_HUGE_PAGES=$huge_pages
COMPUTE_HOST_ARGS="$args"
ENV

log "installing $(cat "$bundle/VERSION") as $NAME"
"$bundle/install.sh" --config "$etc/host.env.new" --authority "$etc/authority.pem.new" \
  ${state_device:+--state-device "$state_device"}
rm -f "$etc/host.env.new" "$etc/authority.pem.new"
