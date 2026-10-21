---
"@opengeni/api-router": patch
---

Connecting a Claude or SuperGrok subscription (and the other subscription pool, site publishing and account routes) now works from the web app of a local `bun run dev` stack, as Codex already did. Every cookie-authenticated state change now uses one browser-origin rule: managed and configured deployments still require the configured public origin with `same-origin` fetch metadata, while local access mode accepts the stack's own loopback web origin instead of failing with 503 (no public base URL) or 403 (web and API on different ports).
