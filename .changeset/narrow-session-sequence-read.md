---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Avoid loading full session presentations when API routes need only existence and the canonical event sequence. Preserve RLS and cursor integrity checks while removing unrelated metadata, model, and workflow reads.
