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
  INPUT_PLAN="${BATCHER_VERIFIED_PLAN:-$PLAN}"
  source "$BATCHER_ADMIN_CODE/read.sh"
  action=${2:?Action required}
  verify_phase() {
    local current
    current=$(batcher_snapshot)
    bun "$BATCHER_ADMIN_CODE/bundle.ts" verify "$PLAN" "$current" "$1"
  }
  verify_stable() {
    verify_phase "$1"
    sleep 30
    verify_phase "$1"
  }
  reconcile_created() {
    local kind=$1 current name selected count
    name=$(jq -er --arg kind "$kind" '.[$kind].name' "$INPUT_PLAN/plan.json")
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
  reissue=false
  case "$action" in
    reissue-restore-admission|reissue-delete-namespace|reissue-delete-guard)
      reissue=true; action=${action#reissue-} ;;
  esac
  case "$action" in
    snapshot) batcher_snapshot; exit ;;
    identity) batcher_identity; exit ;;
    check) verify_phase "${3:?Phase required}"; exit ;;
    check-stable) verify_stable "${3:?Phase required}"; exit ;;
    reconcile-admit)
      verify_stable applied
      test -d "$PLAN/admit-attempt"
      touch "$PLAN/admit-attempt/verified"
      exit ;;
    reconcile-guard) reconcile_created guard; exit ;;
    reconcile-namespace) reconcile_created namespace; exit ;;
    create-guard) before=original; after=guard; method=POST; payload=guard; id='' ;;
    create-namespace) before=guard; after=namespace; method=POST; payload=namespace; id='' ;;
    admit) before=namespace; after=applied; method=PUT; payload=admission; id=$(jq -er '.admissionId' "$INPUT_PLAN/plan.json") ;;
    restore-admission) before=applied; after=namespace; method=PUT; payload=restore; id=$(jq -er '.admissionId' "$INPUT_PLAN/plan.json") ;;
    delete-namespace) before=namespace; after=guard; method=DELETE; payload=''; id=$(jq -er '.id' "$INPUT_PLAN/namespace-receipt.json") ;;
    delete-guard) before=guard; after=restored; method=DELETE; payload=''; id=$(jq -er '.id' "$INPUT_PLAN/guard-receipt.json") ;;
    *) echo 'Unknown action; no API writes' >&2; exit 1 ;;
  esac
  [ "${3:-}" = --apply-after-go ] || { echo 'Write stage requires --apply-after-go and separate operator authorization' >&2; exit 1; }
  case "$action" in
    create-guard|create-namespace|admit)
      jq -e --slurpfile identity "$ADMIN_DIR/identity-receipt.json" --slurpfile manifest "$BATCHER_ADMIN_CODE/app-manifest.json" \
        '$identity[0].appId == .appId and $identity[0].installationId == .installationId and $identity[0].repository == .before.repository.full_name and ($identity[0].permissions | del(.metadata)) == $manifest[0].default_permissions and $identity[0].permissions.metadata == "read"' "$INPUT_PLAN/plan.json" >/dev/null ;;
  esac
  # Compare parallel payload files before doing anything remotely. The actual
  # request is generated from the verified plan, not from these editable copies.
  if [ -n "$payload" ]; then
    jq -e --arg key "$payload" --slurpfile body "$INPUT_PLAN/$payload.json" '.[$key] == $body[0]' "$INPUT_PLAN/plan.json" >/dev/null
  fi
  case "$action" in
    delete-namespace|delete-guard)
      if [ -d "$PLAN/admit-attempt" ] && [ ! -f "$PLAN/admit-attempt/verified" ]; then
        echo 'Unresolved forward admission write: keep guards. Readback absence cannot rule out a late PUT.' >&2
        exit 1
      fi ;;
  esac
  if $reissue; then verify_stable "$before"; else verify_phase "$before"; fi
  # Atomic local intent prevents accidentally replaying a timed-out write after
  # process/shell restart. Receipts and rejected/ambiguous responses are retained.
  attempt="$PLAN/$action-attempt"
  endpoint=/repos/Cloudgeni-ai/opengeni/rulesets
  if [ -n "$id" ]; then endpoint="$endpoint/$id"; fi
  prepared=$(mktemp -d "$INPUT_PLAN/prepared.XXXXXX")
  jq -n --arg method "$method" --arg endpoint "$endpoint" '{method:$method,endpoint:$endpoint}' > "$prepared/request-meta.json"
  if [ -n "$payload" ]; then jq -S --arg key "$payload" '.[$key]' "$INPUT_PLAN/plan.json" > "$prepared/request.json"; fi
  if $reissue; then
    # Reverse PUT/DELETE only. Preserve every old attempt and prove the request
    # is identical before archiving it. POST/admit have no reissue action.
    test -d "$attempt"
    cmp "$prepared/request-meta.json" "$attempt/request-meta.json"
    if [ -n "$payload" ]; then cmp "$prepared/request.json" "$attempt/request.json"; fi
    lock="$PLAN/$action-reissue-lock"
    mkdir "$lock" || { echo 'Another reverse reissue owns this local plan' >&2; exit 1; }
    trap 'rmdir -- "$lock"' EXIT
    archive=$(mktemp -d "$PLAN/$action-archive.XXXXXX")
    mv "$attempt" "$archive/attempt"
  fi
  mkdir "$attempt" || { echo 'Existing write intent: reconcile or use an explicit reverse-only reissue' >&2; exit 1; }
  printf '%s\n' "$action" > "$attempt/intent"
  cp "$prepared/request-meta.json" "$attempt/request-meta.json"
  if [ -n "$payload" ]; then cp "$prepared/request.json" "$attempt/request.json"; fi
  args=(api --method "$method" "$endpoint")
  if [ -n "$payload" ]; then args+=(--input "$prepared/request.json"); fi
  if ! gh "${args[@]}" > "$attempt/response.json" 2> "$attempt/error.log"; then
    echo "Write failed or outcome uncertain; retained $attempt. Stop writers; reconcile by readback. A 422 must not be repaired by dropping policy fields." >&2
    exit 1
  fi
  if [ "$method" = POST ]; then
    reconcile_created "$payload"
  elif [ "$after" = restored ]; then
    verify_stable "$after"
  else
    verify_phase "$after"
  fi
  touch "$attempt/verified"
)
