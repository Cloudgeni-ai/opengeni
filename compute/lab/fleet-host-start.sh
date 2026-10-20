#!/usr/bin/env bash
# The startup script of a fleet host on Google Cloud: fleet-gcp.sh puts it
# in the hosts' instance template, and the guest agent runs it as root at
# every boot. It mounts the lab disk (made by host-setup.sh), reserves huge
# pages, arms the watchdog, makes the host's certificate, fetches the agent
# and starts the guard, then the agent in the fleet (ADR 18).
#
# Lab arrangement, not a production one: the hosts' certificate authority's
# key sits in the fleet's bucket and each host signs its own certificate
# with it at boot. Production hosts get theirs from the control service,
# which checks the instance's identity token (deploy/host/compute-host-certificate).
set -euo pipefail
export PATH=$PATH:/snap/bin

meta() { curl -fsS -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/$1"; }
NAME=$(meta instance/name)
ADDRESS=$(meta instance/network-interfaces/0/ip)
ZONE=$(meta instance/zone)
ZONE=${ZONE##*/}
BUCKET=$(meta instance/attributes/fleet-bucket)
CONTROL=$(meta instance/attributes/fleet-control)
HUGE_PAGES=$(meta instance/attributes/fleet-huge-pages)

mkdir -p /lab
mountpoint -q /lab || mount -o noatime /dev/disk/by-id/google-lab /lab
# The lab disk is made from a small image and given its full size by the
# template: the filesystem must grow to it, or the host books far less disk
# than it has.
xfs_growfs /lab >/dev/null
mkdir -p /lab/state /run/compute-host
echo "$HUGE_PAGES" >/proc/sys/vm/nr_hugepages
echo never >/sys/kernel/mm/transparent_hugepage/enabled

# The guard feeds this watchdog; the machine resets 3 s after it stops, and
# nothing can disarm it.
modprobe softdog soft_margin=3 nowayout=1
# A machine that suspends could run its VMs again on resuming before the
# guard fences them, so it never suspends.
systemctl mask --now sleep.target suspend.target hibernate.target hybrid-sleep.target

install -d -m 700 /etc/compute
cd /etc/compute
gcloud storage cp "gs://$BUCKET/fleet/ca.pem" "gs://$BUCKET/fleet/ca.key" .
gcloud storage cp "gs://$BUCKET/fleet/compute-host" /usr/local/bin/compute-host
chmod 755 /usr/local/bin/compute-host
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout host.key \
  -subj "/CN=$NAME" -out host.csr 2>/dev/null
openssl x509 -req -in host.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -out host.pem \
  -extfile <(printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth,clientAuth\n' "$NAME") 2>/dev/null
rm -f ca.key ca.srl host.csr

# For the multi-host tests: cut this host off from the service at $1, in
# both directions, leaving everything else (its sandboxes' traffic, SSH).
cat >/usr/local/sbin/fleet-cut <<'CUT'
#!/bin/sh
set -e
iptables -I OUTPUT 1 -d "$1" -p tcp --dport 8443 -j DROP
iptables -I INPUT 1 -s "$1" -p tcp --dport 7443 -j DROP
CUT
chmod 755 /usr/local/sbin/fleet-cut

# The guard is never restarted: if it ends, the watchdog resets the machine.
cat >/etc/systemd/system/compute-guard.service <<'UNIT'
[Unit]
Description=Compute host guard: stops the VMs when the fleet lease ends
[Service]
ExecStart=/usr/local/bin/compute-host guard
Restart=no
UNIT
cat >/etc/systemd/system/compute-host.service <<UNIT
[Unit]
Description=Compute host agent in the fleet
Requires=compute-guard.service
After=compute-guard.service
[Service]
Environment=RUST_LOG=info
ExecStart=/usr/local/bin/compute-host --socket /run/compute-host.sock serve \\
  --root /lab/state --firecracker /lab/bin/firecracker --jailer /lab/bin/jailer \\
  --kernel /lab/vmlinux --base-image /lab/base.ext4 --memory-profile nested \\
  --store gs://$BUCKET/archive --restore-notice-port 53 --template-ready-port 54 \\
  --network --trusted \\
  --fleet-control https://$CONTROL:8443 --fleet-name $NAME --fleet-address $ADDRESS:7443 \\
  --fleet-zone $ZONE --fleet-cert /etc/compute/host.pem --fleet-key /etc/compute/host.key \\
  --fleet-ca /etc/compute/ca.pem
Restart=always
RestartSec=1
KillMode=process
UNIT
systemctl daemon-reload
systemctl start compute-guard.service compute-host.service
