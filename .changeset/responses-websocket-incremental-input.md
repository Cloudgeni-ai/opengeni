---
"@opengeni/codex": patch
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/network": patch
"@opengeni/db": patch
"@opengeni/testing": patch
---

Responses WebSocket requests continue the previous response on the same connection: when a request extends the last completed response exactly, it sends `previous_response_id` and only the new input items, and falls back to the full request otherwise or when the provider no longer holds that response. The transport now serves the OpenAI API (`/v1/responses`) and Azure OpenAI's v1 API (`/openai/v1/responses`) as well as the Codex subscription, with one connection per conversation (`OPENGENI_OPENAI_RESPONSES_WEBSOCKET_ENABLED`, default on). Other OpenAI-compatible hosts stay on HTTP. Each request's transport label and the model-request phase metrics say whether the input was full or incremental.

Share lifecycle and failure policy in the network package. Use the JavaScript WebSocket implementation to release sent buffers, retain only continuation fingerprints, coalesce concurrent handshakes, and retire idle connections when credentials change. The existing durable model-step retry budget owns dropped responses; its final retry uses HTTP, with no additional retry budget or timer-based cooldown. HTTP remains selected through turn recovery and subsequent successful steps, but a new turn tries the socket again. Definitive continuation refusal settles and re-admits request custody before a full-input resend. Transport diagnostics distinguish first-request cache behavior and final-prefix startup overlap; no speculative model prewarm is sent.
