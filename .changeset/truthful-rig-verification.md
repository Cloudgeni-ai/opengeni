---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
---

Make rig promotion manager-fenced and idempotent, run candidate setup and declared checks with bounded
deadlines and redacted structured evidence, and report rigs with no checks as having no health signal.
Persist verification-attempt fencing and default-variable authorization provenance so sessions and
scheduled tasks fail truthfully when a rig default is not authorized.
