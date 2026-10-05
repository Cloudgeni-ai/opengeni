---
"@opengeni/runtime": patch
---

A tool call whose model-emitted arguments are not a JSON object (truncated output, a leaked provider control token) no longer poisons the session. Model requests now replay such a call with its arguments wrapped request-locally as `{"_invalid_arguments": "<raw text, bounded to 4,000 characters>"}` on the Chat Completions, Responses, and Claude wires. Before, Chat Completions providers rejected every later request with "function.arguments must be valid JSON". Canonical history keeps the exact text, and the wrapper is deterministic, so prompt caching stays stable.
