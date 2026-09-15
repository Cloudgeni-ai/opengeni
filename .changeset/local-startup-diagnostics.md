---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/observability": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Stop retrying permanent runtime database posture and configuration failures as
connection errors. Validate local startup prerequisites, prevent overlapping
launchers from rotating live database credentials, and check database posture
before building the development sandbox.
