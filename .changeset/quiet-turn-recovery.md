---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Retry transient pre-inference attempt claims atomically, durably re-wake a
logical turn when its activity failed before creating an attempt, and preserve
the requested backoff deadline once older workflow-wake revisions are delivered.
Still-open legacy workflow histories and every effectively active durable work
shape whose prior wake was delivered now retain the same recovery obligation:
queued/recovering turns, accepted approval responses, released capacity waits,
manual compaction, and pending internal updates. Held, paused, live-attempt, and
already-pending wake states remain untouched.
Terminal failure retries also close the workflow without synthesizing an
active-goal continuation.
