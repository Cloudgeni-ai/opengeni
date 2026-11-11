---
"@opengeni/db": patch
---

Collect session content blobs that no model-context snapshot or tool catalog refers to any more. Each model request replaced the attempt's snapshot and left the replaced request body chunks behind until the session was archived; the session storage maintenance pass can now delete them under a per-session lock that every blob writer and snapshot reader holds shared. Migration 1359 adds the collector without runtime access; a later migration grants it.
