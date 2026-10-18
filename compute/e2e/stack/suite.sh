#!/usr/bin/env bash
# Runs the suite (suite/run.ts) on the stack VM against the deployed stack
# (env.sh suite). Results land in ~/e2e/runs/$RUN: results.json,
# results.md, the suite's log and the UI pass's screenshots.
set -euo pipefail
: "${RUN:?}" "${PROJECT:?}" "${ZONE:?}"
export PATH=$HOME/.cargo/bin:$HOME/.bun/bin:/snap/bin:$PATH
export KUBECONFIG=$HOME/.kube/config
# shellcheck disable=SC1091
. "$HOME/e2e/endpoints.env"
sec=$HOME/e2e/secrets
[ -s "$sec/model.env" ] || { echo "no model: run env.sh model-up and deploy first" >&2; exit 1; }
# shellcheck disable=SC1091
. "$sec/model.env"
og=/srv/e2e/opengeni
out=$HOME/e2e/runs/$RUN
mkdir -p "$out"
log() { printf '[suite %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

if [ ! -d "$og/node_modules/playwright" ]; then
  log "bun install in the Opengeni checkout"
  (cd "$og" && bun install --frozen-lockfile >/dev/null)
fi
if [ ! -f "$HOME/.cache/ms-playwright/.e2e-chromium" ]; then
  log "Playwright's Chromium"
  # Playwright's command runs under Bun: the VM has no Node.
  (cd "$og" && sudo env "PATH=$PATH" bun node_modules/playwright/cli.js install-deps chromium >/dev/null &&
    bun node_modules/playwright/cli.js install chromium >/dev/null)
  touch "$HOME/.cache/ms-playwright/.e2e-chromium"
fi
contract=$(grep -o 'OPENGENI_API_CONTRACT_REVISION = "[^"]*"' "$og/packages/contracts/src/index.ts" | cut -d'"' -f2)

kubectl -n opengeni port-forward "svc/${COMPUTE_SERVICE%%.*}" 18080:8080 >"$out/port-forward.log" 2>&1 &
forward=$!
trap 'kill $forward 2>/dev/null || true' EXIT
sleep 3

log "run $RUN"
started=$(date -u +%s)
status=0
OPENGENI_URL=$OPENGENI_URL API_CONTRACT=$contract MODEL=$MODEL_DEPLOYMENT OUT=$out \
  COMPUTE_SERVICE=$COMPUTE_SERVICE COMPUTE_PORT=18080 COMPUTE_CA=$sec/api-ca.pem \
  COMPUTE_OPENGENI_KEY=$sec/compute-opengeni-key COMPUTE_OPERATOR_KEY=$sec/compute-operator-key \
  PROJECT=$PROJECT ZONE=$ZONE HOSTS=${HOSTS:-3} ONLY=${ONLY:-} \
  PLAYWRIGHT_MODULE=$og/node_modules/playwright/index.js \
  OPENGENI_SHA=${OPENGENI_SHA:-} COMPUTE_SHA=${COMPUTE_SHA:-} \
  bun "$HOME/e2e/suite/run.ts" || status=$?
kubectl -n opengeni logs "deploy/${COMPUTE_SERVICE%%.*}" --since=2h >"$out/compute-control.log" 2>&1 || true
for part in api worker-turns worker-control; do
  kubectl -n opengeni logs "deploy/og-opengeni-$part" --since=2h --all-containers >"$out/$part.log" 2>&1 || true
done
# Failure records since the run began (diagnostics.py).
since=$(date -u -d "@$started" +%Y-%m-%dT%H:%M:%SZ)
[ -f "$HOME/e2e/diagnostics.jsonl" ] &&
  jq -c --arg since "$since" 'select(.receivedAt >= $since)' \
    "$HOME/e2e/diagnostics.jsonl" >"$out/diagnostics.jsonl" 2>/dev/null || true
exit "$status"
