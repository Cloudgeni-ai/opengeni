# 14. Requests, limits and admission

Status: Accepted, 2026-10-16. Built.

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
  huge-page pool, or memory less fixed headroom). So do VMs the agent does
  not manage: those of removed sandboxes until they have ended, and those
  it found but could not take back, at full size (the most any sandbox may
  have when not even the size can be read from its record). A VM taken back
  after a restart counts at its full size until it is first measured. A
  wake is admitted once and owns its room until the sandbox runs: one from
  object storage before it downloads anything, through its restore. On an
  overdrawn budget (after a restart with less) nothing more wakes, not even
  a resume that takes nothing more.
- Admission in create, wake and connect is arithmetic on numbers held in
  memory (microseconds). Inside a request the only relief is instant: ending
  idle VMs that already have a valid saved copy (milliseconds, no I/O). If
  that is not enough the request gets a retryable `host_full` at once,
  saying how much it needs. Nothing is paused, compressed or saved inside a
  request.
- Room is kept ahead of time in the background: the host keeps a buffer
  free (a sixteenth of capacity by default), plus what refused sandboxes
  that are still held need, by pushing idle sandboxes deeper, least
  recently used first. Held or recently busy sandboxes are never touched;
  recently busy means within one busy window and two samples, since work
  of its own is reported once per window.
- The request becomes the VM cgroup's `memory.low` while it runs (zero while
  paused) and its `cpu.weight`; the vCPU count stays the ceiling. The
  parent group's `memory.low` is kept at the sum of its VMs', since a group
  is protected only as far as its ancestors are. Not
  `memory.min`: when the host runs short beyond everything unprotected, the
  kernel then kills processes rather than reclaim from a protected group,
  and slowing a VM down is the better failure.
- A running VM is never compressed or swapped: `memory.swap.max` and
  `memory.zswap.max` are 0 from launch, after adoption and before every
  resume, and open only while the agent compresses a paused VM, with
  `memory.zswap.writeback` at 0 so nothing reaches the swap device. A host
  that compresses must have zswap on, or the agent refuses to start.
  Status shows each VM's zswap traffic and memory pressure; a running VM
  with zswap stores is a bug.
- VMMs and pagers run with `oom_score_adj` -900, so the host's
  out-of-memory killer ends nearly anything else first, and the agent with
  -999, so it outlasts the VMs it can bring back. It runs in a service unit
  of its own with a `MemoryMax`; VM cgroups lie outside it. Not -1000:
  that would make a leaking agent hang at its limit instead of restarting.
- On bare-metal hosts, use above the request shares whatever is free. When
  the host runs short, background relief acts in this order:
  1. idle sandboxes leave memory, least recently used first;
  2. the balloons of sandboxes in use above their request, furthest above
     first, ask for everything above the request; the guest gives file
     cache and free memory first and deflates the balloon rather than run
     out (`deflate_on_oom`). Relief waits a short grace
     (`balloon_grace`, 3 s) for a balloon to fill before going further,
     and lets balloons go, oldest first, once memory is back above the
     high watermark;
  3. if that is still not enough, the sandbox furthest above its request
     is paused and saved, held or not. It loses nothing: once its recorded
     footprint fits above the high watermark, next to the footprints of
     those let through before it until a reading shows them, it wakes by
     itself with its programs. Asking for it meanwhile gets `host_full`.
  Sandboxes within their request are never touched by any of these.
  A VM's balloon is let go again once it runs after any step and after
  adoption, since a restored image or an earlier agent may have left it
  set, and no balloon request reaches a VM after the one it was meant for
  has been stopped.
- Congestion is visible: the status shows `balloon_bytes` for a sandbox
  whose balloon is out and `paused_for_memory` (the bytes it held) for one
  saved for host memory, with `waiting_for_room` while it waits; refused
  requests get `host_full` with what they needed. A control plane can then
  move such a sandbox ([15](0015-placement-and-moves-between-hosts.md)).
- On huge-page hosts (the nested profile) guest memory cannot be compressed
  or ballooned back, so a sandbox's request is its limit: a running sandbox
  is booked at its full size against the pool, a paused one at the huge
  pages its processes map (counted per process: a cgroup leaves them out
  of `memory.current` unless mounted with `memory_hugetlb_accounting`). A
  guest that touches memory with the pool empty does not die: its vCPU
  retries the fault and the guest stalls until a page is free (tested).
  Booking running VMs whole keeps that from happening unless something
  outside the agent takes from the pool.
- Status reports capacity (total, reserved, occupied, free, awake);
  reservations are rebuilt from records after a restart.
- Local disk is booked the same way, because a full disk blocks the very
  saves that relieve memory. Every VM whose state is not saved yet books
  its worst-case next save: its memory size once where files share extents
  (XFS), twice where they do not (the merge writes a whole new image), plus
  64 MiB and a few inodes. Bookings plus a kept-back reserve
  (`--disk-reserve-mib`, `--disk-reserve-inodes`; by default a twentieth
  of the filesystem, at least 1 GiB and 1024 inodes) stay within what the
  filesystem has free, read every sample. A wake that cannot book its save
  gets `host_full` at once, naming disk or inodes and how much. In the
  background, while refused held sandboxes cannot book, idle sandboxes
  that are already archived to object storage give up their local copies,
  least recently used first. A step that fails, such as a save the disk
  cannot hold, shows in the sandbox's status as `failed_step` until the
  same step succeeds on a retry.

## Consequences

- A sandbox that stays within its request is never squeezed, paused or
  killed for memory. Above it, it may be squeezed or paused for a few
  seconds, never lose data.
- Whether a sandbox was paused for memory lives only in the agent: after an
  agent restart it stays Saved until it is used again.
- The room a paused sandbox waits for is its VM's cgroup footprint, file
  cache included, so it may wait somewhat longer than its guest needs.
- Free page reporting does not return huge pages, so on nested hosts a
  guest's freed memory stays booked until the VM is saved and ended.
- Nested hosts hold fewer running sandboxes for the same memory, in exchange
  for cheaper wakes ([5](0005-host-memory-profiles.md)).
- Disk bookings count saves only. A guest's own disk growth, and memory a
  remote wake writes into its local image while it hydrates, are measured
  in what is free but not booked ahead.
