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
- The pager is no more privileged than its VM. The agent starts it as root
  so it can bind its sockets and open the image, and before it reports
  ready it becomes the VM's own user and group, with no other groups, no
  capabilities and `no_new_privs`, inside the VM's cgroup; the engine
  checks this and ends a pager that did not. What it writes afterwards
  (its control socket, done mark and learned order) lives in a directory
  of its own owned by that user, and the agent reads it as it reads
  anything from a jail: never through a link, only a bounded regular file
  of one name, and keeps only a profile whose page size is real and whose
  pages lie inside the VM's memory; anything else is dropped with a
  warning and never stops a wake or an archive. The agent reads the
  pager's control messages the same way: a greeting no longer than a
  pager of that image could need, naming ordered ranges inside the image,
  and no later message over 1 KiB, each refused before more is held.
- A store that does not answer stalls a loading guest; it never ends it.
  Chunks are retried for as long as the VM lives, quickly for a minute and
  then every 10 s, and the host's status shows how long the store has been
  stalled. Only a chunk the store proves bad or gone loses the VM's memory.

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
