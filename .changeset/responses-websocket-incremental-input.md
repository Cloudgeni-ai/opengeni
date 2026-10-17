---
"@opengeni/codex": patch
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Responses WebSocket requests continue the previous response on the same connection: when a request extends the last completed response exactly, it sends `previous_response_id` and only the new input items, and falls back to the full request otherwise or when the provider no longer holds that response. The transport now serves the OpenAI API (`/v1/responses`) and Azure OpenAI's v1 API (`/openai/v1/responses`) as well as the Codex subscription, with one connection per conversation (`OPENGENI_OPENAI_RESPONSES_WEBSOCKET_ENABLED`, default on). Other OpenAI-compatible hosts stay on HTTP. Each request's transport label and the model-request phase metrics say whether the input was full or incremental.
