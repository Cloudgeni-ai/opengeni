#!/usr/bin/env bash
# Runs one suite of the comparison benchmark from the client machine and
# writes one JSON-lines file per operation under $RESULTS. See README.md.
#
#   RESULTS=~/results bash run.sh ours-activate [LEVEL...]  # agent in any mode
#   RESULTS=~/results bash run.sh ours-create pool  # agent restarted in that mode
#   RESULTS=~/results bash run.sh gke-latency
#   RESULTS=~/results bash run.sh ours-rate saved 300 5,10,20,50,100
#   RESULTS=~/results bash run.sh gke-rate running 60 1,2,5,10,20
set -euo pipefail
cd "$(dirname "$0")"
RESULTS=${RESULTS:?set RESULTS to a directory}
RUNS=${RUNS:-3}
COUNT=${COUNT:-30}
WARMUP=${WARMUP:-5}
mkdir -p "$RESULTS"

latency() { # system op [count]
  local file="$RESULTS/$1-${2/:/-}.jsonl"
  # Let the system release what the previous operation's sandboxes held.
  sleep "${SETTLE_SECONDS:-5}"
  echo "== $1 $2 -> $file"
  bun bench.ts latency --system "$1" --op "$2" --runs "$RUNS" --count "${3:-$COUNT}" --warmup "$WARMUP" --out "$file"
}

rate() { # system level sandboxes ladder
  local file="$RESULTS/$1-rate-$2.jsonl"
  echo "== $1 rate $2 with $3 sandboxes -> $file"
  sleep "${SETTLE_SECONDS:-5}"
  bun bench.ts rate --system "$1" --level "$2" --sandboxes "$3" --ladder "$4" \
    --p99-limit-ms "${P99_LIMIT_MS:-1000}" --step-seconds "${STEP_SECONDS:-60}" --warmup-seconds "${WARMUP_SECONDS:-10}" \
    --refinements "${REFINEMENTS:-3}" --repeats "${REPEATS:-1}" --seed "${SEED:-1}" --out "$file"
}

suite=${1:?suite}
shift
case "$suite" in
  ours-activate)
    levels=("$@")
    [[ ${#levels[@]} -gt 0 ]] || levels=(running paused saved archived remote)
    for level in "${levels[@]}"; do latency ours "activate:$level"; done
    ;;
  ours-create) latency ours "create:${1:?cold, template or pool}" ;;
  gke-latency)
    latency gke create:pool
    latency gke create:cold
    latency gke activate:running
    latency gke activate:snapshot "${SNAPSHOT_COUNT:-20}"
    ;;
  ours-rate) rate ours "$@" ;;
  gke-rate) rate gke "$@" ;;
  *) echo "unknown suite $suite" >&2; exit 2 ;;
esac
