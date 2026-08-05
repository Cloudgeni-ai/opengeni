---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Use one terminal-response ordinal for provider context binding, and clear the
durable input-token signal when the latest provider response supplies no usable
usage instead of retaining an older response's count.
