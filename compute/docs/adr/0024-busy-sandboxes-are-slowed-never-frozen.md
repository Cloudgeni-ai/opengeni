# 24. Busy sandboxes are slowed, never frozen, and the host never runs out

Status: Accepted, 2026-10-29. Replaces step 3 of the relief in
[14](0014-requests-limits-and-admission.md), its rule that a running VM is
never compressed, and its fixed out-of-memory score for VMMs.

## Context

A sandbox has a request (its guarantee) and a limit, and may use the space
between them while the host has some spare. When sandboxes in use grew past
what the host had, step 3 of 14 paused and saved the one furthest above its
request, held or not, until there was room. That is the wrong last resort
for anything that talks to the outside: a paused CI runner cannot answer
GitHub, nothing asks for it awake, and GitHub gives the job up after ten
minutes. One host lost two release builds in a day that way (23 pauses for
pressure in two days), and freeing one runner's memory took minutes of
compression, saving and upload at the moment memory ran out. Chats lose
open connections, servers and downloads the same way. Pausing an idle
sandbox stays right: nobody is waiting on it.

Memory comes back from a running VM in three ways: its guest gives some
back (seconds, cooperative), the host kernel compresses its pages
(instant, page by page, slower to touch again), or a process ends. Only
the kernel acts fast enough to keep a host from running out; the agent
samples once a second.

## Decision

- **A sandbox in use is never paused or saved for memory.** Relief pauses
  only idle sandboxes and ready spares (step 1 of 14) and asks balloons
  of idle sandboxes (step 2); step 3 is gone, and on a host with this
  rule no balloon is ever pressed on a sandbox in use: in the lab a
  3 GiB balloon on a busy guest holding 3.25 GiB stalled it so far that it
  could not answer a shrink. Idle means that memory pressure may put it
  to sleep: a sandbox that never sleeps, such as a CI runner ended at its
  timeout, is in use however quiet it is, since its work goes on with
  nobody calling it. A sandbox an earlier agent paused for memory still
  wakes by itself once there is room.
- **Running VMs that may borrow are compressed** on hosts with 4 KiB
  pages, zswap and a swap device: for a VM whose request is below its
  limit, `memory.zswap.max` and `memory.swap.max` open from launch,
  `memory.zswap.writeback` always 0, so nothing reaches the device. A VM
  guaranteed all of its memory never borrows, so it keeps zswap closed
  while it runs, as under 14. zswap still takes a swap slot per page at
  its original size, and stops taking pages while its pool is full, so the
  agent warns on swap under a quarter of memory and a pool under 20 %.
  Elsewhere the rule below does nothing and the host behaves as before,
  minus step 3.
- **The guarantee is kept by the kernel.** The kernel charges a VM's
  compressed pages to its group, and `memory.low` protects an amount, not
  pages. So the agent keeps each running VM's `memory.low` at its request
  plus what it compressed (`memory.zswap.current`): what it holds
  uncompressed is then never pushed below its request while anything
  above a request is left to take.
- **The borrower pays.** Under the VMs' parent `memory.high` (14) whoever
  allocates reclaims, so a sandbox growing within its request would pay
  for another's borrowing. Instead the core gives every running VM a
  `memory.high` of its `memory.low` plus a level of borrowed memory, so
  that the borrowed memory of all of them fits in what the host has above
  every request and the low watermark. Sandboxes in use share that room
  first, with one level for all (water-filling: the smaller borrowers keep
  what they have, the largest give back first); idle ones get what is
  left. Past its own high a VM waits on its own allocations while the
  kernel compresses its coldest pages: it runs slower, and only it. A
  level that holds nobody back still keeps any one VM from taking more
  than is left. Settings change only by 64 MiB or more. Memory on its way
  back (sandboxes being put to sleep, spares ending) counts as available,
  so no sandbox in use is compressed for memory an idle one is about to
  give back, and a sandbox being put to sleep is left out of what running
  ones hold. Ready spares wait while the levels hold anyone back.
- **The reserve is free memory, not cache.** The levels count page cache
  charged to the VMs' group as available, since the kernel can drop it at
  once. But the kernel holds the group to its `memory.high` by all it
  charges, cache included, and that cache builds up whatever the VMs do
  now: what their disks read and wrote, and what VMs that ended left to
  the group. On a bare-metal lab host it filled 900 MiB of a 1 GiB
  reserve after a few sandboxes had come and gone, and a neighbour
  growing 1 GiB within its request waited 1% of the time while it dropped
  that cache and compressed the borrower beside it at the shared high. So
  whenever less than the low watermark is free under the VMs' high, the
  agent drops the group's cache, and only cache (`memory.reclaim` with
  `swappiness=0`, Linux 6.9 and later), by the difference, in the
  background.
- **What the kernel cannot hold costs the borrower too.** A `memory.high`
  only bounds what the kernel can compress: pages that do not compress
  (random or compressed data), a full pool or swap device leave a VM above
  its high, and one that has stopped allocating never even slows. Its
  neighbour growing within its request would then take the host down to
  the wall. So while less than the low watermark is available, a VM
  holding more than 64 MiB above its high on a reading, and not 64 MiB
  lower than on the reading before, counts as one the kernel cannot hold;
  one coming down, however slowly, is left to come down. After 10 s of
  that it is treated as costing the others, as a short host is: its guest
  is asked to free what it holds above its high.
- **A high is never set below what a VM holds while its memory may not
  compress.** Past its
  `memory.high` every page a VM takes waits, about 64 s times the square
  of how far past it is (as a share of the high) for every 256 KiB, at
  most 2 s: in the lab a VM bounded at half of what it held in random data
  stopped, its guest could not answer the shrink, and the VM was ended.
  So the agent brings a VM down in 64 MiB steps of its own reclaim, the
  first with the high at what the VM holds, and the next ones, once a
  step compressed, a thirty-second below it: a VM that compresses pays
  for what it takes meanwhile by compressing itself. Where the kernel
  takes no more, the high goes back to what the VM holds: only its growth
  past that waits. A new bound never raises a high above where it holds a VM
  unless the bound itself is higher, so a VM the kernel could not
  compress cannot grow by being bounded again. The agent reads each VM's
  `memory.high` with its other memory readings, and bounds a VM held
  above its bound again once it has come down by 64 MiB. Each page the
  kernel compresses is charged back to the VM at its compressed size, so
  while bringing a VM down the agent raises its high by what it
  compressed since the bound was set: the VM ends with what it holds
  uncompressed at its bound, never below. A pause lifts the high
  entirely, since a paused VM allocates nothing and its own save must
  not wait on it, and a resume sets it again from the next reading.
- **Memory that does not compress is not scanned again.** zswap takes a
  swap slot for every page reclaim hands it; one it refuses keeps its
  slot and stays in RAM, unmapped from the VM, to be handed to it again.
  In the lab, reclaim of a VM full of random data never ended: it scanned
  millions of pages for a few thousand, the VM faulted its own pages back
  all along, and its guest could not answer. So each step lets the VM
  hold one step more of swap than it does (`memory.swap.max`); once that
  is spent the kernel takes none of its anonymous pages, for that reclaim
  or any other, the VM's own and the host's included, and the step ends.
  A step that spent most of that swap on pages zswap refused (slots taken
  less pages kept out of RAM, `zswpout` and `swpout_zero`) closes the VM's
  swap: what it compressed stays so, nothing more is taken, the rest of
  the descent drops only cache, and its growth past its high only waits
  until its guest is shrunk. A later bound tries it again for one step,
  and a lifted bound, a pause or a resume opens it. Memory that does not
  compress costs a VM at most a step's work each time it is bounded. A
  new bound starts from where the one before settled, never from the
  thirty-second below that a descent it overtook left.
- **The guest is asked to shrink.** When the host is short even with
  every running VM at its request and what is on its way back counted,
  for 10 s (by then pressure has put to sleep every idle sandbox it
  could), or the kernel has not held a VM to its bound for 10 s while the
  host is pressed, the guest of the sandbox in use holding the most host
  memory above its request, compressed pages included, among those that
  cost the others is asked over the restore-notice port to free what the
  host is short of (or what that VM holds above its high), never below
  its request. An idle sandbox is put to sleep instead, never shrunk. A
  VM that only stalls (all its threads waiting on memory, `full avg10` of
  its `memory.pressure`) slows only itself, and is never shrunk or ended
  for it: its stall is reported. Until it answers, the VM's high is lifted
  to what it holds plus 256 MiB, the least a shrink asks, so that its
  guest can run to answer; the first reading after the answer bounds it
  again. The guest init drops its page cache and then ends, one at a time
  and at most eight, the processes its kernel's out-of-memory killer
  would end first, sparing itself, the services it supervises (envd,
  Opengeni's agent, the image's command), kernel threads and processes
  marked -1000, and never choosing again one it signalled. It ends none
  after 8 s and answers what it freed, what it ended and whether
  anything is left it may end; the agent waits 15 s for that answer, the
  core 10 s more for the agent's word. The program that used too much
  sees `Killed`; the sandbox, its files and its other programs run on.
  A GitHub Actions runner gives its job's steps an `oom_score_adj` of
  500 and keeps itself at 0, so it is the step that ends, and the runner
  reports the failed job. One shrink or end at a time per host, the next
  only on a reading taken 10 s after, once freed pages have reached the
  host.
- **A VM is ended only as a loud last resort**: the host is still short
  with every VM at its request, or the kernel still cannot hold a VM to
  its bound while the host is pressed, and the guest of the one furthest
  above its request (by at least 256 MiB) among those cannot shrink: it
  has nothing left to end, does not answer within 15 s, or is older than
  shrinking. The
  `ended_for_memory` alarm counts it; the VM is restored from its last
  copy as any VM that ended on its own, and its wake waits for admission.
- **The kernel's wall, if the agent cannot act in time.** The VMs' parent
  group gets `memory.max` at the host's memory less the midpoint of the
  two watermarks, above its `memory.high` (14 measured a low watermark
  short of all of it as too little: the kernel's own memory left under
  350 MiB), so the VMs together never take the agent's or the host's
  memory. Each VMM and pager has an `oom_score_adj` of -999
  times its request over that wall plus swap (the kernel scales by both),
  so the kernel's choice at the wall is the VM furthest above its request.
  Every kill by the out-of-memory killer in the VMs' group is the
  `oom_killed` alarm.
- **A host shared beyond compute** says how much of its memory compute may
  use (`--memory-total-mib`): the capacity, the watermarks, `memory.high`
  and the wall come from that share, so sandboxes never take memory
  promised to VMs beside them.
- **Observability.** Host metrics, with no sandbox labels (16): memory
  requested, borrowed, compressed and out of RAM by running sandboxes;
  running sandboxes by memory stall (under 1 %, to 10 %, to 40 %, above);
  the borrowed level for idle and busy sandboxes, how many it holds back,
  how many the kernel cannot hold to their bound, the memory on its way
  back, and the shortfall;
  shrinks by answer, memory they freed and programs they ended; the two
  alarms. Each shrink is an event naming its sandbox
  and the programs it ended, and each running sandbox's periodic summary
  carries its peak use, request, compressed and swapped memory and its
  stall time, from which requests and packing are tuned per kind of job.
  The compute dashboard has a Sandbox memory row, and sandboxes stalled
  above 40 % for ten minutes alert.

## Consequences

- No sandbox in use is frozen for memory. Past its request a sandbox
  runs slower when the host is short, and the dashboards show which and
  by how much. A CI job either finishes slower or, when memory cannot be
  had at all, fails with a named program killed, as on any machine out of
  memory.
- Ending a whole VM is an alarm, not a routine step.
- Compression costs processor time on the borrower. Pages that do not
  compress (archives, images, already compressed caches) stay in RAM, so
  a host of such sandboxes reaches the shrink sooner.
- While the kernel cannot hold a borrower to its bound, the host has less
  than its low watermark free for about 10 s before the borrower's guest
  is asked to shrink; a neighbour that grows past what is left in that
  time waits at the VMs' shared `memory.high`.
- Each VM's level is computed from one reading, so several borrowers
  growing at once between readings can take a little more than the room
  left. The low watermark absorbs that, the kernel reclaims at the shared
  `memory.high`, and the wall stops the rest.
- A sandbox within its request grows at once into the free reserve. Past
  it, growing into memory borrowers hold, it waits on their compression,
  which ran at about 200 to 250 MB/s for one borrower of partly random
  data on the lab's bare-metal host (zstd): a neighbour taking 1 GiB in a
  second beyond the reserve waits a few seconds. The reserve is the price
  of not waiting, and per-sandbox stall time shows who waited.
- A borrower's file cache is compressed with the rest of what it holds:
  its guest drops cache only when asked, in a shrink.
- On kernels whose `memory.high` writes cannot be non-blocking (before
  `O_NONBLOCK` support), a write reclaims toward the new high before it
  returns. Since a high is set at most a thirty-second below what a VM
  holds, and only once its memory compressed, that is at most a step's
  reclaim and what the VM took since it was read.
- The kernel can end more than one group at the wall before the first
  frees its memory (measured: three within 1.2 ms). The wall is a
  backstop; the shrink and the levels are what should act.
- Guests older than this release cannot shrink; on a short host they go
  from compression to an ended VM.
- Not done: overflow of compressed pages to an encrypted local SSD, and
  bounding the guest's workload with a cgroup of its own in place of
  ending its processes from user space. Either is added if the metrics
  show compression or the shrink running out.
