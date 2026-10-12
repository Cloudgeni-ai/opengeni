---
---

Test-only: historical migration fixtures that withhold the session sharing migration now also withhold (and, where they replay, replay after it) the migration that lets private sessions share a sandbox, since that migration rewrites routines the sharing migration installs. No runtime or schema change.
