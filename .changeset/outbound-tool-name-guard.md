---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Turns no longer fail because a provider rejects a tool name. Just before each model request is sent (OpenAI Responses including the Codex websocket, Chat Completions and gateways, and Anthropic Messages), every tool name in the request is checked: valid names are sent unchanged, and any other name gets a stable alias used consistently across the tools list, tool choice and history. Calls to an alias are mapped back to the original tool. If a provider still rejects a tool name, the request is resent once with portable names. New metrics count these repairs and resends.
