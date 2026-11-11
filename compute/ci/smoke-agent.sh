#!/usr/bin/env bash
# Starts the jailed host agent the smoke suite talks to, on a lab host.
# Usage, as root:
#   smoke-agent.sh fresh   [extra serve flags...]  wipe its state and VMs, then start
#   smoke-agent.sh restart [extra serve flags...]  SIGKILL the agent only, keep VMs and state
# Settings: LAB (/lab), COMPUTE_SMOKE_AGENT_BIN (the compute-host binary).
set -euo pipefail
mode="$1"
shift
LAB=${LAB:-/lab}
bin=${COMPUTE_SMOKE_AGENT_BIN:?the compute-host binary}
socket=/run/compute-smoke.sock
pid_file=$LAB/smoke/agent.pid
root=$LAB/smoke/root
if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  kill -9 "$(cat "$pid_file")"
  while kill -0 "$(cat "$pid_file")" 2>/dev/null; do sleep 0.05; done
fi
if [[ "$mode" == fresh ]]; then
  for procs in /sys/fs/cgroup/compute-smoke/*/cgroup.procs; do
    [ -f "$procs" ] && xargs -r kill -9 <"$procs"
  done
  sleep 0.5
  rm -rf "$root" "$LAB/smoke/store"
  mkdir -p "$root" "$LAB/smoke/store"
fi
rm -f "$socket"
setsid nohup "$bin" --socket "$socket" serve \
  --root "$root" --firecracker "$LAB/bin/firecracker" --jailer "$LAB/bin/jailer" \
  --kernel "$LAB/vmlinux" --base-image "$LAB/smoke/base.ext4" --store "$LAB/smoke/store" \
  --cgroup /sys/fs/cgroup/compute-smoke --restore-notice-port 56 "$@" \
  >>"$LAB/smoke/agent.log" 2>&1 </dev/null &
echo $! >"$pid_file"
for _ in $(seq 600); do
  [[ -S "$socket" ]] && break
  sleep 0.05
done
chmod 666 "$socket"
echo "agent $(cat "$pid_file") on $socket ($mode)"
