---
"@opengeni/db": minor
---

Workspace-owned connections no longer bypass the accepted connection-use authority: resolve_accepted_connection_use gains a workspace lane (migration 0279) that revalidates the exact live workspace-owned connection inside the canonical lifecycle fences and records the same idempotent audit facts as personal delegations, and the worker routes workspace-scope MCP credential resolution and per-provider-request authorization through it. Only a pre-snapshot ref with no connection id keeps the bounded unprivileged legacy resolution.
