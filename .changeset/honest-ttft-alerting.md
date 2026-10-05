---
"@opengeni/worker-bundle": patch
---

Time-to-first-token is now honest and alerted where it is actionable. TTFT buckets run to 300 seconds instead of saturating at 10. New `opengeni_model_request_pre_dispatch_seconds` measures OpenGeni's own per-request work before the provider sees bytes, and `opengeni_model_provider_ttft_seconds{content="any"|"text"}` measures provider latency from literal dispatch. The absolute first-token alert is replaced by tight alerts on OpenGeni-owned dispatch latency and a per-provider regression alert against each provider's own 24-hour baseline.
