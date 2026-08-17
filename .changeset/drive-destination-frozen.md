---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
---

Google Drive publication freezes its exact output destination on the accepted delegation, so a later connection-settings change fails an already-accepted turn's publication closed instead of silently redirecting it. Every publication now takes the durable execute-once connector fence regardless of caller: a failure before the first provider request settles not_executed with a retry-safe message, while a failure after it settles uncertain and surfaces the unknown outcome.
