# 14. Requests, limits and admission

Status: Accepted, 2026-10-16. Being built.

## Context

Host memory is used only as a guest touches it, so many sandboxes fit while
they are quiet. When they all get busy, eviction cannot help, and without a
limit the host would run out of memory and the kernel would kill a VM.
Sandboxes also get no share of processor time today.

## Decision

- Each sandbox has a **request**, which is guaranteed, and a **limit**, its
  VM size. Bursting above the request up to the limit uses free memory and
  is best effort.
- A host admits a create or wake only if the requests of its awake sandboxes
  still fit within its capacity minus fixed headroom. Before refusing, it
  makes room by pushing idle sandboxes deeper. Otherwise it answers a
  retryable "host full" that says what it would need.
- The request sets the VM cgroup's processor weight, so contention is shared
  by request. The vCPU count stays the ceiling.
- Status reports capacity (total, reserved, free) for a scheduler and an
  autoscaler. Reservations are rebuilt from records after a restart.

## Consequences

- A host never takes work it cannot hold.
- Unused guest memory costs the host nothing, so limits can be generous.
- Under pressure, a bursting sandbox is moved to another host rather than
  killed once moves exist ([15](0015-placement-and-moves-between-hosts.md));
  until then a host full of busy sandboxes refuses new work.
