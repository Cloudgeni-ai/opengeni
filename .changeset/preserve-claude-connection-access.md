---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Preserve workspace model access restrictions when renewing or reconnecting Claude, Anthropic, OpenRouter and Gateway credentials. Bound Claude HTTP error-body reads so stalled diagnostics cannot hide rate-limit/retry information. Associate Claude account-import help and validation errors with its accessible control.
