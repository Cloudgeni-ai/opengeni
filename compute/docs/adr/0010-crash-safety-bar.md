# 10. The crash-safety bar

Status: Accepted, 2026-10-16

## Context

Every "what if the agent dies between these two steps" can be answered with
more machinery. Without a clear bar, code grows to cover cases that cost more
to maintain than they could ever save.

## Decision

What each failure may cost:

| Failure | Allowed cost |
| --- | --- |
| Agent crash or upgrade | nothing; running sandboxes keep running |
| A VM process (or its pager) dies | with a valid saved memory image, the sandbox wakes from it; without one (running, or paused but not yet saved), it boots fresh from its disk: programs lost, data the guest wrote to its disk kept |
| VMM or processor changes under a saved image (an upgrade, a move to another host) | if the new VMM refuses the image, the sandbox boots fresh from its disk; each image records the runtime that made it, and only a refusal by another runtime gives the memory up |
| Host lost | what changed since the sandbox's last completed archive |
| A copy goes bad | nothing, as long as another verified copy exists |

Two further rules: a sandbox is never left stuck (it wakes, or reports why it
cannot), and integrity checks follow [7](0007-never-delete-the-only-good-copy.md):
everything from object storage is hashed, local content is trusted to the
file system.

When a finding's worst case is already allowed by this table, prefer the
simplest fix, or write the window down instead of adding a mechanism.

## Consequences

- Review findings are judged against this table.
- Two mechanisms exist only to meet the first row: the separate pager process
  ([8](0008-lazy-wake-with-a-working-set.md)) and the disk holder, which keeps
  lost disk writes detectable after an agent restart
  ([9](0009-vms-outlive-the-agent.md)). The simplification pass weighs each
  against relaxing that row.
