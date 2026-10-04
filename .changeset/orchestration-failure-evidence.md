---
"@opengeni/api-router": patch
"@opengeni/observability": patch
---

Retain bounded, redacted diagnostic evidence for unexpected first-party session creation, messaging and steering failures. Correlate the failed-tool receipt and optional protected export using one diagnostic ID and the signed caller attempt; preserve original error classifications and mutation uncertainty even when diagnostics are disabled or unavailable.