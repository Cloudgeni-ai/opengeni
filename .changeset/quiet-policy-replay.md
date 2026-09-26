---
"@opengeni/db": patch
---

Compare connector policy snapshots by value when replaying an exact session attempt, so PostgreSQL JSONB key ordering cannot fail approval or human-handoff resume with a false ownership conflict.