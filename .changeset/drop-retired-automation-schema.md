---
"@opengeni/db": patch
---

Drop the empty tables of the retired automation intake and PR-review pack after the readiness-compatible predecessor release. Current event sources, schedules, and automation templates are unchanged. The migration refuses nonempty tables and unexpected dependencies rather than deleting data or cascading into live objects.
