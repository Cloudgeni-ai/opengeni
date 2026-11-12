---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Gemini 3 and later on Google's own OpenAI-compatible endpoints (AI Studio and Vertex) no longer fail on the first request after a tool call. Streamed Chat Completions tool calls now keep the fields the provider returned beyond the call itself, such as Gemini's `extra_content` thought signature, as non-streamed calls already did, so the follow-up request sends the signature back. Parallel tool calls streamed without an `index`, as Gemini on AI Studio sends them, now stay separate calls instead of being merged into one. The call records the provider that returned these fields: only that provider receives them again, and any other provider on Chat Completions or Responses gets the plain call. Provider error bodies wrapped in a JSON array, as Google sends them, are now read for the provider's bounded message and status code, so a failed turn shows the provider's reason instead of "400 status code (no body)".
