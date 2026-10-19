#!/usr/bin/env bash
# A compute host's startup script on Google Cloud, run as root at every
# boot from the instance template's metadata (main.tf). It prepares the
# state volume, fetches and checks the host bundle the template names,
# writes /etc/compute/host.env and runs the bundle's install.sh with the
# hosts' authority from the metadata, which gets the host its certificate
# from the control service and starts the guard and the agent. A new
# bundle reaches a host when the host is replaced or rebooted with a
# template naming it.
set -euo pipefail
export PATH=$PATH:/snap/bin

meta() { curl -fsS -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/$1"; }
attr() { meta "instance/attributes/$1"; }
log() { echo "compute-startup: $*"; }

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

NAME=$(meta instance/name)
ADDRESS=$(meta instance/network-interfaces/0/ip)
ZONE=$(meta instance/zone)
ZONE=${ZONE##*/}
BUNDLE_URL=$(attr compute-bundle-url)
BUNDLE_SHA256=$(attr compute-bundle-sha256)

# --- The state volume: local NVMe SSDs, striped, or the "state" disk.
state_device=
# install.sh records the volume it set up; a record with no UUID in it
# is none (the same test as install.sh's).
recorded=$(tr -d '[:space:]' 2>/dev/null </etc/compute/state-volume.uuid || true)
if [ -z "$recorded" ]; then
  mapfile -t nvme < <(ls /dev/disk/by-id/google-local-nvme-ssd-* 2>/dev/null || true)
  if [ "${#nvme[@]}" -eq 1 ]; then
    state_device=${nvme[0]}
  elif [ "${#nvme[@]}" -gt 1 ]; then
    [ -e /dev/md/compute-state ] ||
      mdadm --create /dev/md/compute-state --level=0 --raid-devices="${#nvme[@]}" "${nvme[@]}" --run
    mdadm --detail --scan >/etc/mdadm/mdadm.conf
    state_device=/dev/md/compute-state
  else
    state_device=/dev/disk/by-id/google-state
  fi
else
  # A rebooted host: its striped local SSDs come back as the same array.
  mdadm --assemble --scan >/dev/null 2>&1 || true
  mountpoint -q /var/lib/compute || mount /var/lib/compute || true
fi

# --- The bundle.
bundle=/opt/compute/bundles/$BUNDLE_SHA256
if [ ! -f "$bundle/install.sh" ]; then
  # One fixed place, emptied first, so failed attempts leave at most one
  # partial download behind.
  work=/opt/compute/bundles/.download
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
  rm -rf "$work" "$bundle"
  mv "$bundle.part" "$bundle"
fi

# --- The hosts' authority, the host's first trust in the control service;
# install.sh gets the host its certificate, for its instance name, with the
# instance's identity token, and renews it daily.
install -d -m 700 /etc/compute
attr compute-host-authority >/etc/compute/authority.pem.new

# --- The host's configuration.
huge_pages=0
args=$(attr compute-host-args || true)
if [ "$(attr compute-nested)" = true ]; then
  percent=$(attr compute-huge-pages-pct)
  huge_pages=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) * percent / 100 / 2048))
  args="--memory-profile nested $args"
fi
umask 077
cat >/etc/compute/host.env.new <<ENV
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
"$bundle/install.sh" --config /etc/compute/host.env.new --authority /etc/compute/authority.pem.new \
  ${state_device:+--state-device "$state_device"}
rm -f /etc/compute/host.env.new /etc/compute/authority.pem.new
