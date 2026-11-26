---
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/observability": patch
"@opengeni/runtime": patch
---

A sandbox whose workspace was already saved, but whose box was gone before the drain could stop it, now finishes draining on the next reaper tick instead of failing every 30 seconds and staying fenced. Leases already stuck this way recover on their own. The drain-failure warning names the thrown error's class, and a sandbox refused by a running-box or daily limit answers 429 with `Retry-After` so retrying clients back off.

Model calls to a customer's own OpenAI-compatible endpoint that cannot be reached (connection, DNS, TLS or timeout) or that answer a client error other than 400/422 now count as `customer_provider` failures instead of platform failures.
