---
"@opengeni/db": patch
---

The idle-session archive now measures activity by turns only. Bulk maintenance that touches `sessions.updated_at`, and bookkeeping events appended to idle sessions, no longer keep a long-idle session live. One maintenance pass also keeps archiving batches until its time budget ends, so a backlog drains after the archive is first enabled.
