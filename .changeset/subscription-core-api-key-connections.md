---
"@opengeni/db": patch
"@opengeni/subscriptions": patch
---

Let the shared subscription runtime manage API-key connections the same way as subscription connections. Each provider on the shared core now records which kind of connection it uses, and the shared routines, writers and placement read that instead of assuming a subscription, so a future API-key connector (such as OpenRouter or Vercel AI Gateway) needs only its own adapter and registration. A shared settlement step now records an upstream refusal the same way for every provider, with per-provider fallback times when the upstream gives no reset. No provider, table or route is added, and Codex behaves exactly as before. A conformance suite now runs the same placement, lease, request, failover, health and wait tests for Codex and for a test-only API-key connector.
