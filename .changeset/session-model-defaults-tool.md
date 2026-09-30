---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
---

Add the first-party `session_set_model` MCP tool for changing an existing session's future model and reasoning defaults without waking it or rewriting accepted work. Preserve ordinary target authorization and exact-attempt fencing, provide stable idempotent receipts across reconnects, and report canonical model, reasoning and latency settings in full session readback. Share effective defaults across prompt admission, goal continuation, compaction and scheduled snapshots so older queued or resumed turns cannot undo an explicit choice. Deploy API and workers from a matched source cohort before using the new operation.