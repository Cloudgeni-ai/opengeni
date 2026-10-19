#!/usr/bin/env bash
# A compute host's startup script on Google Cloud, run as root at every
# boot from the instance template's metadata (main.tf). It prepares the
# state volume, fetches and checks the host bundle the template names,
# makes sure the host has a current certificate from the fleet's authority,
# writes /etc/compute/host.env and runs the bundle's install.sh, which
# starts the guard and the agent. A new bundle reaches a host when the host
# is replaced or rebooted with a template naming it.
set -euo pipefail
export PATH=$PATH:/snap/bin

meta() { curl -fsS -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/$1"; }
attr() { meta "instance/attributes/$1"; }
log() { echo "compute-startup: $*"; }

NAME=$(meta instance/name)
ADDRESS=$(meta instance/network-interfaces/0/ip)
ZONE=$(meta instance/zone)
ZONE=${ZONE##*/}
BUNDLE_URL=$(attr compute-bundle-url)
BUNDLE_SHA256=$(attr compute-bundle-sha256)

# --- The state volume: local NVMe SSDs, striped, or the "state" disk.
state_device=
if [ ! -f /etc/compute/state-volume.uuid ]; then
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
  work=$(mktemp -d)
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

# --- The host's certificate, renewed by a daily timer.
install -d -m 700 /etc/compute
cat >/usr/local/sbin/compute-host-certificate <<'CERT'
#!/usr/bin/env bash
# Gets this host a 30-day certificate from the fleet's authority when it
# has none or its own expires within 10 days, then restarts the agent to
# use it (its VMs keep running). The authority's certificate is the trust
# root for the control service.
set -euo pipefail
export PATH=$PATH:/snap/bin
meta() { curl -fsS -H Metadata-Flavor:Google "http://metadata.google.internal/computeMetadata/v1/$1"; }
NAME=$(meta instance/name)
POOL=$(meta instance/attributes/compute-ca-pool)
LOCATION=$(meta instance/attributes/compute-ca-location)
cd /etc/compute
if [ -f host.pem ] && openssl x509 -in host.pem -noout -checkend 864000 >/dev/null; then
  exit 0
fi
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout host.key.new \
  -subj "/CN=$NAME" -addext "subjectAltName=DNS:$NAME" -out host.csr 2>/dev/null
gcloud privateca certificates create --quiet --issuer-pool "$POOL" --issuer-location "$LOCATION" \
  --csr host.csr --cert-output-file host.pem.new --validity P30D
gcloud privateca pools get-ca-certs "$POOL" --location "$LOCATION" --output-file ca.pem.new
chmod 600 host.key.new host.pem.new
chmod 644 ca.pem.new
mv host.key.new host.key
mv host.pem.new host.pem
mv ca.pem.new ca.pem
rm -f host.csr
if systemctl is-active -q compute-host.service; then
  systemctl restart compute-host.service
fi
CERT
chmod 755 /usr/local/sbin/compute-host-certificate
cat >/etc/systemd/system/compute-host-certificate.service <<'UNIT'
[Unit]
Description=Renew the compute host's certificate
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/compute-host-certificate
UNIT
cat >/etc/systemd/system/compute-host-certificate.timer <<'UNIT'
[Unit]
Description=Renew the compute host's certificate daily
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable -q --now compute-host-certificate.timer
/usr/local/sbin/compute-host-certificate

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
"$bundle/install.sh" --config /etc/compute/host.env.new ${state_device:+--state-device "$state_device"}
rm -f /etc/compute/host.env.new
