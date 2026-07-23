---
"@opengeni/contracts": minor
"@opengeni/worker-bundle": patch
---

Bind every host Git credential request to immutable session, root-session, turn,
attempt, execution-generation, and initiator authority. The worker fails closed
when a host broker is configured without that authority and preserves the same
authority across identity resolution, lazy provisioning, and proactive renewal.
