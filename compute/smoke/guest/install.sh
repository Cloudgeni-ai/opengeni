#!/usr/bin/env bash
# Installs the reference guest service into an ext4 root disk image, started
# by systemd on vsock port 53 at every boot.
#
# Usage: sudo guest/install.sh IMAGE [PORT]
#
# The image needs systemd and Python 3.10 or later. Run it on a copy: the
# image is changed in place.
set -euo pipefail

image="${1:?usage: install.sh IMAGE [PORT]}"
port="${2:-53}"
here="$(cd "$(dirname "$0")" && pwd)"

if [[ "$(id -u)" != 0 ]]; then
  echo "install.sh: mounting the image needs root" >&2
  exit 1
fi

mount_point="$(mktemp -d)"
cleanup() {
  if mountpoint -q "$mount_point"; then
    umount "$mount_point"
  fi
  rmdir "$mount_point"
}
trap cleanup EXIT
mount -o loop "$image" "$mount_point"

if [[ ! -x "$mount_point/usr/bin/python3" ]]; then
  echo "install.sh: $image has no /usr/bin/python3" >&2
  exit 1
fi

install -D -m 0755 "$here/smoke_guest.py" "$mount_point/opt/smoke/smoke_guest.py"
unit="$mount_point/etc/systemd/system/smoke-guest.service"
cat >"$unit" <<EOF
[Unit]
Description=Compute smoke-suite guest service on vsock port $port
After=local-fs.target

[Service]
ExecStart=/usr/bin/python3 /opt/smoke/smoke_guest.py --listen vsock:$port
Restart=always
RestartSec=0

[Install]
WantedBy=multi-user.target
EOF
wants="$mount_point/etc/systemd/system/multi-user.target.wants"
mkdir -p "$wants"
ln -sf /etc/systemd/system/smoke-guest.service "$wants/smoke-guest.service"
echo "installed the smoke guest service on vsock port $port in $image"
