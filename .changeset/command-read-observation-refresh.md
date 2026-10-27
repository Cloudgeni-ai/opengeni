---
"@opengeni/runtime": patch
---

`command_read` and `command_wait` no longer fail with "Provider command observation unavailable; do not replay the invocation" when the live owner refresh of a still-running command misses its short provider read window. The provider marks that miss as safe to read again, so the runtime now treats it like a temporary transport outage: it reauthorizes and returns the durable receipt (output, cursor, state) instead of discarding it. A `command_wait` keeps its requested wait and refreshes again on its ordinary one-second cadence, and reports `freshness.status: "refresh_unavailable"` only if no refresh succeeded before the result was returned. Observation failures that do not permit another read, and authorization, consent, fencing, integrity and unclassified errors, still fail closed. No Start or stdin is ever replayed.
