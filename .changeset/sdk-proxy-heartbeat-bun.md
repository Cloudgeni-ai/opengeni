---
"@opengeni/sdk": patch
---

The session proxy's SSE heartbeat now defaults to 5 seconds instead of 15. Bun.serve (and Hono on Bun) closes a connection that sends nothing for 10 seconds by default, so quiet chat and workspace event streams dropped and reconnected every 10 seconds, and showed up as repeated 500s behind the Vite dev proxy.
