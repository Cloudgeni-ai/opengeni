---
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/react": patch
---

Compact a session's context right after a person's own turn leaves a root session at its automatic compaction threshold, instead of making the next message wait for the checkpoint. The idle request reuses the existing `/compact` maintenance execution, is labeled `proactive` (new `sessions.compact_request_trigger`, migration 1100), skips sessions with an active goal, a held `wait_for_input` or a pending delayed wake, is dropped (with a `capacity_unavailable` skipped landmark) when no subscription capacity is available, and can be turned off with `OPENGENI_IDLE_CONTEXT_COMPACTION_ENABLED=false`. API turns are not included. While it runs the session counts as running, as during a manual `/compact`.
