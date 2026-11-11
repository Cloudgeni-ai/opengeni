---
"@opengeni/db": patch
"@opengeni/observability": patch
"@opengeni/worker-bundle": patch
---

A session workflow no longer retries a quiescence receipt forever when the session was archived after its turn was cancelled. The database refuses every write for an archived or imported session, so the receipt activity now proves the session is read-only, logs what the database refused, and fails non-retryably; the workflow drops the moot receipt and closes, and the session peek reports read-only sessions so nothing else is attempted. Temporal "Activity failed" log lines now also carry reviewed failure facts (error class, ApplicationFailure type and retryability, SQLSTATE, the constant reason and function our own database code raised, and the persistence stage) instead of only "temporal sdk failure logged".
