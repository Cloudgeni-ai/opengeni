---
"@opengeni/worker-bundle": patch
---

Count provider web search and fetch calls. The worker now exports `opengeni_web_search_calls_total{operation,provider,outcome}` and `opengeni_web_search_call_duration_seconds`, and logs `web search provider call failed` with the provider status, so operators can alert on a failing search provider.
