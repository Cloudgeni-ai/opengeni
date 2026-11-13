---
"@opengeni/runtime": patch
---

An unexpected usage shape from an OpenAI Responses provider no longer fails the turn.

- On November 13, 2026 the Codex backend sent `cache_write_tokens_details` as an object, and the turn failed with "expected number, received object".
- Input and output token details now keep only numeric counters: values inside nested objects become `<parent>.<child>` keys, and other values are dropped. This covers Codex, OpenAI and Azure Responses, streamed or not.
- Cost accounting is unchanged because it reads the numeric `cached_tokens` and `cache_write_tokens` counters.
