---
"@opengeni/runtime": patch
---

Enable automatic prompt caching for OpenRouter Anthropic Chat models without changing earlier message or tool content, while preserving explicit caller cache controls. Preserve provider input-token details, including cache writes, through streamed and non-streamed Chat usage accounting.
