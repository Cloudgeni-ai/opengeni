#!/usr/bin/env bash
# The whole smoke suite (smoke/) against a fresh jailed host agent built from
# SRC, on a lab host: it builds the agent, makes LAB/smoke/base.ext4 from
# LAB/base.ext4 with the smoke suite's guest service, starts the agent with
# ci/smoke-agent.sh, runs every scenario, and at the end stops the agent and
# its VMs (only one agent may run per host).
#
# Usage, as a user with passwordless sudo: SRC=compute LAB=/lab ci/smoke-run.sh
# The last lines are `suite exit <status>` and `done`. A step before the
# suite that fails (the build, the image, the agent's start) ends the run
# with `suite exit 1`, so a binary or image from an earlier run is never
# tested in its place; the agent and its VMs are stopped either way.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$(cd "$HERE/.." && pwd)}
LAB=${LAB:-/lab}
export PATH=$HOME/.cargo/bin:$PATH CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$SRC/target}
BIN=$CARGO_TARGET_DIR/release/compute-host
AGENT=$HERE/smoke-agent.sh
stop() {
  sudo kill -9 "$(cat "$LAB/smoke/agent.pid" 2>/dev/null)" 2>/dev/null
  for procs in /sys/fs/cgroup/compute-smoke/*/cgroup.procs; do
    [ -f "$procs" ] && sudo xargs -r kill -9 <"$procs"
  done
  echo "agent stopped; $(pgrep -c -x firecracker) firecracker left"
  echo "$(date -u +%H:%M:%S) done"
}
failed() {
  echo "!! $1 failed"
  echo "suite exit 1"
  stop
  exit 1
}
cd "$SRC" || exit 1
echo "$(date -u +%H:%M:%S) build"
cargo build --locked --release -p compute-host --bin compute-host 2>&1 | tail -1 || failed build
echo "$(date -u +%H:%M:%S) guest image"
sudo mkdir -p "$LAB/smoke" || failed "guest image"
sudo rm -f "$LAB/smoke/base.ext4.new" "$LAB/smoke/base.ext4" || failed "guest image"
sudo cp --sparse=always "$LAB/base.ext4" "$LAB/smoke/base.ext4.new" || failed "guest image"
sudo smoke/guest/install.sh "$LAB/smoke/base.ext4.new" 2>&1 | tail -2 || failed "guest image"
sudo mv "$LAB/smoke/base.ext4.new" "$LAB/smoke/base.ext4" || failed "guest image"
echo "$(date -u +%H:%M:%S) agent"
sudo LAB="$LAB" COMPUTE_SMOKE_AGENT_BIN="$BIN" "$AGENT" fresh || failed agent
cd smoke || failed suite
echo "$(date -u +%H:%M:%S) suite"
COMPUTE_SMOKE_SOCKET=/run/compute-smoke.sock \
  COMPUTE_SMOKE_RESTART_AGENT="sudo LAB=$LAB COMPUTE_SMOKE_AGENT_BIN=$BIN $AGENT restart" \
  timeout 1800 python3 -m compute_smoke run --all
echo "suite exit $?"
stop
