---
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

The first-party `opengeni` MCP server gains `session_human_input_respond` (`sessions:control`, `session.human_input.write`): a live attempt answers or skips another session's structured human-input request, recorded as `agent_attempt:<attemptId>`, and signals that session's workflow exactly like the REST route. `session_wait` reports `ownPendingImmediateUpdates` and `ownPendingDeferredUpdateKinds`; only immediate-class own input ends the wait. The API and both workers install `OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED` into `@opengeni/db` at boot. The worker delivers a child's `child_requires_action` outbox row to the parent right after the `requires_action` settlement (generalized `deliverChildLifecycleOutboxToParent`; the reaper covers crashes) and the goal-continuation prompt explains every child notice kind, offering `opengeni__session_human_input_respond` only when it is in the session's effective first-party selection.
