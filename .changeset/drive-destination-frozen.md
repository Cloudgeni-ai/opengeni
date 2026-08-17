---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
---

Google Drive publication freezes its exact output destination on the accepted delegation, so a later connection-settings change fails an already-accepted turn's publication closed instead of silently redirecting it. Every publication sits behind exactly one durable execute-once connector fence (the attempt connector-action wrapper for model callers, the tool's own registration for Codemode callers): a failure before the first mutating provider request settles not_executed with a retry-safe message, while a failure after it settles uncertain and surfaces the unknown outcome.
