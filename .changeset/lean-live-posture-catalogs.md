---
"@opengeni/db": patch
---

Reduce repeated database-readiness catalog work by inspecting table and routine namespaces together, aggregating policy facts once, and reading activation-presence facts with connection identity. Every readiness check still reads and validates current catalog state in one read-only repeatable-read transaction.
