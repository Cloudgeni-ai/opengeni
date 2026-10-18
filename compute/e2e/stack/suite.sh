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
# What was built (build.sh), which results name.
# shellcheck disable=SC1091
. "$HOME/e2e/out/build.env"
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

# The agent the sandbox image carries, for the connected-machine check: the
# same build, enrolled as this VM.
agent=$HOME/e2e/agent/$SANDBOX_REF
if [ ! -x "$agent/opengeni-agent" ]; then
  mkdir -p "$agent"
  holder=$(docker create "$SANDBOX_REF")
  docker cp "$holder:/usr/local/bin/opengeni-agent" "$agent/opengeni-agent"
  docker rm "$holder" >/dev/null
fi

# The fleet service on the cluster network, which this node reaches directly.
fabric=$(kubectl -n opengeni get svc "${COMPUTE_SERVICE%%.*}" -o jsonpath='{.spec.clusterIP}')

log "run $RUN"
started=$(date -u +%s)
status=0
OPENGENI_URL=$OPENGENI_URL API_CONTRACT=$contract MODEL=$MODEL_DEPLOYMENT OUT=$out \
  COMPUTE_SERVICE=$COMPUTE_SERVICE COMPUTE_ADDRESS=$fabric COMPUTE_PORT=8080 COMPUTE_CA=$sec/api-ca.pem \
  COMPUTE_OPENGENI_KEY=$sec/compute-opengeni-key COMPUTE_OPERATOR_KEY=$sec/compute-operator-key \
  PROJECT=$PROJECT ZONE=$ZONE HOSTS=${HOSTS:-3} ONLY=${ONLY:-} \
  PLAYWRIGHT_MODULE=$og/node_modules/playwright/index.js AGENT_BIN=$agent/opengeni-agent \
  OPENGENI_SHA=$OPENGENI_LABEL COMPUTE_SHA=$COMPUTE_SHA \
  bun "$HOME/e2e/suite/run.ts" || status=$?
# Every replica's log, each line prefixed with its pod.
for part in compute-control api worker-turns worker-control relay; do
  kubectl -n opengeni logs -l "app.kubernetes.io/component=$part" --prefix --all-containers --tail=-1 \
    --max-log-requests=20 --since=2h >"$out/$part.log" 2>&1 || true
done
# Failure records since the run began (diagnostics.py).
since=$(date -u -d "@$started" +%Y-%m-%dT%H:%M:%SZ)
[ -f "$HOME/e2e/diagnostics.jsonl" ] &&
  jq -c --arg since "$since" 'select(.receivedAt >= $since)' \
    "$HOME/e2e/diagnostics.jsonl" >"$out/diagnostics.jsonl" 2>/dev/null || true
exit "$status"
