---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Explain known session-creation refusals for unavailable accepted workspace connections as non-retryable errors. Preserve authorization checks and original driver evidence without returning query text, credentials, or account details.