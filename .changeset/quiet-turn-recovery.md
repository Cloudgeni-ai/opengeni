---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Retry transient pre-inference attempt claims atomically, durably re-wake a
logical turn when its activity failed before creating an attempt, and preserve
the requested backoff deadline once older workflow-wake revisions are delivered.
Terminal failure retries now also close the workflow without synthesizing an
active-goal continuation.
