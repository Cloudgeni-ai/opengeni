# 5. One memory profile per host: bare metal or nested

Status: Accepted, 2026-10-16

## Context

On bare metal, KVM handles guest page faults directly. A VM inside a cloud
VM pays for two levels of page tables on every fault, which 2 MiB huge pages
make far cheaper. Huge pages, however, cannot be compressed, and dirty
tracking splits them.

## Decision

Each host runs one profile, chosen at start. By default the agent picks
`nested` when the host's CPU reports that it runs under a hypervisor and
`bare-metal` otherwise; `--memory-profile` overrides that.

- `bare-metal`: 4 KiB pages, KVM dirty tracking (saves write only changed
  pages), and compression of idle memory into RAM with zswap. Compressed pages
  never go to disk, and only a paused VM is compressed: zswap is closed for a
  running VM's cgroup ([14](0014-requests-limits-and-admission.md)).
- `nested`: 2 MiB pages from a reserved pool, saves of resident pages, and
  every wake through the userfaultfd pager. A running VM is booked whole
  against the pool; with the pool empty a guest stalls rather than dies.

Combinations that would corrupt data or defeat themselves are refused at
start: dirty tracking with huge pages, resident saves of swappable memory,
compressing huge pages, and mapping a huge-page image from a file.

## Consequences

- Bare metal packs about three to four times as many idle sandboxes into the
  same RAM, because their memory compresses.
- Nested hosts wake fast despite nesting, but have no Compressed level.
- Free page reporting returns a nested guest's freed huge pages to the pool
  (measured; see [14](0014-requests-limits-and-admission.md)), but a balloon
  does not, and a guest that takes memory back from an empty pool stalls.
  Nested hosts therefore book every awake VM whole.
- Mixing profiles on one host is not supported.
