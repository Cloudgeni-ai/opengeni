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
- When no host fits, idle sandboxes are put to sleep everywhere first. If
  that is not enough, the request waits in a priority queue (interactive
  before background) and the autoscaler adds a host. Autoscaling follows a
  buffer of free capacity, not single requests.
- A capped or fixed fleet uses the same queue without the autoscaler:
  capacity is handed out as it frees up, with a timeout.

## Consequences

- A host loss costs at most the work since each sandbox's last archive.
- Restoring memory on another host needs a compatible CPU (one CPU template
  per fleet); otherwise the sandbox boots fresh from its files.
