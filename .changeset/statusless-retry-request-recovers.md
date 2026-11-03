---
"@opengeni/worker-bundle": patch
---

A model provider error that arrives without an HTTP status and asks to retry, such as an OpenAI-compatible server reporting "model returned malformed tool_call output; please retry" in the middle of a streamed response, now recovers the same turn within the usual provider recovery budget instead of failing the turn on the first bad generation. A real 4xx status still fails the turn as a request fault.
