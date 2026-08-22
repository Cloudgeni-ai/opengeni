---
"@opengeni/worker-bundle": patch
---

Recover a managed-home session's Connected-Machine-to-home route change as a safe same-logical-turn handoff. The worker durably checkpoints completed model/tool truth, closes only unresolved tool calls, and continues in a fresh home-primary attempt instead of failing the session, while preserving the no-phantom-home and no-ambiguous-replay guarantees.
