# 10. The crash-safety bar

Status: Accepted, 2026-10-16

## Context

Every "what if the agent dies between these two steps" can be answered with
more machinery. Without a clear bar, code grows to cover cases that cost
more to maintain than they could ever save.

## Decision

We guarantee three things, through any crash of the agent, a VM or the host:

1. A sandbox's data is never lost once it has been saved, and never
   silently corrupted.
2. A sandbox is never left stuck: it wakes, or reports why it cannot.
3. Planned agent restarts (upgrades) do not interrupt running sandboxes.

Rolling a sandbox back to its last save in a rare crash window is
acceptable. When the worst case of a failure is such a rollback, prefer the
simplest recovery over new machinery, and write the window down.

## Consequences

- Review findings below this bar get the simplest fix or a documented
  limitation, not a new mechanism.
- Two mechanisms exceed the bar and are being weighed against simpler rules:
  the separate pager process ([8](0008-lazy-wake-with-a-working-set.md)) and
  the disk holder ([9](0009-vms-outlive-the-agent.md)).
