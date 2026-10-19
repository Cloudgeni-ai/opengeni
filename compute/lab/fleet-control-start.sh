#!/usr/bin/env bash
# The startup script of the control service's VM on Google Cloud, made by
# fleet-gcp.sh; the guest agent runs it as root at every boot. Postgres on
# the same machine holds the service's store; the service grows the hosts'
# managed instance group and fences its instances.
set -euo pipefail
export PATH=$PATH:/snap/bin

meta() { curl -fsS -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/$1"; }
PROJECT=$(meta project/project-id)
ZONE=$(meta instance/zone)
ZONE=${ZONE##*/}
BUCKET=$(meta instance/attributes/fleet-bucket)
GROUP=$(meta instance/attributes/fleet-group)
SCALE=$(meta instance/attributes/fleet-scale)

if ! command -v psql >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null
fi
systemctl start postgresql
if ! sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = 'fleet'" | grep -q 1; then
  sudo -u postgres psql -qc "create role fleet login password 'fleet'"
  sudo -u postgres psql -qc "create database fleet owner fleet"
fi

install -d -m 700 /etc/compute
cd /etc/compute
gcloud storage cp "gs://$BUCKET/fleet/ca.pem" "gs://$BUCKET/fleet/control.pem" \
  "gs://$BUCKET/fleet/control.key" "gs://$BUCKET/fleet/keys" .
gcloud storage cp "gs://$BUCKET/fleet/compute-control" /usr/local/bin/compute-control
chmod 755 /usr/local/bin/compute-control

cat >/etc/systemd/system/compute-control.service <<UNIT
[Unit]
Description=Compute control service
After=postgresql.service network-online.target
Requires=postgresql.service
[Service]
Environment=RUST_LOG=info
ExecStart=/usr/local/bin/compute-control serve \\
  --database "host=localhost user=fleet password=fleet dbname=fleet" \\
  --cert /etc/compute/control.pem --key /etc/compute/control.key --host-ca /etc/compute/ca.pem \\
  --archive gs://$BUCKET/archive --keys-file /etc/compute/keys \\
  --gcp-group projects/$PROJECT/zones/$ZONE/instanceGroupManagers/$GROUP $SCALE
Restart=always
RestartSec=1
UNIT
systemctl daemon-reload
systemctl restart compute-control.service
