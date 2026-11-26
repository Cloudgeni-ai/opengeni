---
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/observability": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
---

A sandbox whose workspace was already saved, but whose box was gone before the drain could stop it, now finishes draining on the next reaper tick instead of failing every 30 seconds and staying fenced. Leases already stuck this way recover on their own. Warm time is charged up to an earlier attempt's recorded stop cutoff, and not past the last meter tick when there is none. The drain-failure warning names the thrown error's class, and `opengeni_sandbox_provider_gone_after_save_total` counts these drains. A sandbox refused by a running-box or daily limit answers 429 with `Retry-After` so retrying clients back off: a young organization's spent first-day box time names when it is a day old, and the turnless first-day bound is a non-retryable 429.

Model calls to a customer's own OpenAI-compatible endpoint whose physical request cannot reach it (connection refused or reset, name not found, TLS, socket or timeout) or that answer a client error other than 400, 404, 405, 413 or 422 now count as `customer_provider` failures instead of platform failures. Our own dispatch checkpoint and resolver failures stay platform.
