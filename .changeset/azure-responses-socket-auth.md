---
"@opengeni/network": patch
"@opengeni/runtime": patch
---

Use Azure's API-key header for configured API-key credentials on HTTP and Responses WebSocket connections, while preserving Entra bearer authentication and explicit header overrides. Treat a redirected WebSocket upgrade as a refusal and use the existing turn-scoped HTTP fallback without following credential-bearing redirects.
