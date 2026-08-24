---
"@opengeni/db": minor
---

A parent turn that consumes a child's lifecycle update now acknowledges that child for the turn's initiating human, exactly as if they had opened and viewed it. An orchestrator that fans out to dozens of children used to leave a blue unread dot on every one of them forever, even though the parent agent had already consumed and acted on each result; the claim transaction that turns a batch of `session_system_updates` into durable model input now also advances that human's `session_pins.acknowledged_sequence` on every child the batch reports on, to the child's `last_sequence` at that instant.

The rule is keyed only on "a claimed turn consumed a child lifecycle update, and that turn has a frozen initiating human", so it covers all six child lifecycle kinds, behaves identically at every level of a nested chain, and has no orchestrator-, goal-, or depth-specific special case. Several notices for one child in a single batch produce one acknowledgment, and a turn whose frozen principal is purely a service acknowledges nothing.

It can only ever remove rail noise. Read state is per viewer, so another member still sees the child unread; `unread` remains nothing but `sessions.last_sequence > acknowledged_sequence`, so a child that emits one more event goes unread again on its own; and the `failed` and `requires_action` indicators come from `sessions.status`, rank above unread in the rail, and are untouched. The fence is monotone - a human who already read further is never regressed, while an explicit mark-unread still wins.

The write takes no lock on the child session, turn, or attempt, and deliberately not the `session-personal-state` advisory fence, because workspace membership removal takes that fence before the workspace/session lock prefix a claim already holds and taking it there would invert the canonical order. Because a row can now appear between another `session_pins` writer's read and its write, `setSessionPin`, `setSessionAttention`, and `setSessionArchive` upsert instead of insert; the acknowledgment row is pin-neutral and archive-neutral, so their conflict path is the same transition as their insert.
