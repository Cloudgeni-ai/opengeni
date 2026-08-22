#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/deploy/stacks/k3s-source.lock"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "bootstrap-opensandbox-k3s.sh must run as root" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    release_arch="amd64"
    binary_name="k3s"
    checksum_file_sha256="$K3S_AMD64_CHECKSUM_FILE_SHA256"
    binary_sha256="$K3S_AMD64_BINARY_SHA256"
    ;;
  aarch64|arm64)
    release_arch="arm64"
    binary_name="k3s-arm64"
    checksum_file_sha256="$K3S_ARM64_CHECKSUM_FILE_SHA256"
    binary_sha256="$K3S_ARM64_BINARY_SHA256"
    ;;
  *)
    echo "unsupported k3s architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

release_url="https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION}"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

curl -fsSL "$K3S_INSTALL_SCRIPT_URL" -o "$temporary/install.sh"
printf '%s  %s\n' "$K3S_INSTALL_SCRIPT_SHA256" "$temporary/install.sh" | sha256sum -c -

curl -fsSL "$release_url/sha256sum-${release_arch}.txt" -o "$temporary/checksums.txt"
printf '%s  %s\n' "$checksum_file_sha256" "$temporary/checksums.txt" | sha256sum -c -
grep -Fqx "$binary_sha256  $binary_name" "$temporary/checksums.txt"

curl -fsSL "$release_url/$binary_name" -o "$temporary/k3s"
printf '%s  %s\n' "$binary_sha256" "$temporary/k3s" | sha256sum -c -
install -m 0755 "$temporary/k3s" /usr/local/bin/k3s

INSTALL_K3S_SKIP_DOWNLOAD=true \
INSTALL_K3S_VERSION="$K3S_VERSION" \
INSTALL_K3S_EXEC="server --disable traefik --write-kubeconfig-mode 0640" \
sh "$temporary/install.sh"

systemctl enable --now k3s
for _ in $(seq 1 120); do
  if /usr/local/bin/k3s kubectl get --raw=/readyz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
/usr/local/bin/k3s kubectl get --raw=/readyz >/dev/null
/usr/local/bin/k3s kubectl wait node --all --for=condition=Ready --timeout=300s

install -d -m 0750 /root/.kube
/usr/local/bin/k3s kubectl config view --raw > /root/.kube/config
chmod 0600 /root/.kube/config

printf 'k3s %s is ready on %s (%s)\n' "$K3S_VERSION" "$(hostname)" "$release_arch"