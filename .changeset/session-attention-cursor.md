---
"@opengeni/db": minor
---

Persist the meaningful attention frontier alongside the durable event cursor and advance both atomically on every accepted event-insert statement. Session and descendant reads reuse this narrow projection instead of probing event payloads repeatedly.

Migration `0585_session_attention_cursor.sql` requires the declared application roles to be stopped while it backfills the existing meaningful-attention index. Runtime FORCE RLS and existing cursor sequencing checks are preserved; older application writers remain compatible with the updated database trigger.
