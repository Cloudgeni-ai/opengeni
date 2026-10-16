# 9. VMs outlive the agent

Status: Accepted, 2026-10-16

## Context

The agent is upgraded with every release and may crash on a bug. If its VMs
died with it, every upgrade would interrupt every sandbox on the host.

## Decision

- Each VM runs under Firecracker's jailer, as its own user in a chroot and
  its own cgroup, and does not depend on the agent process.
- Each sandbox has one durable record, the only evidence of which of its
  files are valid. Writes are atomic (stage, rename, sync the directory) and
  compare-and-set on a generation fence, so a stale writer cannot overwrite
  newer state.
- On start, the agent first settles every record on disk, then takes each VM
  back from its record. A VM it cannot prove healthy is kept and reported as
  blocked, not killed on a guess.
- A small holder process per VM keeps a descriptor to its disk open, so a disk
  write error that happens while the agent is down is still seen.
- One agent per host, enforced by a lock file.

## Consequences

- Killed with 100 sandboxes at mixed levels, the agent served again in about
  half a second and lost none. Settling records is most of that time.
- On lab, a VM whose memory was still loading is stopped and woken again; the
  pager process ([8](0008-lazy-wake-with-a-working-set.md)) keeps it running.
- Several small processes per VM are more to reason about than one.
- Fences are the base for ownership across hosts
  ([15](0015-placement-and-moves-between-hosts.md)).
