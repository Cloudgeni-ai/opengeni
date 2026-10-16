---
"@opengeni/codex": patch
---

Codex subscription requests now actually use the Responses WebSocket. The model client sends its request body as a stream, which the socket transport treated as ineligible, so every request silently went over HTTP.
