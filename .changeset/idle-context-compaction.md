---
"@opengeni/db": patch
"@opengeni/config": patch
---

Compact a session's context right after a human or API turn leaves it at its automatic compaction threshold, instead of making the next message wait for the checkpoint. The idle request reuses the existing `/compact` maintenance execution, is labeled `proactive` (new `sessions.compact_request_trigger`, migration 1100), and can be turned off with `OPENGENI_IDLE_CONTEXT_COMPACTION_ENABLED=false`.
