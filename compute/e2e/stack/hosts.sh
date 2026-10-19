#!/usr/bin/env bash
# Waits, on the stack VM, until the control service reports every host
# named on the command line live (env.sh hosts, after it replaced the
# group's hosts): the hosts a run uses got their certificates from, and
# registered with, the control service under test.
#   hosts.sh <host>...
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: hosts.sh <host>..." >&2; exit 2; }
export KUBECONFIG=$HOME/.kube/config
sec=$HOME/e2e/secrets
ns=opengeni
full=og-opengeni
log() { printf '[hosts %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

key=$(cat "$sec/compute-operator-key")
# The service's address on the cluster network, which the node reaches
# directly (a port-forward would stay bound to one replica as it rolls).
control=$(kubectl -n "$ns" get svc "$full-compute-control" -o jsonpath='{.spec.clusterIP}')
wanted=$(printf '%s\n' "$@" | jq -R . | jq -cs .)
log "waiting for $* to be live"
missing=$wanted
for _ in $(seq 120); do
  missing=$(curl -fsS --cacert "$sec/api-ca.pem" --resolve "$full-compute-control.$ns.svc:8080:$control" \
    -H "X-API-Key: $key" "https://$full-compute-control.$ns.svc:8080/v1/hosts" 2>/dev/null |
    jq -c --argjson wanted "$wanted" '$wanted - [.[] | select(.state == "live") | .name]' 2>/dev/null ||
    echo "$wanted")
  [ "$missing" = "[]" ] && break
  sleep 10
done
if [ "$missing" != "[]" ]; then
  log "not live after 20 minutes: $missing"
  exit 1
fi
log "hosts ready: $*"
