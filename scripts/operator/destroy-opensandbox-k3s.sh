#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "destroy-opensandbox-k3s.sh must run as root" >&2
  exit 1
fi

if [[ -x /usr/local/bin/k3s-uninstall.sh ]]; then
  /usr/local/bin/k3s-uninstall.sh
fi

rm -rf /etc/rancher/k3s /var/lib/rancher/k3s /var/lib/kubelet /root/.kube/config
echo "k3s state removed"