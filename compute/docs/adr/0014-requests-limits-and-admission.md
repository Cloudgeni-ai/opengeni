# 14. Requests, limits and admission

Status: Accepted, 2026-10-16. Being built.

## Context

Host memory is used only as a guest touches it, so many sandboxes fit while
they are quiet. That is overbooking: when they get busy together, actual use
can exceed the host's memory. Today nothing reserves memory or processor time
for anyone, and the host kernel's out-of-memory killer would pick a VM.

## Decision

- Each sandbox has a **request** and a **limit** (its maximum size). The sum
  of requests of awake sandboxes stays within the host's capacity minus fixed
  headroom. The check is arithmetic on numbers held in memory; a create or
  wake that does not fit gets a retryable "host full" at once.
- The request becomes the VM cgroup's memory protection and processor weight.
  A running VM can never be compressed or swapped.
- On bare-metal hosts, use above the request shares whatever is free. When
  the host runs short, background relief acts in this order, never inside a
  request:
  1. idle sandboxes leave memory, least recently used first;
  2. the balloon takes file cache back from sandboxes above their request;
  3. the sandbox furthest above its request is paused and saved, and wakes
     when there is room (or on another host, once moves exist).
- The host kernel's out-of-memory killer must not pick a VMM.
- On huge-page hosts (the nested profile) guest memory cannot be compressed or
  ballooned back, and a guest that touches memory when the pool is empty
  dies. There a sandbox's request is its limit: a running sandbox is booked
  at its full size against the huge-page pool, a paused one at what it
  holds. Running sandboxes are never overbooked; only idle sandboxes leaving
  memory (step 1) makes room.
- Status reports capacity (total, reserved, free) for a scheduler and an
  autoscaler; reservations are rebuilt from records after a restart.

## Consequences

- A sandbox that stays within its request is never squeezed, paused or
  killed for memory. Above it, it may be squeezed or paused, never lose data.
- On bare metal, how far a host overbooks (sum of limits against capacity) is
  a policy setting; the worst case of a stampede is that the heaviest
  sandboxes pause. Nested hosts hold fewer running sandboxes for the same
  memory, in exchange for cheaper wakes ([5](0005-host-memory-profiles.md)).
