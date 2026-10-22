#!/usr/bin/env bash
# Explicit operator stages; never run write stages without a separate rollout go.
# Subshell keeps fail-stop options from killing a caller's interactive shell.
(
  set +x
  set -euo pipefail
  unset GH_DEBUG
  umask 077
  ADMIN_DIR=${1:?Usage: stage.sh EXISTING_ADMIN_DIR ACTION [ARG]}
  BATCHER_ADMIN_CODE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  PLAN="$ADMIN_DIR/plan"
  source "$BATCHER_ADMIN_CODE/read.sh"
  action=${2:?Action required}
  verify_phase() {
    local current
    current=$(batcher_snapshot)
    bun "$BATCHER_ADMIN_CODE/bundle.ts" verify "$PLAN" "$current" "$1"
  }
  reconcile_created() {
    local kind=$1 current name selected count
    name=$(jq -er --arg kind "$kind" '.[$kind].name' "$PLAN/plan.json")
    current=$(batcher_snapshot)
    selected="${current%/*}/$kind-selected.json"
    jq --arg name "$name" '[.rulesets[] | select(.name == $name and .source_type == "Repository" and .source == "Cloudgeni-ai/opengeni")]' "$current" > "$selected"
    count=$(jq 'length' "$selected")
    if [ "$count" = 0 ]; then
      # One delayed readback, never a write retry. Absence is not finality proof.
      sleep 30
      current=$(batcher_snapshot)
      selected="${current%/*}/$kind-selected.json"
      jq --arg name "$name" '[.rulesets[] | select(.name == $name and .source_type == "Repository" and .source == "Cloudgeni-ai/opengeni")]' "$current" > "$selected"
    fi
    jq -e 'length == 1' "$selected" >/dev/null || {
      echo 'No unique creation result after readback; intent stays blocked. Never blindly repeat POST.' >&2
      exit 1
    }
    jq '.[0]' "$selected" > "${current%/*}/$kind-candidate.json"
    bun "$BATCHER_ADMIN_CODE/bundle.ts" receipt "$PLAN" "$current" "$kind" "${current%/*}/$kind-candidate.json"
  }
  case "$action" in
    snapshot) batcher_snapshot; exit ;;
    identity) batcher_identity; exit ;;
    check) verify_phase "${3:?Phase required}"; exit ;;
    reconcile-guard) reconcile_created guard; exit ;;
    reconcile-namespace) reconcile_created namespace; exit ;;
    create-guard) before=original; after=guard; method=POST; payload=guard; id='' ;;
    create-namespace) before=guard; after=namespace; method=POST; payload=namespace; id='' ;;
    admit) before=namespace; after=applied; method=PUT; payload=admission; id=$(jq -er '.admissionId' "$PLAN/plan.json") ;;
    restore-admission) before=applied; after=namespace; method=PUT; payload=restore; id=$(jq -er '.admissionId' "$PLAN/plan.json") ;;
    delete-namespace) before=namespace; after=guard; method=DELETE; payload=''; id=$(jq -er '.id' "$PLAN/namespace-receipt.json") ;;
    delete-guard) before=guard; after=restored; method=DELETE; payload=''; id=$(jq -er '.id' "$PLAN/guard-receipt.json") ;;
    *) echo 'Unknown action; no API writes' >&2; exit 1 ;;
  esac
  [ "${3:-}" = --apply-after-go ] || { echo 'Write stage requires --apply-after-go and separate operator authorization' >&2; exit 1; }
  verify_phase "$before"
  # Atomic local intent prevents accidentally replaying a timed-out write after
  # process/shell restart. Receipts and rejected/ambiguous responses are retained.
  attempt="$PLAN/$action-attempt"
  mkdir "$attempt" || { echo 'Existing write intent: use read-only reconciliation, not retry' >&2; exit 1; }
  printf '%s\n' "$action" > "$attempt/intent"
  endpoint=/repos/Cloudgeni-ai/opengeni/rulesets
  if [ -n "$id" ]; then endpoint="$endpoint/$id"; fi
  args=(api --method "$method" "$endpoint")
  if [ -n "$payload" ]; then args+=(--input "$PLAN/$payload.json"); fi
  if ! gh "${args[@]}" > "$attempt/response.json" 2> "$attempt/error.log"; then
    echo "Write failed or outcome uncertain; retained $attempt. Stop writers; reconcile by readback. A 422 must not be repaired by dropping policy fields." >&2
    exit 1
  fi
  if [ "$method" = POST ]; then reconcile_created "$payload"; else verify_phase "$after"; fi
)
