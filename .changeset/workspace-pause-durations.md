---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Add durable workspace pause/resume timers with duration controls, countdowns,
manual cancellation, and idempotent worker execution. Migration 0420 requires a
maintenance deployment: drain old writers and deploy matching API/workers.
