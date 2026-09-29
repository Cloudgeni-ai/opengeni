---
"@opengeni/contracts": minor
"@opengeni/db": patch
"@opengeni/sdk": minor
"@opengeni/worker-bundle": patch
---

A scheduled occurrence the scheduler refuses before running it is now a visible
run instead of a thrown, retried activity or a silently dropped occurrence.
`ScheduledTaskRun.admissionRefusal` (`{ version, reason, retryable }`, with
`error` equal to `reason`) covers unprovable authority, an unavailable
Connected Machine target, a missing Variable Set, a Sandbox Environment without
an active version (terminal, status `failed`), and an inactive machine
enrollment, insufficient credits or monthly limits (transient, status
`skipped`; later occurrences run normally). Redelivery never adds a second run.
