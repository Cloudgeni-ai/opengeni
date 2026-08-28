---
"@opengeni/db": patch
"@opengeni/events": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Overlap optional MCP preparation with first inference even when artifact tooling is enabled, keep optional eager integrations off the first-token critical path, reuse immutable large-history projections incrementally, and expose fenced event-append phase latency without changing durable ordering.
