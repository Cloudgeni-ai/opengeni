#!/usr/bin/env bash
# The whole smoke suite (smoke/) against a fresh jailed host agent built from
# SRC, on a lab host: it builds the agent, makes LAB/smoke/base.ext4 from
# LAB/base.ext4 with the smoke suite's guest service, starts the agent with
# ci/smoke-agent.sh, runs every scenario, and at the end stops the agent and
# its VMs (only one agent may run per host).
#
# Usage, as a user with passwordless sudo: SRC=compute LAB=/lab ci/smoke-run.sh
# The last lines are `suite exit <status>` and `done`.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$(cd "$HERE/.." && pwd)}
LAB=${LAB:-/lab}
export PATH=$HOME/.cargo/bin:$PATH CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$SRC/target}
BIN=$CARGO_TARGET_DIR/release/compute-host
AGENT=$HERE/smoke-agent.sh
cd "$SRC" || exit 1
echo "$(date -u +%H:%M:%S) build"
cargo build --locked --release -p compute-host --bin compute-host 2>&1 | tail -1
echo "$(date -u +%H:%M:%S) guest image"
sudo mkdir -p "$LAB/smoke"
sudo rm -f "$LAB/smoke/base.ext4.new"
sudo cp --sparse=always "$LAB/base.ext4" "$LAB/smoke/base.ext4.new"
sudo smoke/guest/install.sh "$LAB/smoke/base.ext4.new" 2>&1 | tail -2
sudo mv "$LAB/smoke/base.ext4.new" "$LAB/smoke/base.ext4"
echo "$(date -u +%H:%M:%S) agent"
sudo LAB="$LAB" COMPUTE_SMOKE_AGENT_BIN="$BIN" "$AGENT" fresh
cd smoke || exit 1
echo "$(date -u +%H:%M:%S) suite"
COMPUTE_SMOKE_SOCKET=/run/compute-smoke.sock \
  COMPUTE_SMOKE_RESTART_AGENT="sudo LAB=$LAB COMPUTE_SMOKE_AGENT_BIN=$BIN $AGENT restart" \
  timeout 1800 python3 -m compute_smoke run --all
echo "suite exit $?"
sudo kill -9 "$(cat "$LAB/smoke/agent.pid")" 2>/dev/null
for procs in /sys/fs/cgroup/compute-smoke/*/cgroup.procs; do
  [ -f "$procs" ] && sudo xargs -r kill -9 <"$procs"
done
echo "agent stopped; $(pgrep -c -x firecracker) firecracker left"
echo "$(date -u +%H:%M:%S) done"
