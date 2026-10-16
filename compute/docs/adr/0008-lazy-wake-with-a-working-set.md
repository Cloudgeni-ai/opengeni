# 8. Wake from object storage lazily, working set first

Status: Accepted, 2026-10-16. Built.

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
  exits when the memory is complete. A restarted agent reconnects to it; if
  the pager dies, the VM is ended and the sandbox recovers as
  [10](0010-crash-safety-bar.md) says.

## Consequences

- One remote wake from same-region storage answered in about 0.9 s once a
  working set was learned (see [measurements](../measurements.md)).
- 100 remote wakes at once took about 30 s to first response, limited by a
  shared step in fetch and publish that is being profiled.
- The separate pager process is what lets a guest keep running through an
  agent restart mid-load, as [10](0010-crash-safety-bar.md) requires. Its
  costs are a reconnect protocol and a shutdown handshake with the VMM. The
  alternative, the agent itself serving pages, would lose such a guest's
  programs on every agent restart: its image is invalid once it has run.
