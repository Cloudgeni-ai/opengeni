#!/usr/bin/env bash
# A small fleet on Google Cloud for the multi-host tests
# (crates/compute-control/tests/cloud): hosts in a zonal managed instance
# group that the control service grows and fences, the service with Postgres on
# a VM of its own, which also runs the tests, and a bucket for archives.
# Hosts run nested virtualization on N2 machines.
#
# Usage, from a machine with gcloud, ssh and openssl:
#   PROJECT=p ZONE=europe-west4-b PREFIX=fleet-lab KEY=~/.ssh/id_lab fleet-gcp.sh STEP
# Steps:
#   image        build the host images (system disk and lab disk) on a fresh
#                VM with host-setup.sh, then delete the VM
#   up BIN=dir   bucket, service accounts, certificates, firewall, instance
#                template, group and the service's VM; BIN holds release
#                builds of compute-host and compute-control
#   test BIN=dir copy the test binary (BIN/cloud, from `cargo test --release
#                -p compute-control --test cloud --no-run`) to the service's
#                VM and run it there
#   down         delete everything up made (images too, with IMAGES=1)
# Settings: HOSTS (3), MAX_HOSTS (5), MACHINE (n2-standard-8), HUGE_PAGES
# (12288, 24 GiB of 2 MiB pages), LAB_DISK_GB (250), SSH_FROM (this
# machine's address), SCALE_SHAPE (1x2048/8 for the scale-out test),
# LABELS (purpose=compute-build).
set -euo pipefail
PROJECT=${PROJECT:?project}
ZONE=${ZONE:?zone}
PREFIX=${PREFIX:?a name prefix for every resource}
KEY=${KEY:?an SSH private key whose .pub sits beside it}
REGION=${ZONE%-*}
HOSTS=${HOSTS:-3}
MAX_HOSTS=${MAX_HOSTS:-5}
MACHINE=${MACHINE:-n2-standard-8}
HUGE_PAGES=${HUGE_PAGES:-12288}
LAB_DISK_GB=${LAB_DISK_GB:-250}
SCALE_SHAPE=${SCALE_SHAPE:-1x2048/8}
LABELS=${LABELS:-purpose=compute-build}
BUCKET=${BUCKET:-$PREFIX-$PROJECT}
STATE=${STATE:-$HOME/.cache/fleet-gcp/$PREFIX}
HERE=$(cd "$(dirname "$0")" && pwd)
HOST_SA=$PREFIX-host@$PROJECT.iam.gserviceaccount.com
CONTROL_SA=$PREFIX-control@$PROJECT.iam.gserviceaccount.com
CONTROL=$PREFIX-control
GROUP=$PREFIX-hosts
# Named after the host start script, so changing it gives new hosts a new
# template.
TEMPLATE=$PREFIX-host-$(shasum -a 256 "$HERE/fleet-host-start.sh" | cut -c1-8)
SSH_KEY_META="lab:$(cat "$KEY.pub")"

log() { printf '[fleet-gcp %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
g() { gcloud --project "$PROJECT" --quiet "$@"; }
external() { g compute instances describe "$1" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)'; }
on() {
  local host=$1
  shift
  ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -o ConnectTimeout=10 "lab@$(external "$host")" "$@"
}
copy() {
  local host=$1
  shift
  scp -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "$@" "lab@$(external "$host"):"
}
until_ssh() {
  for _ in $(seq 60); do on "$1" true 2>/dev/null && return; sleep 5; done
  echo "no SSH to $1" >&2
  return 1
}

firewall() {
  local from=${SSH_FROM:-$(curl -fsS https://api.ipify.org)/32}
  if g compute firewall-rules describe "$PREFIX-ssh" >/dev/null 2>&1; then
    g compute firewall-rules update "$PREFIX-ssh" --source-ranges "$from"
  else
    g compute firewall-rules create "$PREFIX-ssh" --network default --allow tcp:22 \
      --source-ranges "$from" --target-tags "$PREFIX"
  fi
}

image() {
  firewall
  local build=$PREFIX-build
  log "build VM $build"
  g compute instances create "$build" --zone "$ZONE" --machine-type "$MACHINE" \
    --enable-nested-virtualization --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size 30GB --boot-disk-type pd-ssd \
    --create-disk "name=$build-lab,size=20GB,type=pd-ssd,device-name=lab,auto-delete=yes" \
    --labels "$LABELS" --tags "$PREFIX" --metadata "ssh-keys=$SSH_KEY_META"
  until_ssh "$build"
  copy "$build" "$HERE/host-setup.sh" "$HERE/../deploy/host/pins.env"
  log "host-setup.sh on $build"
  on "$build" 'set -e
    sudo apt-get update -qq && sudo apt-get install -y -qq xfsprogs >/dev/null
    sudo mkfs.xfs -q -f -L lab /dev/disk/by-id/google-lab
    sudo mkdir -p /lab && sudo mount -o noatime /dev/disk/by-id/google-lab /lab
    sudo chown "$(id -u):$(id -g)" /lab && touch /lab/.scratch-ready
    LAB_DIR=/lab SWAP_SIZE=1G bash host-setup.sh
    sudo swapoff /lab/swapfile && rm -f /lab/swapfile
    sudo chown -R root:root /lab && sync && sudo umount /lab'
  g compute instances stop "$build" --zone "$ZONE"
  log "images $PREFIX-host and $PREFIX-lab"
  g compute images create "$PREFIX-host" --source-disk "$build" --source-disk-zone "$ZONE" --labels "$LABELS"
  g compute images create "$PREFIX-lab" --source-disk "$build-lab" --source-disk-zone "$ZONE" --labels "$LABELS"
  g compute instances delete "$build" --zone "$ZONE"
}

certificates() {
  mkdir -p "$STATE"
  cd "$STATE"
  [ -f ca.pem ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
    -keyout ca.key -out ca.pem -subj "/CN=$PREFIX fleet authority" 2>/dev/null
  if [ ! -f control.pem ]; then
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout control.key \
      -out control.csr -subj "/CN=$CONTROL" 2>/dev/null
    openssl x509 -req -in control.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -out control.pem \
      -extfile <(printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth,clientAuth\n' "$CONTROL") 2>/dev/null
    rm -f control.csr
  fi
  if [ ! -f keys ]; then
    printf 'test %s\noperator %s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" >keys
    chmod 600 keys
  fi
  cd - >/dev/null
}

up() {
  local bin=${BIN:?BIN: a directory with compute-host and compute-control}
  firewall
  log "bucket gs://$BUCKET and service accounts"
  g storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 ||
    g storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access
  g storage buckets update "gs://$BUCKET" --update-labels "$LABELS" >/dev/null
  for account in host control; do
    g iam service-accounts describe "$PREFIX-$account@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1 ||
      g iam service-accounts create "$PREFIX-$account" --display-name "$PREFIX $account"
  done
  sleep 10
  for account in "$HOST_SA" "$CONTROL_SA"; do
    g storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$account" \
      --role roles/storage.objectAdmin >/dev/null
  done
  # The service resizes the group and resets its instances.
  g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$CONTROL_SA" \
    --role roles/compute.instanceAdmin.v1 --condition None >/dev/null
  g iam service-accounts add-iam-policy-binding "$HOST_SA" --member "serviceAccount:$CONTROL_SA" \
    --role roles/iam.serviceAccountUser >/dev/null
  certificates
  g storage cp "$STATE/ca.pem" "$STATE/ca.key" "$STATE/control.pem" "$STATE/control.key" "$STATE/keys" \
    "$bin/compute-host" "$bin/compute-control" "gs://$BUCKET/fleet/"
  log "instance template $TEMPLATE and group $GROUP"
  g compute instance-templates describe "$TEMPLATE" >/dev/null 2>&1 ||
    g compute instance-templates create "$TEMPLATE" --machine-type "$MACHINE" \
      --enable-nested-virtualization --image "$PREFIX-host" --image-project "$PROJECT" \
      --boot-disk-size 30GB --boot-disk-type pd-ssd \
      --create-disk "image=projects/$PROJECT/global/images/$PREFIX-lab,device-name=lab,size=${LAB_DISK_GB}GB,type=pd-ssd,auto-delete=yes" \
      --service-account "$HOST_SA" --scopes cloud-platform --tags "$PREFIX" --labels "$LABELS" \
      --metadata-from-file "startup-script=$HERE/fleet-host-start.sh" \
      --metadata "fleet-bucket=$BUCKET,fleet-control=$CONTROL,fleet-huge-pages=$HUGE_PAGES,ssh-keys=$SSH_KEY_META"
  log "service VM $CONTROL"
  g compute instances describe "$CONTROL" --zone "$ZONE" >/dev/null 2>&1 ||
    g compute instances create "$CONTROL" --zone "$ZONE" --machine-type n2-standard-4 \
      --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud --boot-disk-size 30GB \
      --service-account "$CONTROL_SA" --scopes cloud-platform --tags "$PREFIX" --labels "$LABELS" \
      --metadata-from-file "startup-script=$HERE/fleet-control-start.sh" \
      --metadata "fleet-bucket=$BUCKET,fleet-group=$GROUP,ssh-keys=$SSH_KEY_META,fleet-scale=--scale-min $HOSTS --scale-max $MAX_HOSTS --scale-host-memory-mib $((HUGE_PAGES * 2)) --scale-largest-mib 2048 --scale-spare-per-mille 300"
  # An existing group makes its new hosts from the current template; the
  # hosts it has keep theirs.
  if g compute instance-groups managed describe "$GROUP" --zone "$ZONE" >/dev/null 2>&1; then
    g compute instance-groups managed set-instance-template "$GROUP" --zone "$ZONE" \
      --template "$TEMPLATE" >/dev/null
  else
    g compute instance-groups managed create "$GROUP" --zone "$ZONE" --template "$TEMPLATE" \
      --size "$HOSTS" --base-instance-name "$PREFIX-h"
  fi
  until_ssh "$CONTROL"
  copy "$CONTROL" "$KEY"
  on "$CONTROL" 'mkdir -p ~/.ssh && mv id_* ~/.ssh/id_lab && chmod 600 ~/.ssh/id_lab'
  log "up; the hosts register as they boot"
}

run_test() {
  local bin=${BIN:?BIN: a directory with the cloud test binary}
  certificates
  copy "$CONTROL" "$bin/cloud"
  local ip key operator
  ip=$(g compute instances describe "$CONTROL" --zone "$ZONE" --format='value(networkInterfaces[0].networkIP)')
  key=$(awk '$1 == "test" {print $2}' "$STATE/keys")
  operator=$(awk '$1 == "operator" {print $2}' "$STATE/keys")
  # A killed host powers off at once, saving nothing; its SSH session dies
  # with it.
  on "$CONTROL" "cat > fleet-kill <<'KILL'
#!/bin/sh
ssh -i ~/.ssh/id_lab -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o ServerAliveInterval=2 -o ServerAliveCountMax=2 \"lab@\$1\" \
  'sudo sh -c \"echo 1 > /proc/sys/kernel/sysrq; echo o > /proc/sysrq-trigger\"' || true
KILL
cat > fleet-cut <<'CUT'
#!/bin/sh
exec ssh -i ~/.ssh/id_lab -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  \"lab@\$1\" sudo /usr/local/sbin/fleet-cut $ip
CUT
chmod 755 fleet-kill fleet-cut cloud"
  on "$CONTROL" "COMPUTE_TEST_REQUIRE=fleet COMPUTE_TEST_FLEET_API=http://127.0.0.1:8080 \
    COMPUTE_TEST_FLEET_KEY=$key COMPUTE_TEST_FLEET_OPERATOR_KEY=$operator \
    COMPUTE_TEST_FLEET_WITNESS=$ip:9000 COMPUTE_TEST_FLEET_HOSTS=$HOSTS COMPUTE_TEST_FLEET_SCALE=$SCALE_SHAPE \
    COMPUTE_TEST_FLEET_KILL='./fleet-kill {host}' COMPUTE_TEST_FLEET_CUT='./fleet-cut {host}' \
    ./cloud --test-threads 1 --nocapture ${FILTER:-}"
}

down() {
  g compute instance-groups managed delete "$GROUP" --zone "$ZONE" 2>/dev/null || true
  g compute instances delete "$CONTROL" "$PREFIX-build" --zone "$ZONE" 2>/dev/null || true
  for template in $(g compute instance-templates list --filter "name ~ ^$PREFIX-host-" \
    --format 'value(name)'); do
    g compute instance-templates delete "$template" 2>/dev/null || true
  done
  g storage rm -r "gs://$BUCKET" 2>/dev/null || true
  g projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$CONTROL_SA" \
    --role roles/compute.instanceAdmin.v1 --condition None >/dev/null 2>&1 || true
  for account in "$HOST_SA" "$CONTROL_SA"; do
    g iam service-accounts delete "$account" 2>/dev/null || true
  done
  g compute firewall-rules delete "$PREFIX-ssh" 2>/dev/null || true
  if [ "${IMAGES:-0}" = 1 ]; then
    g compute images delete "$PREFIX-host" "$PREFIX-lab" 2>/dev/null || true
  fi
  log "down"
}

case "${1:-}" in
image) image ;;
up) up ;;
test) run_test ;;
down) down ;;
*)
  sed -n '2,/^set -euo/p' "$0" | sed '$d'
  exit 2
  ;;
esac
