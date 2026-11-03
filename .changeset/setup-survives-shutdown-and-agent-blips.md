---
"@opengeni/worker-bundle": patch
---

A chat no longer stays stuck in "recovering" after a worker shuts down while its sandbox is still being set up. The attempt's writer drain now also settles a setup step that only ever writes through the drained command fence, so the attempt reaches quiescence and the recovery or next turn runs. A turn also no longer fails when the sandbox's machine agent is briefly offline, reconnecting, draining, timed out or replaced during setup: nothing the model asked for has run yet, so the same turn retries after a short delay within the usual recovery limit.
