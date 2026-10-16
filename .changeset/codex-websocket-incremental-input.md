---
"@opengeni/codex": patch
"@opengeni/worker-bundle": patch
---

Codex WebSocket requests continue the previous response on the same connection: when a request extends the last completed response exactly, it sends `previous_response_id` and only the new input items, and falls back to the full request otherwise or when the backend no longer holds that response. Each request's transport label and the model-request phase metrics now say whether the input was full or incremental.
