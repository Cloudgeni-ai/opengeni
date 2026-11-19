---
"@opengeni/network": patch
"@opengeni/codex": patch
---

A request on a Responses WebSocket now continues the previous response after any item type, including hosted web searches, image generation, file search, code interpreter, computer, shell, apply_patch and MCP calls, instead of resending the whole input. The continuation check used to recognize only a fixed list of types, so every response containing another type ended the chain, and the backend's different rendering of the full input missed the prompt cache from the first differing item. One shared function (`replayedResponsesItem` in `@opengeni/network/responses-replay`) now defines what replay strips, a provider id and an output-only status. The Codex request normalizer applies it on replay, and the continuation check applies it to both sides before comparing. A real difference in content, action, arguments or a required status still sends the full request. The replay-status list moves to the same module; `@opengeni/codex` re-exports it unchanged.
