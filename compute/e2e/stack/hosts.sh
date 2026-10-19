#!/usr/bin/env bash
# The control service's view of the group's hosts, on the stack VM, for
# env.sh hosts (after deploy):
#
#   hosts.sh live <count> <host>...
#     waits until the control service reports every named host live, and
#     at least <count> of them: the run's hosts are registered with the
#     control service under test.
#   hosts.sh issued <host>=<not-after>...
#     checks that each host's certificate (its notAfter, Unix seconds, read
#     on the host) is one the deployed control service issued it: a line
#     "issued a host certificate" for that host and that notAfter in the
#     logs of the pods of the Deployment's current revision (deploy.sh
#     waited until the older revision's pods were gone). Exits 3 naming
#     the hosts whose certificate is not, on its last line:
#     "not issued by the deployed control service: <host>...".
set -euo pipefail
export KUBECONFIG=$HOME/.kube/config
sec=$HOME/e2e/secrets
ns=opengeni
full=og-opengeni
log() { printf '[hosts %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
usage() {
  echo "usage: hosts.sh live <count> <host>... | hosts.sh issued <host>=<not-after>..." >&2
  exit 2
}

live() {
  local count=$1 key control wanted live missing
  shift
  [ $# -ge "$count" ] || { log "$# hosts named, fewer than $count"; exit 1; }
  key=$(cat "$sec/compute-operator-key")
  # The service's address on the cluster network, which the node reaches
  # directly (a port-forward would stay bound to one replica as it rolls).
  control=$(kubectl -n "$ns" get svc "$full-compute-control" -o jsonpath='{.spec.clusterIP}')
  wanted=$(printf '%s\n' "$@" | jq -R . | jq -cs .)
  log "waiting for $* to be live (at least $count)"
  missing=$wanted
  live="[]"
  for _ in $(seq 120); do
    # The named hosts the service reports live.
    live=$(curl -fsS --cacert "$sec/api-ca.pem" --resolve "$full-compute-control.$ns.svc:8080:$control" \
      -H "X-API-Key: $key" "https://$full-compute-control.$ns.svc:8080/v1/hosts" 2>/dev/null |
      jq -c --argjson wanted "$wanted" \
        '[.[] | select(.state == "live") | .name] as $live | $wanted | map(select(. as $name | $live | index($name)))' \
        2>/dev/null ||
      echo "[]")
    missing=$(jq -cn --argjson wanted "$wanted" --argjson live "$live" '$wanted - $live')
    [ "$missing" = "[]" ] && [ "$(jq length <<<"$live")" -ge "$count" ] && break
    sleep 10
  done
  if [ "$missing" != "[]" ] || [ "$(jq length <<<"$live")" -lt "$count" ]; then
    log "not live after 20 minutes: $missing ($(jq length <<<"$live") of at least $count live)"
    exit 1
  fi
  log "hosts live: $*"
}

issued() {
  local deploy=$full-compute-control revision hash logs pair name not_after stale=()
  revision=$(kubectl -n "$ns" get deploy "$deploy" \
    -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
  hash=$(kubectl -n "$ns" get rs -l app.kubernetes.io/component=compute-control -o json |
    jq -r --arg revision "$revision" \
      '.items[] | select(.metadata.annotations["deployment.kubernetes.io/revision"] == $revision) | .metadata.labels["pod-template-hash"]')
  [ -n "$hash" ] || { log "no ReplicaSet of $deploy is at its revision $revision"; exit 1; }
  # "<host> <not_after_ms>" for every certificate the current revision's
  # pods issued (their logs are coloured).
  logs=$(kubectl -n "$ns" logs -l "app.kubernetes.io/component=compute-control,pod-template-hash=$hash" \
    --all-containers --tail=-1 | sed 's/\x1b\[[0-9;]*m//g' |
    sed -nE 's/.*issued a host certificate host=([^ ]+) .*not_after_ms=([0-9]+).*/\1 \2/p')
  for pair in "$@"; do
    name=${pair%%=*}
    not_after=${pair#*=}
    if grep -qxF "$name ${not_after}000" <<<"$logs"; then
      log "$name: its certificate (until $(date -u -d "@$not_after" +%FT%TZ)) is from revision $revision ($hash)"
    else
      stale+=("$name")
    fi
  done
  if [ ${#stale[@]} -gt 0 ]; then
    log "not issued by the deployed control service: ${stale[*]}"
    exit 3
  fi
}

case "${1:-}" in
  live)
    [ $# -ge 3 ] || usage
    shift
    live "$@"
    ;;
  issued)
    [ $# -ge 2 ] || usage
    shift
    issued "$@"
    ;;
  *) usage ;;
esac
