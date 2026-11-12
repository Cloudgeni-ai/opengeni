---
"@opengeni/core": patch
---

Creating a session no longer waits for Temporal. The create commits the session, its first turn and its workflow-wake outbox row in one transaction, then answers; the immediate workflow wake and live event fanout still start right after that commit, but in the background. A slow or stalled Temporal now delays only when the run starts, not the create request. If that immediate wake fails or the process stops before it is sent, the owed outbox revision is delivered by the control worker's existing wake dispatcher, as for other wakes. A wake failure therefore no longer turns an already-accepted create into an error response. Idempotent create replays re-send their wake the same way.
