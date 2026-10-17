---
"@opengeni/codex": patch
---

A conversation whose Responses WebSocket drops mid-response twice within ten minutes uses HTTP for the next 30 minutes, as the Codex CLI falls back to HTTPS after repeated WebSocket failures. A completed response clears the count. Those requests report `http; reason=stream_dropped`.
