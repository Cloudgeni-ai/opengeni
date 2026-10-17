#!/usr/bin/env bash
# Starts a fresh host agent for one benchmark configuration on a lab host
# prepared by ../host-setup.sh, and the relay that lets the client VM reach
# its socket. Run as root. Any agent and VMs it started before are killed and
# their state removed.
#
# Usage: host-agent.sh cold|template|pool [extra serve flags...]
#   cold      no templates: every new sandbox boots
#   template  a template for the benchmark's shape, no ready copies
#   pool      the template and READY (default 10) ready copies
#
# Settings: BIN (the compute-host binary), STORE (enables the archived and
# remote levels, such as gs://bucket/prefix), LISTEN (HOST:PORT for the
# relay), CLIENT (the client VM's address), HUGE_PAGES (2 MiB pages to
# reserve on a nested host), READY.
set -euo pipefail

mode="${1:?usage: host-agent.sh cold|template|pool [serve flags...]}"
shift
here="$(cd "$(dirname "$0")" && pwd)"
bin="${BIN:-/home/lab/compute/target/release/compute-host}"
bun="${BUN:-$(command -v bun || echo /home/lab/.bun/bin/bun)}"
store="${STORE:?set STORE}"
listen="${LISTEN:?set LISTEN}"
client="${CLIENT:?set CLIENT}"
ready="${READY:-10}"
shape="2x1024"
socket=/run/compute-host.sock
dir=/lab/compare
root=$dir/root
mkdir -p "$dir"

for pid_file in "$dir/agent.pid" "$dir/relay.pid"; do
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    kill -9 "$(cat "$pid_file")"
    while kill -0 "$(cat "$pid_file")" 2>/dev/null; do sleep 0.05; done
  fi
done
for vm in $(pgrep -x firecracker || true); do kill -9 "$vm" || true; done
sleep 0.5
rm -rf "$root"
mkdir -p "$root"

if grep -q hypervisor /proc/cpuinfo && [[ -n "${HUGE_PAGES:-}" ]]; then
  echo "$HUGE_PAGES" > /proc/sys/vm/nr_hugepages
fi

case "$mode" in
  cold) pool_flags=() ;;
  template) pool_flags=(--template-ready-port 54 --template "$shape") ;;
  pool) pool_flags=(--template-ready-port 54 --template "$shape:$ready") ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac

rm -f "$socket"
setsid nohup "$bin" --socket "$socket" serve \
  --root "$root" --firecracker /lab/bin/firecracker --jailer /lab/bin/jailer \
  --kernel /lab/vmlinux --base-image /lab/base.ext4 --store "$store/$mode-$(date +%s)" \
  --restore-notice-port 53 "${pool_flags[@]}" "$@" \
  >>"$dir/agent.log" 2>&1 </dev/null &
echo $! >"$dir/agent.pid"
for _ in $(seq 600); do
  [[ -S "$socket" ]] && break
  sleep 0.05
done

setsid nohup "$bun" "$here/relay.ts" --listen "$listen" --socket "$socket" --allow "$client" \
  >>"$dir/relay.log" 2>&1 </dev/null &
echo $! >"$dir/relay.pid"
echo "agent $(cat "$dir/agent.pid") ($mode) on $socket, relay on $listen"
