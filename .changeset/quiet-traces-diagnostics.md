---
"@opengeni/observability": patch
"@opengeni/config": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Add isolated async trace context, parent/link export, bounded trace batching and
retry health, and opt-in protected failure diagnostics independent of the
application database. Preserve the public telemetry privacy projection.