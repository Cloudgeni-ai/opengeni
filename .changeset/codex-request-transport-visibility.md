---
"@opengeni/codex": patch
"@opengeni/worker-bundle": patch
---

Each Codex model request now reports how it was carried: over a new or reused Responses WebSocket, or over HTTP with the reason the socket did not carry it (not a streaming request, connection busy, handshake failed or backing off, or no socket transport in the path). The request audit event carries it as `transport`, and the model-request phase metrics gain a bounded `transport` label, so per-step latency can be compared by transport.
