---
"@opengeni/sdk": patch
---

Dispose warmed audio capture and stop all captured media tracks when realtime WebSocket startup fails, including synchronous socket construction, negotiation and asynchronous opening failures. Successful connection and normal stop ownership are unchanged.
