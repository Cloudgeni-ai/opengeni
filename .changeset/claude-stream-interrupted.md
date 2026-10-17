---
"@opengeni/runtime": patch
---

Claude response streams that go silent or end without `message_stop` now raise `AnthropicStreamInterruptedError` (code `anthropic_stream_interrupted`), so callers can tell a dropped connection from a protocol violation.
