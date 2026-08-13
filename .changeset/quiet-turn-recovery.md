---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Retry transient pre-inference attempt claims atomically, durably re-wake a
logical turn when its activity failed before creating an attempt, and preserve
the requested backoff deadline once older workflow-wake revisions are delivered.
Still-open legacy workflow histories and exact active-workspace,
already-delivered queued cutover rows now retain the same recovery obligation.
Terminal failure retries also close the workflow without synthesizing an
active-goal continuation.
