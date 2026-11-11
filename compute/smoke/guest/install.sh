#!/usr/bin/env bash
# Installs the reference guest service into an ext4 root disk image, started
# by systemd at every boot. It serves requests on vsock port 55 and takes the
# host agent's restore notices on vsock port 56; start the host agent with
# `--restore-notice-port 56` to match. Both stay clear of the lab image's own
# guest services on ports 52 to 54 (lab/host-setup.sh), so the service can be
# installed into a copy of that image.
#
# Usage: sudo guest/install.sh IMAGE [PORT [NOTICE_PORT]]
#
# The image needs systemd and Python 3.10 or later. Run it on a copy: the
# image is changed in place.
set -euo pipefail

image="${1:?usage: install.sh IMAGE [PORT [NOTICE_PORT]]}"
port="${2:-55}"
notice_port="${3:-56}"
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

# The image's contents are not trusted: a symlink such as etc/systemd/system
# pointing at an absolute path would send root's writes to the host. Refuse
# to write through any symlink on the way to a destination.
refuse_symlinks() {
  local relative="$1" path="$mount_point" part
  local -a parts
  IFS=/ read -r -a parts <<<"$relative"
  for part in "${parts[@]}"; do
    path="$path/$part"
    if [[ -L "$path" ]]; then
      echo "install.sh: refusing to write through the symlink at /${path#"$mount_point"/} in $image" >&2
      exit 1
    fi
  done
}

refuse_symlinks opt/smoke/smoke_guest.py
install -D -m 0755 "$here/smoke_guest.py" "$mount_point/opt/smoke/smoke_guest.py"
refuse_symlinks etc/systemd/system/smoke-guest.service
unit="$mount_point/etc/systemd/system/smoke-guest.service"
cat >"$unit" <<EOF
[Unit]
Description=Compute smoke-suite guest service on vsock port $port
# In a copy of the lab image, lab-identity may replace the machine id at boot;
# this service reads and renews the identity only after it has. Ordering after
# a unit the image does not have is a no-op.
After=local-fs.target lab-identity.service

[Service]
ExecStart=/usr/bin/python3 /opt/smoke/smoke_guest.py --listen vsock:$port --notice vsock:$notice_port
Restart=always
RestartSec=0

[Install]
WantedBy=multi-user.target
EOF
refuse_symlinks etc/systemd/system/multi-user.target.wants
wants="$mount_point/etc/systemd/system/multi-user.target.wants"
mkdir -p "$wants"
# -n replaces an existing link itself rather than following it.
ln -sfn /etc/systemd/system/smoke-guest.service "$wants/smoke-guest.service"
echo "installed the smoke guest service on vsock ports $port and $notice_port in $image"
