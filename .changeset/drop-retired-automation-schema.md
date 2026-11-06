---
"@opengeni/db": patch
---

Drop the tables of the retired automation intake and PR-review pack, with any rows those removed features left behind, after the readiness-compatible predecessor release. Current event sources, schedules, and automation templates are unchanged. An unexpected dependency still stops the migration instead of cascading into live objects.
