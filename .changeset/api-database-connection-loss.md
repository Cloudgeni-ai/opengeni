---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Keep the API process alive and answer a retryable 503 (`upstream_unavailable`, `details.code: DATABASE_UNAVAILABLE`) when the database terminates its connections during a deploy drain, failover, or restart, instead of crashing on an unhandled Slack interaction claim rejection or answering an opaque 500.
