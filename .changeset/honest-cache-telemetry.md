---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Preserve provider-reported prompt-cache writes through source-key-authoritative production usage paths, deduplicate mirrored and retried terminal responses before response-scoped side effects, derive billing and context totals from canonical input/output and complete SDK request aggregates, distinguish unknown cache reads from real zeros with call-traffic-aware availability alerting, and reject inconsistent or unsafe token values before billing or metrics.
