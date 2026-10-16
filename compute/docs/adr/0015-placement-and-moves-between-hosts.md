# 15. Placement and moving sandboxes between hosts

Status: Proposed, 2026-10-16

## Context

Each host keeps its sandbox records on its own disk. Archives hold a
sandbox's disk and memory, but not its configuration or who owns it. A host
that is cut off keeps its VMs running, because VMs outlive their agent.

## Decision

- A central store holds each sandbox's configuration, its owner host, and
  its latest archived generation. Ownership is a lease carrying a generation
  fence.
- Execution fencing: a host that cannot renew its lease stops its VMs itself
  within a fixed time. A lease is granted elsewhere only after that time plus
  a margin. Archive writes carry the generation, and the store refuses writes
  from an older one.
- Moving a sandbox: its host saves and archives it, the lease passes, and the
  new host wakes it lazily from object storage. Sleep is the natural moment to
  move; live migration of a running VM is out of scope. Open connections do
  not survive a move.
- Slow work never sits in a request's path:
  - A wake goes straight to the sandbox's current host, found in memory; no
    scheduling happens. This is almost every request.
  - Hosts push their capacity (free, reserved, ready clones per shape) to the
    control plane on change, coalesced. Placement decides from that view in
    microseconds and never asks hosts while deciding.
  - The host's admission check is the authority. A stale view costs one fast
    "host full" and a retry on the next candidate. There is no global lock.
  - Leases are renewed per host, not per sandbox. The only central write in a
    request is the owner record of a new or moved sandbox, done alongside the
    VM work.
  - The autoscaler watches the fleet's spare capacity and adds hosts before it
    runs out. A queue (interactive before background, with a timeout) handles
    the rare overflow, and is all a capped or fixed fleet has.
- Budget: the control plane adds at most a few milliseconds to a wake or a
  create, checked by a simulation of thousands of hosts.

## Consequences

- Losing a host costs what changed since each sandbox's last archive.
- Restoring memory on another host needs a compatible CPU (one CPU template
  per fleet); otherwise the sandbox boots fresh from its files.
