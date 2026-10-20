---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/runtime": patch
---

An embedding product can give its agent a few of its own tools from the first request: `toolServer.eager` (and `eager` on a session's `mcpServers` entry or tool reference) now takes a list of tool names. Listed tools are visible from the start and stay visible; the server's other tools remain behind tool search. New sessions now reuse the account's shared cached prompt prefix on OpenAI-wire models (Codex subscription, OpenAI and Azure), so their first request is no longer recomputed from scratch.
