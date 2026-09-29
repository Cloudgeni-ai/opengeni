---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
---

Remove the unconditional five-second grace period from normal session idle completion and child-result handoff. Keep the final durable work recheck, transactional idle settlement and parent-result deduplication, and close-race signal guard. Fence runnable machine input accepted before idle settlement as well as queued turns, preventing a stale parent result when input wins that race. Late follow-ups may start another workflow run of the same session through the durable wake path. A Temporal patch preserves legacy timer histories; held input waits, goal backoff, cancellation, quiescence, and capacity timers are unchanged.