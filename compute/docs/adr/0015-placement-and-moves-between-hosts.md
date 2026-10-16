# 15. Placement and moving sandboxes between hosts

Status: Proposed, 2026-10-16

## Context

Each host keeps its sandbox records on its own disk. Archives already hold
everything needed to restore a sandbox elsewhere, and the guest network is
the same on every host ([11](0011-fixed-guest-network.md)). What is missing
is a control plane that decides which host runs what.

## Decision

- A sandbox's home is object storage, not a host. A central record says
  which host owns it, under a lease carrying a generation fence, so two hosts
  can never run one sandbox.
- Moving a sandbox: its host saves and archives it, the lease passes to the
  new host, and that host wakes it lazily from object storage. Sleep is the
  natural moment to move; live migration of a running VM is out of scope.
- Placement puts a sandbox where its request fits, preferring the host that
  still has its local copy.
- Slow work never sits in a request's path:
  - A wake goes straight to the sandbox's current host, found in memory; no
    scheduling happens. This is almost every request.
  - Hosts push their capacity (free, reserved, ready clones per shape) to
    the control plane on change, coalesced. Placement decides from that
    in-memory view in microseconds and never asks hosts while deciding.
  - The host's admission check is the authority and takes microseconds. A
    stale view only costs a fast "host full" and one retry on the next
    candidate. There is no global lock.
  - Each host keeps a free-memory buffer in the background by putting idle,
    already-saved sandboxes out of memory, so admission is a check, not an
    eviction.
  - Leases are renewed per host, not per sandbox. The only durable central
    write in a request is the owner record for a new or moved sandbox, and
    it runs alongside the VM work.
  - The autoscaler watches the fleet's total buffer and adds hosts before
    it runs out. The capacity queue (interactive before background, with a
    timeout) is the rare overflow, not the normal path.
- A capped or fixed fleet uses the same queue without the autoscaler:
  capacity is handed out as it frees up.
- Budget: the control plane adds at most a few milliseconds to a wake or a
  create, at fleet scale, checked by a simulation of thousands of hosts.

## Consequences

- A host loss costs at most the work since each sandbox's last archive.
- Restoring memory on another host needs a compatible CPU (one CPU template
  per fleet); otherwise the sandbox boots fresh from its files.
