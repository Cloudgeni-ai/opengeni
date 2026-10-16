# 14. Requests, limits and admission

Status: Accepted, 2026-10-16. Built except relief steps 2 and 3.

## Context

Host memory is used only as a guest touches it, so many sandboxes fit while
they are quiet. That is overbooking: when they get busy together, actual use
can exceed the host's memory. Without admission nothing reserves memory or
processor time for anyone, and the host kernel's out-of-memory killer would
pick a VM.

## Decision

- Each sandbox has a **request** and a **limit** (its maximum size). The
  requests of awake and waking sandboxes, plus what paused ones still hold
  and any use above a request, stay within the host's capacity (the
  huge-page pool, or memory less fixed headroom).
- Admission in create, wake and connect is arithmetic on numbers held in
  memory (microseconds). Inside a request the only relief is instant: ending
  idle VMs that already have a valid saved copy (milliseconds, no I/O). If
  that is not enough the request gets a retryable `host_full` at once,
  saying how much it needs. Nothing is paused, compressed or saved inside a
  request.
- Room is kept ahead of time in the background: the host keeps a buffer
  free (a sixteenth of capacity by default), plus what refused sandboxes
  that are still held need, by pushing idle sandboxes deeper, least
  recently used first. Held or recently busy sandboxes are never touched.
- The request becomes the VM cgroup's `memory.low` while it runs (zero while
  paused) and its `cpu.weight`; the vCPU count stays the ceiling. Not
  `memory.min`: when the host runs short beyond everything unprotected, the
  kernel then kills processes rather than reclaim from a protected group,
  and slowing a VM down is the better failure.
- A running VM is never compressed or swapped: `memory.zswap.max` is 0 from
  launch, after adoption and before every resume, and opens only while the
  agent compresses a paused VM. With `memory.zswap.writeback` at 0 a page
  zswap refuses is not swapped out either. Status shows each VM's zswap
  traffic and memory pressure; a running VM with zswap stores is a bug.
- VMMs and pagers run with `oom_score_adj` -900, so the host's
  out-of-memory killer ends nearly anything else first.
- On bare-metal hosts, use above the request shares whatever is free. When
  the host runs short, background relief acts in this order:
  1. idle sandboxes leave memory, least recently used first (built);
  2. the balloon takes file cache back from sandboxes above their request
     (not built);
  3. the sandbox furthest above its request is paused and saved, and wakes
     when there is room (not built).
- On huge-page hosts (the nested profile) guest memory cannot be compressed
  or ballooned back, so a sandbox's request is its limit: a running sandbox
  is booked at its full size against the pool, a paused one at what its
  cgroup holds. A guest that touches memory with the pool empty does not
  die: its vCPU retries the fault and the guest stalls until a page is free
  (tested). Booking running VMs whole keeps that from happening unless
  something outside the agent takes from the pool.
- Status reports capacity (total, reserved, occupied, free, awake);
  reservations are rebuilt from records after a restart.

## Consequences

- A sandbox that stays within its request is never squeezed, paused or
  killed for memory. Above it, it may be squeezed or, once step 3 exists,
  paused, never lose data.
- Until steps 2 and 3 exist, a bare-metal host whose busy sandboxes all grow
  past their requests relies on the kernel reclaiming file cache and
  unprotected memory; VMMs are the last processes its out-of-memory killer
  picks.
- Free page reporting does not return huge pages, so on nested hosts a
  guest's freed memory stays booked until the VM is saved and ended.
- Nested hosts hold fewer running sandboxes for the same memory, in exchange
  for cheaper wakes ([5](0005-host-memory-profiles.md)).
