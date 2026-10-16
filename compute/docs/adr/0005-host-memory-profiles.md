# 5. One memory profile per host: bare metal or nested

Status: Accepted, 2026-10-16

## Context

On bare metal, KVM handles guest page faults directly. A VM inside a cloud
VM pays for two levels of page tables on every fault, which 2 MiB huge pages
make far cheaper. Huge pages, however, cannot be compressed, and dirty
tracking splits them.

## Decision

Each host runs one profile, chosen at start:

- `bare-metal`: 4 KiB pages, KVM dirty tracking (saves write only changed
  pages), and compression of idle memory into RAM with zswap. Compressed pages
  never go to disk.
- `nested`: 2 MiB pages from a reserved pool, saves of resident pages, and
  every wake through the userfaultfd pager.

Combinations that would corrupt data or defeat themselves are refused at
start: dirty tracking with huge pages, resident saves of swappable memory,
compressing huge pages, and mapping a huge-page image from a file.

## Consequences

- Bare metal packs about three to four times as many idle sandboxes into the
  same RAM, because their memory compresses.
- Nested hosts wake fast despite nesting, but have no Compressed level.
- Mixing profiles on one host is not supported.
