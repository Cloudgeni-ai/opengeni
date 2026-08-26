---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Document the one-way deployment boundary for named signup and invited-user
setup. Migration 0348 requires every API, control worker, and turn worker to be
stopped and drained before it runs, with the exact old/new application database
roles supplied to the migration runner. Start only binaries built for schema
ordinal 0348 or newer after it commits; never restart a pre-0348 image, and
remain in maintenance to fix forward if the new runtime cannot start.