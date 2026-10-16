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
- An upgraded agent must read what the release before it left behind. Images,
  manifests and working-set packs carry a version and are refused when
  unknown. Records gain only optional fields, so an absent field means what
  the older release meant. A pager greets with the protocol it speaks; the
  agent serves every protocol from its oldest supported one to its own, and
  sends a pager only messages that pager understands. A pager it cannot
  serve is reported blocked, as above. Supporting the previous release is
  the rule; a rollback across two releases is not supported.

## Consequences

- Killed with 100 sandboxes at mixed levels, the agent served again in about
  half a second and lost none. Settling records is most of that time.
- A VM whose memory is still loading keeps running: the restarted agent
  reconnects to its pager process ([8](0008-lazy-wake-with-a-working-set.md)).
- Streams the agent carries (connections to guest ports) end with it and
  are not resumed; clients reconnect. Command output is read from a cursor
  in the guest, to the end of what the command wrote, so it resumes without
  loss. The guest helper's own list of
  commands does not survive a restart of the helper.
- Several small processes per VM are more to reason about than one.
- Fences are the base for ownership across hosts
  ([15](0015-placement-and-moves-between-hosts.md)).
