---
"@opengeni/runtime": patch
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Bound Claude's final serialized request and inline image bytes. Recover a first
request-size rejection through one durable checkpoint while preserving the
latest complete input/tool batch, signed thinking, and original history. Keep
the recovery allowance across attempt restarts and report content-free size
diagnostics instead of retrying an unchanged oversized request.
