---
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

Recover raw PostgreSQL rollback failures during turn startup using the existing exact-attempt recovery boundary. Present database failures without raw SQL or parameters, including historical failure events.
