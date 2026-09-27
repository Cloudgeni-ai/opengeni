---
"@opengeni/db": patch
---

Verify fresh conversation-history appends using their returned persisted rows instead of rereading numeric positions under row-level security while holding the session write lock. Existing-position retries retain exact content and turn checks, with atomic rollback on conflicts.