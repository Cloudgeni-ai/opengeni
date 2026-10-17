---
"@opengeni/codex": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A Codex turn now opens its conversation's Responses WebSocket while the rest of the turn prepares, so the first model request no longer waits for the handshake (about half a second on a new connection). A request that arrives while that handshake is still in progress waits for it instead of opening a second connection, and the model SDK's own telemetry headers no longer split a conversation's connection.
