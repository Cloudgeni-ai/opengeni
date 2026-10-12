---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

An idle deployment no longer starts five Temporal workflows on every sandbox reaper tick (every 30 seconds by default): the reaper router, the drain inventory, its maintenance pass, the idle checkpoint sweep and the browser checkpoint sweep. The control worker now drives three work-checked cadences on the same reaper period:

- The lease reaper starts the unchanged drain inventory, which starts its maintenance pass, only when a lease is warming, warm, draining or held, when any reconciliation the pass runs has a due row, or when Modal is configured and its app still runs a sandbox.
- The idle checkpoint sweep starts only when a warm box may be due at the snapshot interval.
- The browser checkpoint sweep starts only when a checkpoint-capable browser on a warm box is suspending or facing its provider deadline.

An idle reaper tick still refreshes the reaper's read-only gauges in the control worker, so inventory freshness alerts keep working. The reaper period and its boot invariants are unchanged, and a failed check still starts the workflow.

The old `opengeni-sandbox-lease-reaper` Temporal Schedule is deleted at startup, and `registerSandboxReaperSchedule` is removed. The router workflow and activity stay registered so in-flight histories and a rollback still replay. New migration 0732 adds the read-only checks, each with the same owner and grants as the claim it previews.
