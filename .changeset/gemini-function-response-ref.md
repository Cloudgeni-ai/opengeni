---
"@opengeni/runtime": patch
---

Gemini upstream models (any OpenAI-compatible route, e.g. Vercel AI Gateway to Vertex) no longer fail a turn with `400 The referenced name ... in function_response.response does not match to a display_name` when a JSON tool result contains a `$ref` key, such as the parameter schemas returned by `tool_search`. The request-local provider view renames those object keys to `_$ref`; durable history is unchanged.
