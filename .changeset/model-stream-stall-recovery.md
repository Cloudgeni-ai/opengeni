---
"@opengeni/runtime": patch
"@opengeni/config": patch
---

A model stream that stalls mid-response no longer leaves a turn `running` indefinitely. Generic OpenAI-compatible streams (built-in OpenAI/Azure and registry chat/responses providers) now fail after 5 minutes without a response byte, or 10 minutes of keepalive-only traffic without model progress, measured only while the consumer is waiting. Both reset on activity and are configurable (`OPENGENI_MODEL_STREAM_IDLE_TIMEOUT_MS`, `OPENGENI_MODEL_STREAM_PROGRESS_TIMEOUT_MS`, or per registry provider `streamIdleTimeoutMs` / `streamProgressTimeoutMs`). The stall, and a fetch-layer "The operation timed out." error, now classify as retryable provider failures, so the same turn recovers within the existing finite five-attempt budget instead of failing terminally.
