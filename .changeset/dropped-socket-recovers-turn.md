---
"@opengeni/worker-bundle": patch
---

A turn whose model or upstream connection drops mid-response ("The socket connection was closed unexpectedly") now recovers the same turn automatically, even when the network error reaches the worker wrapped inside another error. Before, only an unwrapped error was recognized, so a wrapped one ended the turn with Bun's raw message and no retry. The worker now looks for the network fault code along the whole error cause chain and recognizes Bun's exact dropped-socket text, while an HTTP status stays authoritative. The user sees the standard "will retry after a short delay" notice instead of the raw fetch text.
