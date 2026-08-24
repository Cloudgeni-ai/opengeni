---
"@opengeni/worker-bundle": patch
---

Apply the documented connectivity backoff sequence to retryable MCP request timeouts, including the workflow checkpoint fallback, while preserving the exact durable count and finite same-turn recovery boundary.