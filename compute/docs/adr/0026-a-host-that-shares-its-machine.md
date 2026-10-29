# 26. A host that shares its machine

Status: Accepted, 2026-10-29

## Context

A compute host has so far had its machine to itself: a cloud instance, or
a VM of its own on a hypervisor. A VM costs a second kernel, nested
memory faults and a fixed slice of memory the hypervisor cannot lend.
Running the agent directly on a hypervisor that also runs other VMs
avoids that, but two of a host's rules then reach past compute:

- **The fence resets the machine.** The guard feeds the machine's watchdog
  (`softdog` with `nowayout`, or a hardware one), and stops feeding it when
  it cannot vouch that the VMs stop at the end of the lease; if the guard
  stalls or ends, the machine resets within 3 s
  ([18](0018-the-control-service-leases-and-fences.md)). On a shared machine
  that reset ends the other VMs as well.
- **Machine-wide settings.** `host-setup` turns transparent huge pages off,
  sizes zswap's pool and the swap file from the whole machine, and loads
  the watchdog. Others' guests on a hypervisor use huge pages, and the
  sandboxes may use only part of its memory
  ([24](0024-busy-sandboxes-are-slowed-never-frozen.md) gives them a declared
  share: `--memory-total-mib`).

## Decision

- **`COMPUTE_MACHINE=shared`** in `host.env` marks a host that shares its
  machine; `dedicated` stays the default. A shared host must declare the
  sandboxes' share of memory (`COMPUTE_MEMORY_TOTAL_MIB`, which `host-setup`
  sizes the machine-wide settings against and the agent reads as its
  `--memory-total-mib` when that flag is not given; blank means no share).
- **The guard feeds systemd's watchdog of its own service instead of the
  machine's** (`compute-host guard --watchdog service`, `WatchdogSec=3s`,
  the lease terms' W). It feeds it at exactly the steps that would feed the
  machine's, refuses to start under a longer `WatchdogSec=`, and is ready
  only once a feed got through. systemd kills a guard that stops feeding it
  (`WatchdogSignal=SIGKILL`).
- **The service's stop hook does what the reset did, to compute alone.**
  After every end of the guard, however it ended (killed by its watchdog,
  crashed, failed to start, stopped), `ExecStopPost=compute-host
  guard-stopped` kills every VM (`cgroup.kill` on the VMs' cgroup, again
  until it is empty) and restarts the agent if it runs, which starts a new
  guard with it. A stop on purpose, with the agent, stays stopped. So the
  safety budget holds unchanged: W after the last feed systemd kills the
  guard, and the hook's kill stops the VMs within S. The other VMs never
  notice.
- **A hand-over is the one end that keeps the VMs.** An upgrade marks it
  (`compute-host hand-over-guard`, a mark beside the guard's lock, good for
  10 s) and restarts the guard's service. The old guard ends only at a step
  that may feed its watchdog, as asked to stop it always does; the hook
  leaves the VMs only if the guard ended so (`SERVICE_RESULT=success`)
  within a fresh mark, and takes the mark either way. The new guard must
  feed its own watchdog within W of starting, as any guard must.
- **Machine-wide settings stay the machine's.** A shared host loads no
  watchdog, leaves transparent huge pages alone unless they are `always`
  (then `madvise`: the VMs never ask for them), and sizes its swap file and
  zswap's pool from its share. `check-host` refuses to start the agent on a
  shared host whose guard lacks the watchdog or the hook.
- **systemd is outside the guarantee.** A guard that stalls while systemd
  stalls too is never killed. A shared machine should let systemd feed its
  hardware watchdog (`RuntimeWatchdogSec=`), which resets the machine only
  if systemd itself stops: a machine that broken has lost its other work
  anyway.

## Consequences

- A hypervisor runs compute next to its other guests, with no nested
  virtualization: bare-metal memory faults, the Compressed level, and no
  memory held for a host VM's kernel.
- A guard that ends costs the host's running programs, as before, but no
  longer the machine: the agent and a new guard are back in a second, and
  sandboxes restore from what they saved. The fleet still gives up on the
  host only after the margin.
- The fence now also rests on systemd: its watchdog timer and its running
  of the hook. `cgroup.kill` cannot be refused, and a VM with a kill
  pending runs no more guest code even while its process waits to exit.
- A shared machine's other work can swap into compute's swap file under
  pressure. Memory pinned for device passthrough never does; keep other
  services out with their own `MemorySwapMax=0` if that matters.
