# 44. A request the kernel may compress is kept by `memory.min`

Status: Accepted, 2026-11-14. Amends
[14](0014-requests-limits-and-admission.md) (`memory.low`, not
`memory.min`) and [24](0024-busy-sandboxes-are-slowed-never-frozen.md)
(the guarantee is kept by the kernel).

## Context

14 kept a running VM's request with `memory.low`: admission keeps the
requests within the host, so the kernel finds unprotected memory first,
and should it not, slowing a VM beats the out-of-memory killer. While a
running VM's swap was closed, a breach of its `memory.low` could take only
page cache. 24 opened zswap and swap from launch on every VM that may
borrow, and kept the guarantee with the same `memory.low`.

With the multi-generation LRU (MGLRU, on by default on the kernels our
hosts and CI run), the kernel's reclaim for the whole host (kswapd, and
direct reclaim when a zone runs low) walks the groups in turn. A group
under its `memory.low` is moved to the back of the queue the first time
round and reclaimed the next (`shrink_one` in `mm/vmscan.c`, counted as a
`low` event in the group's `memory.events`), whether or not other memory
is left; only `memory.min` makes it skip a group every time. Machine-wide
reclaim is routine wherever page cache fills the free memory, and with
swap open what it takes from a VM is its memory, compressed.

That is what failed the KVM test of 24's promise (a borrower is
compressed and its neighbour within its request never waits) in about one
gate run in five from 11 to 14 November. A cgroup sampler on 8 CI runners
caught it 3 times in 8 runs: the neighbour, holding 1.1 GiB of its 2 GiB
request, lost 26, 137 and 551 pages to zswap exactly as kswapd and direct
reclaim first scanned it, with its own `memory.high` at `max` and no
`high` events, the VMs' group below its high, and 2.5 GiB still available
on the machine; its `low` events climbed throughout.

## Decision

- **On a host that compresses running VMs, each running VM's request,
  with what the kernel compressed of it (24), is its `memory.min`**, and
  the parent's `memory.min` the sum of its VMs'. Neither the host's
  reclaim nor the VMs' shared `memory.high` or `memory.max` takes it. A
  paused VM's is 0, as its `memory.low` was. Writing one kind clears the
  other, so VMs adopted from an earlier release lose their `memory.low`.
- **Elsewhere nothing changes**: `memory.low`, as 14 decided, since a
  breach there can only take a VM's page cache.
- **Bounds still apply.** Reclaim for a group's own `memory.high`, and its
  own `memory.reclaim`, ignore its protection, so a borrower is still
  brought down to its bound and pays for what it borrowed (24).
- **Cache kept under a `memory.min` is held.** The page cache a VM's disks
  read is charged to its group and counts toward its `memory.min`. What
  each VM keeps that way (what it holds up to its `memory.min`, less what
  it holds anyway) is counted as held in the room the levels share out,
  and is not asked of a drop of the VMs' cache.

## Consequences

- A sandbox within its request is never compressed for others. It keeps
  the page cache its disks read within its request, which is memory it was
  promised; borrowers get that much less room.
- When the host runs short beyond everything unprotected, the kernel's
  last resort is the out-of-memory killer rather than compressing a
  sandbox's request. At the VMs' wall it ends the VM furthest above its
  request, as 24 set out; past it, the host's own memory is short of what
  the share promised compute.
- A host short of free memory still has the sandbox that allocates wait
  while the kernel reclaims for it: `memory.min` keeps what a group holds,
  not the speed at which it gets more.
