# 8. Wake from object storage lazily, working set first

Status: Accepted, 2026-10-16

## Context

Downloading a whole memory image before starting the VM makes a remote wake
take seconds. Fetching chunks on demand is faster, but on a 4 KiB-page host a
guest's first-touched pages are scattered across most of its chunks.

## Decision

- The VM starts before its memory has arrived. A userfaultfd pager serves
  each page as the guest touches it, fetching it if it is not local yet.
- Each wake records which pages the guest touched first. The next archive
  stores them, in that order, as one *pack*. A remote wake fetches the pack
  first, then the rest in the background. Packs hold only pages whose chunks
  match the canonical image, so a bad pack can never become guest memory.
- The disk is fetched over the host's base image, so only differing chunks
  move.
- The pager runs as its own process per VM while memory is still loading, and
  exits when the memory is complete.

## Consequences

- One remote wake restores in well under a second, and the guest rarely
  stalls on a missing page.
- Many remote wakes at once are limited by network bandwidth, not by the
  agent. Fetches run 8 at a time by default; more did not help.
- The separate pager process keeps a guest running through an agent restart
  mid-load, at the cost of a shutdown handshake with the VMM. A simpler rule,
  waking such a VM again from the same save after a crash, would also meet
  [10](0010-crash-safety-bar.md) and is being weighed.
