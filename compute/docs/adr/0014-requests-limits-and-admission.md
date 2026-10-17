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
     high watermark. A balloon let go claims the room it will take back,
     like a wake, until its VM confirms the balloon is empty and a later
     reading shows it, so the two never spend the same free memory; a
     setting still pending or refused keeps its claim. Setting the target
     is not enough: a let-go is confirmed only once the device's
     statistics, turned on at boot, report the guest holds no page in
     the balloon (within 10 s, else it is retried). A VM restored from an
     image booted without statistics cannot report it, and statistics
     cannot be turned on after boot; its let-go is confirmed once it has
     run, let go, for those same 10 s, which is the longest a guest that
     can report is given. A guest driver gives pages back as soon as it
     sees the new target, a megabyte per round trip, so 10 s covers far
     more than any guest's memory; a guest that touches them later shows
     in readings like any other use above its request. Without this its
     claim would last until it next paused and was saved, holding room no
     one could use. A sandbox whose let-go is
     unconfirmed is not ballooned again, but step 3 may still pause and
     save it, keeping its claim, or give it back its claim if it turns
     out unsavable and stays awake. Pausing frees nothing, so a claim
     that ends, for whatever reason, still counts until a reading taken
     after that shows what the guest took; a removed sandbox's claim
     lasts until its VM is ended;
  3. if that is still not enough, the sandbox furthest above its request
     is paused and saved, held or not. It loses nothing: once its recorded
     footprint fits above the high watermark, next to the footprints of
     those let through before it until a reading shows them, it wakes by
     itself with its programs. Asking for it meanwhile gets `host_full`.
  Sandboxes within their request are never touched by any of these.
  A VM's balloon is let go again once it runs after any step and after
  adoption, since a restored image or an earlier agent may have left it
  set. A setting the VM did not take is sent again after a backoff that
  grows with each failure in a row and starts over once a setting is
  taken. Each request goes only to the VMM it was made for: the agent
  checks the process answering on the API socket before sending anything.
  Each carries a request number from the core, and only the answer to
  the latest request for that sandbox counts, so an answer meant for an
  earlier VM of the sandbox never settles a later one. A request that
  finds its VM paused or ended is answered as not taken.
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
- Spare VMs, the ready pool's clones and template builds
  ([12](0012-templates-and-ready-pool.md)), are in the same book. Each
  counts against the budget, at its full size until it is filled and then
  at what it holds. A new one starts only in room above the buffer and the
  high watermark that no wake wants: none while a wake is queued for
  memory or refused and held, or before the first memory reading after a
  start; and it is booked before it starts. Ready
  clones are the first relief for a wake, the buffer and memory pressure,
  oldest first, ahead of step 1 of the relief above; one still filling is
  left to finish. A ready clone is offered for relief only once it waits
  to be claimed. One whose removal fails, and a build VM that cannot be
  proven gone, stay counted as unmanaged at their size (a build's is in
  its directory, for a later agent) and are no relief, until a later
  build of the same VM or the next start of the agent ends them; one still
  filling keeps its claim above the high watermark until it is gone, and
  a later agent claims the same for a build VM it finds and cannot end.
  Available memory is `MemAvailable` plus the free pages the kernel keeps
  on per-CPU lists (`/proc/zoneinfo`), which `MemAvailable` leaves out:
  on a 192-CPU host about 1 GiB of a 6 GiB process that exited was still
  there 15 s later, so a sandbox waiting for room woke 12 to 34 s late.
  When `MemAvailable` reads zero it is zero: the kernel clamps a negative
  estimate there, and the per-CPU pages may cover only part of it. On
  huge-page hosts it is no more than the free huge-page pool.
- Local disk is booked the same way, because a full disk blocks the very
  saves that relieve memory. Every VM whose state is not saved yet books
  its worst-case next save: its memory size once where files share extents
  (XFS), twice where they do not (the merge writes a whole new image), plus
  64 MiB and a few inodes. Bookings plus a kept-back reserve
  (`--disk-reserve-mib`, `--disk-reserve-inodes`; by default a twentieth
  of the filesystem, at least 1 GiB and 1024 inodes) stay within what the
  filesystem has free, read every sample. A booking whose save has written
  stays counted until a reading taken after it shows what the save used,
  and before the first reading after a start nothing that needs disk is
  admitted. Sizes are in whole allocation units of the state filesystem,
  which the agent learns at start by writing a probe, so ext4 bigalloc's
  clusters count. The probe bounds what any write takes only on ext4, XFS
  and btrfs, so the agent refuses to start on a state root on any other
  filesystem (ZFS grows a file's record size, tmpfs can give huge pages
  within a file's size), naming those three.
- Everything else that writes to local disk is booked the same way, before
  it can write, and any booking that ends or shrinks stays counted until a
  reading taken after that shows what was written:
  - An awake or waking VM books what its guest disk may still grow by: the
    disk's length in whole units plus 1/256 of it for the blocks that map
    it (ext4 maps 340 data blocks per 4 KiB of extent tree), less what the
    disk already holds alone. Until a VM is first measured it books the
    whole bound. The agent measures every sample, before its disk
    reading: on ext4 every allocated block counts; on XFS and btrfs, where
    a disk copied from its template or the base image shares their blocks
    and a write to a shared block takes a new one, only blocks the disk
    holds alone count (`FS_IOC_FIEMAP`). A sleeping VM books no growth: no
    guest writes to its disk.
  - A wake from object storage books its local copy from admission until
    the copy is whole: its disk at that bound, its memory image (what the
    pager fills while the guest runs) and 64 MiB of device state. A failed
    fetch keeps it for its retry; a wake that gives up gives it up. The
    agent reports the end of the fill, measured every sample, and a
    restarted agent reports a fill it finds still running.
  - A new sandbox's first files (its copy of its template's disk or the
    base image, by data ranges, whichever is larger since a stale template
    falls back to the base image) are booked before the copy starts, and a
    create the disk cannot take is refused with `host_full` naming disk.
  - A ready clone's fill books its copy of the template's disk and what its
    guest writes until it is ready, together at most the disk's bound; a
    paused clone writes nothing and books nothing.
  - A template build books its disk at the bound, since its guest writes to
    its copy while it boots, its kernel copy by data ranges, and its
    worst-case snapshot, before it starts, and waits without the room.
  A sandbox's bound comes from today's base image, as every disk is a copy
  of it; an awake VM's measurement uses its own disk's length, so a disk
  that differs counts right from its first sample. A boot also relinks the
  kernel (tens of MiB, replacing the previous copy), which the reserve
  covers. A wake that cannot book what it needs
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
- Whether a sandbox waits, saved, for room after a pause for memory is kept
  in its holds file, written by the same writer as its holds whenever the
  core says the wait starts or ends. A restarted agent gives it back to the
  core, which waits for room above the high watermark for it again, and
  wakes it by itself once there is. If that write fails, a restart finds it
  saved and waiting only for use, as before.
- The room a paused sandbox waits for is its VM's cgroup footprint, file
  cache included, so it may wait somewhat longer than its guest needs.
- On nested hosts free page reporting does return huge pages: Firecracker
  1.17 maps guest memory as private anonymous huge pages, booted or
  restored, and a discarded range frees the whole pages inside it.
  Measured ([measurements](../measurements.md)), 1.5 GiB a guest freed was
  back in the pool within 30 s. A balloon returns nothing there: it gives
  back 4 KiB pages, and a huge page is freed only whole. Nested hosts still
  book every awake VM whole and never count it by what it holds: a guest
  that takes memory back while the pool is empty stalls until a page is
  free, with no compression or swap to absorb it, so the pool is never
  overcommitted. What reporting returns does count as available memory
  against the watermarks, so fewer idle sandboxes are pushed deeper.
- Nested hosts hold fewer running sandboxes for the same memory, in exchange
  for cheaper wakes ([5](0005-host-memory-profiles.md)).
- Disk bookings are worst cases: an awake VM on ext4 books all of its
  disk it has not yet allocated, though most guests never fill their disk.
  On a host with many awake sandboxes the disk, not memory, may then bound
  how many wake; size state volumes for it.
