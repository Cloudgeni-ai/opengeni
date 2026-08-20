---
"@opengeni/config": patch
"@opengeni/runtime": patch
---

Fail closed when Modal Computer/Browser is enabled without a digest-pinned desktop image, and classify a missing `opengeni-browserd-up` as unsupported instead of a retryable driver failure.
