---
"@opengeni/observability": patch
---

Spans are batched on a short timer (up to 256 per OTLP request) instead of per microtask, so busy workers no longer overflow the bounded export queue and drop spans.
