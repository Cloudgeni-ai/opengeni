---
"@opengeni/observability": patch
---

Separate HTTP duration histograms by bounded status class so successful request latency can be measured independently of fast failures. Existing queries that aggregate all status classes retain historical continuity; success-only queries require newly emitted samples.
