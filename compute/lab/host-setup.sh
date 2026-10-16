#!/usr/bin/env bash
# Prepare a fresh Ubuntu 24.04 cloud machine that exposes /dev/kvm (bare metal or
# nested virtualization) for microVM sleep/wake experiments.
#
# Idempotent. Run as a login user with passwordless sudo:
#   bash host-setup.sh
#
# Produces under $LAB_DIR (default /lab):
#   bin/firecracker         pinned Firecracker release
#   vmlinux                 guest kernel from Firecracker CI artifacts
#   base.ext4               guest root filesystem with node, git, python, a
#                           small exec agent listening on vsock port 52 and
#                           the guest services below
#   swapfile                backing swap so zswap can be measured
set -euo pipefail

FC_VERSION="${FC_VERSION:-v1.17.0}"
LAB_DIR="${LAB_DIR:-/lab}"
ROOTFS_SIZE="${ROOTFS_SIZE:-6G}"
SWAP_SIZE="${SWAP_SIZE:-256G}"
NODE_MAJOR="${NODE_MAJOR:-24}"
ARCH="$(uname -m)"
export DEBIAN_FRONTEND=noninteractive

log() { printf '[host-setup %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# The guest's side of the host agent's identity contract: a booted guest
# finds its sandbox id on the kernel command line (`opengeni.sandbox=`), a
# restored one in the restore notice on vsock port 53 (`restored <unix
# nanoseconds> sandbox=<id> seed=<hex>`), which also sets the clock.
# Either way the id ends up in /run/sandbox-id. The notice's `seed` is
# mixed into the guest's random number generator, which reseeds before the
# guest answers, so no command of the new sandbox draws numbers another
# clone of the same snapshot draws. (The kernel reseeds by itself when it
# learns of the VM generation ID's change, but later.)
# A template is snapshotted once the guest accepts on vsock port 54, which
# opens only when systemd has finished starting everything, so clones wake
# settled instead of mid-boot.
install_guest_services() {
  local root="$1"
  # Resident, so answering a notice starts no process in a guest whose
  # memory is still being faulted in after its restore.
  sudo tee "$root/usr/local/bin/lab-notice" >/dev/null <<'SCRIPT'
#!/usr/bin/python3
import fcntl, os, socket, time

RNDRESEEDCRNG = 0x5207  # _IO('R', 0x07)

listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
listener.bind((socket.VMADDR_CID_ANY, 53))
listener.listen(64)
while True:
    connection, _ = listener.accept()
    with connection:
        try:
            line = b""
            while not line.endswith(b"\n"):
                chunk = connection.recv(256)
                if not chunk:
                    raise EOFError
                line += chunk
            word, nanos, *fields = line.decode().split()
            if word != "restored":
                continue
            time.clock_settime_ns(time.CLOCK_REALTIME, int(nanos))
            for field in fields:
                key, _, value = field.partition("=")
                if key == "sandbox":
                    with open("/run/sandbox-id.new", "w") as file:
                        file.write(value + "\n")
                    os.replace("/run/sandbox-id.new", "/run/sandbox-id")
                elif key == "seed":
                    # Mixed into the input pool, then the generator reseeds
                    # from it at once.
                    with open("/dev/urandom", "wb", buffering=0) as pool:
                        pool.write(bytes.fromhex(value))
                        fcntl.ioctl(pool, RNDRESEEDCRNG)
                    with open("/dev/kmsg", "w") as log:
                        log.write("lab-notice: crng reseeded from the restore notice\n")
            connection.sendall(b"ok\n")
        except (OSError, ValueError, EOFError):
            pass
SCRIPT
  sudo tee "$root/usr/local/bin/lab-identity" >/dev/null <<'SCRIPT'
#!/bin/bash
for arg in $(cat /proc/cmdline); do
  case "$arg" in
    opengeni.sandbox=*) printf '%s\n' "${arg#opengeni.sandbox=}" >/run/sandbox-id ;;
  esac
done
SCRIPT
  sudo chmod 755 "$root/usr/local/bin/lab-notice" "$root/usr/local/bin/lab-identity"
  sudo tee "$root/etc/systemd/system/lab-notice.service" >/dev/null <<'UNIT'
[Unit]
Description=Restore notices from the host agent on vsock port 53
After=local-fs.target

[Service]
ExecStart=/usr/local/bin/lab-notice
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
  sudo tee "$root/etc/systemd/system/lab-identity.service" >/dev/null <<'UNIT'
[Unit]
Description=The sandbox id from the kernel command line
After=local-fs.target
# Commands arrive through lab-agent; none may run before the id is known.
Before=lab-agent.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/lab-identity

[Install]
WantedBy=multi-user.target
UNIT
  sudo tee "$root/etc/systemd/system/lab-ready.service" >/dev/null <<'UNIT'
[Unit]
Description=Tells a template builder on vsock port 54 that startup has finished
After=multi-user.target

[Service]
ExecStart=/bin/sh -c 'systemctl is-system-running --wait >/dev/null; exec /usr/bin/socat VSOCK-LISTEN:54,reuseaddr,fork SYSTEM:true'
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
  for unit in lab-notice lab-identity lab-ready; do
    sudo ln -sf "/etc/systemd/system/$unit.service" "$root/etc/systemd/system/multi-user.target.wants/$unit.service"
  done
}

log "packages"
sudo apt-get update -qq
sudo apt-get install -y -qq jq squashfs-tools e2fsprogs xfsprogs socat mdadm acl curl git unzip zstd fio sysstat >/dev/null

log "scratch disk"
if [ ! -e "$LAB_DIR/.scratch-ready" ]; then
  mapfile -t nvme < <(ls /dev/disk/by-id/google-local-nvme-ssd-* 2>/dev/null || true)
  if [ "${#nvme[@]}" -eq 1 ]; then
    sudo mkfs.xfs -q -f "${nvme[0]}"
    sudo mkdir -p "$LAB_DIR"
    sudo mount -o noatime "${nvme[0]}" "$LAB_DIR"
  elif [ "${#nvme[@]}" -gt 1 ]; then
    # GCP local NVMe: stripe all devices, XFS for reflink copies of disk images.
    if [ ! -e /dev/md0 ]; then
      sudo mdadm --create /dev/md0 --level=0 --raid-devices="${#nvme[@]}" "${nvme[@]}" --run
    fi
    sudo mkfs.xfs -q -f /dev/md0
    sudo mkdir -p "$LAB_DIR"
    sudo mount -o noatime /dev/md0 "$LAB_DIR"
  elif [ -b /dev/disk/azure/resource ] || [ -b /dev/disk/azure/resource-part1 ]; then
    # Azure local temp disk: reformat as XFS (it holds nothing durable).
    dev=$(readlink -f /dev/disk/azure/resource-part1 2>/dev/null || readlink -f /dev/disk/azure/resource)
    if mountpoint -q /mnt; then sudo umount /mnt; fi
    sudo mkfs.xfs -q -f "$dev"
    sudo mkdir -p "$LAB_DIR"
    sudo mount -o noatime "$dev" "$LAB_DIR"
  else
    sudo mkdir -p "$LAB_DIR"
  fi
  sudo chown "$(id -u):$(id -g)" "$LAB_DIR"
  touch "$LAB_DIR/.scratch-ready"
fi
sudo setfacl -m "u:$(id -un):rw" /dev/kvm
cd "$LAB_DIR"
mkdir -p bin vms snapshots results

log "firecracker $FC_VERSION"
if [ ! -x bin/firecracker ]; then
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz" | tar -xz
  cp "release-${FC_VERSION}-${ARCH}/firecracker-${FC_VERSION}-${ARCH}" bin/firecracker
  cp "release-${FC_VERSION}-${ARCH}/jailer-${FC_VERSION}-${ARCH}" bin/jailer
  rm -rf "release-${FC_VERSION}-${ARCH}"
fi

log "bun"
if ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun

S3="https://s3.amazonaws.com/spec.ccfc.min"
if [ ! -f vmlinux ] || [ ! -f ubuntu.squashfs ]; then
  log "guest kernel and base image from Firecracker CI"
  # CI_PREFIX pins the artifact set so several hosts run an identical guest.
  prefix="${CI_PREFIX:-$(curl -fsSL "$S3?list-type=2&prefix=firecracker-ci/&delimiter=/" |
    grep -oP "(?<=<Prefix>)firecracker-ci/[0-9]{8}-[^/]+/(?=</Prefix>)" | sort | tail -1)}"
  kernel_key=$(curl -fsSL "$S3?list-type=2&prefix=${prefix}${ARCH}/vmlinux-" |
    grep -oP "(?<=<Key>)(${prefix}${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" | sort -V | tail -1)
  ubuntu_key=$(curl -fsSL "$S3?list-type=2&prefix=${prefix}${ARCH}/ubuntu-" |
    grep -oP "(?<=<Key>)(${prefix}${ARCH}/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" | sort -V | tail -1)
  curl -fsSL -o vmlinux "$S3/$kernel_key"
  curl -fsSL -o ubuntu.squashfs "$S3/$ubuntu_key"
  printf '%s\n%s\n' "$kernel_key" "$ubuntu_key" > ci-artifacts.txt
  # Keep the matching kernel config when CI publishes it, to check guest features.
  curl -fsSL -o vmlinux.config "$S3/${kernel_key}.config" 2>/dev/null || true
fi

if [ -f base.ext4 ] && {
  ! sudo debugfs -R "cat /etc/systemd/system/lab-identity.service" base.ext4 2>/dev/null | grep -q Before=lab-agent ||
    ! sudo debugfs -R "cat /usr/local/bin/lab-notice" base.ext4 2>/dev/null | grep -q RNDRESEEDCRNG ||
    ! sudo debugfs -R "stat /etc/systemd/system/lab-ready.service" base.ext4 2>/dev/null | grep -q Inode
}; then
  log "guest services"
  sudo mkdir -p /mnt/lab-base
  sudo mount -o loop base.ext4 /mnt/lab-base
  install_guest_services /mnt/lab-base
  sudo umount /mnt/lab-base
fi

if [ ! -f base.ext4 ]; then
  log "guest root filesystem"
  sudo rm -rf rootfs
  sudo unsquashfs -q -d rootfs ubuntu.squashfs
  sudo mkdir -p rootfs/tmp && sudo chmod 1777 rootfs/tmp
  # The CI image is stripped; recreate what apt and npm expect.
  sudo mkdir -p rootfs/var/cache/apt/archives/partial rootfs/var/lib/apt/lists/partial rootfs/var/log/apt rootfs/var/tmp rootfs/var/lib/dpkg/updates rootfs/root
  sudo chmod 1777 rootfs/var/tmp
  sudo cp /etc/resolv.conf rootfs/etc/resolv.conf
  for m in proc sys dev; do sudo mount --bind "/$m" "rootfs/$m"; done
  trap 'for m in proc sys dev; do sudo umount -l "$LAB_DIR/rootfs/$m" 2>/dev/null || true; done' EXIT
  sudo chroot rootfs /bin/bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold git python3 socat ca-certificates curl xz-utils >/dev/null
    apt-get clean
  '
  node_tar=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep -oE "node-v[0-9.]+-linux-x64\.tar\.xz" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${node_tar}" | sudo tar -xJ -C rootfs/usr/local --strip-components=1
  # Synthetic workloads built only from public code.
  sudo chroot rootfs /bin/bash -euo pipefail -c '
    mkdir -p /opt/work && cd /opt/work
    git clone -q --depth 200 https://github.com/expressjs/express.git
    cd express && npm install --no-audit --no-fund --loglevel=error >/dev/null && cd ..
    mkdir -p web && cd web
    printf "%s\n" "{\"name\":\"web\",\"private\":true,\"type\":\"module\",\"scripts\":{\"dev\":\"vite --host 0.0.0.0 --port 5173\"}}" > package.json
    printf "%s\n" "<!doctype html><html><body><div id=app></div><script type=module src=/main.js></script></body></html>" > index.html
    printf "%s\n" "document.getElementById(\"app\").textContent = \"hello\";" > main.js
    npm install --no-audit --no-fund --loglevel=error vite >/dev/null
  '
  sudo tee rootfs/etc/systemd/system/lab-agent.service >/dev/null <<'UNIT'
[Unit]
Description=Experiment exec agent on vsock port 52
After=local-fs.target

[Service]
ExecStart=/usr/bin/socat VSOCK-LISTEN:52,reuseaddr,fork EXEC:/bin/bash,stderr
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
  sudo ln -sf /etc/systemd/system/lab-agent.service rootfs/etc/systemd/system/multi-user.target.wants/lab-agent.service
  install_guest_services rootfs
  for m in proc sys dev; do sudo umount -l "rootfs/$m"; done
  trap - EXIT
  # Name servers come from the kernel's `ip=` boot argument, which the
  # kernel publishes in /proc/net/pnp in resolv.conf syntax.
  sudo ln -sfn /proc/net/pnp rootfs/etc/resolv.conf
  sudo chown -R root:root rootfs
  truncate -s "$ROOTFS_SIZE" base.ext4
  sudo mkfs.ext4 -q -d rootfs -F base.ext4
  sudo chown "$(id -u):$(id -g)" base.ext4
  sudo rm -rf rootfs
fi

log "swap and zswap"
if ! swapon --show=NAME --noheadings | grep -q "$LAB_DIR/swapfile"; then
  if [ ! -f swapfile ]; then
    sudo fallocate -l "$SWAP_SIZE" swapfile
    sudo chmod 600 swapfile
    sudo mkswap -q swapfile
  fi
  sudo swapon swapfile
fi
echo 1 | sudo tee /sys/module/zswap/parameters/enabled >/dev/null
echo zstd | sudo tee /sys/module/zswap/parameters/compressor >/dev/null || true
echo 40 | sudo tee /sys/module/zswap/parameters/max_pool_percent >/dev/null
# Keep the experiments' own memory decisions explicit: no transparent huge pages.
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled >/dev/null

log "ready: $(./bin/firecracker --version | head -1), kernel $(head -1 ci-artifacts.txt | xargs basename)"
