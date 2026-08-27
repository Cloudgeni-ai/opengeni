---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Make session and workspace Pause/Resume desired-state mutations report authoritative changed, unchanged, and replayed outcomes. Represented no-ops no longer allocate control revisions, events, interruptions, or wakes, while newer descendant overrides and missing lifecycle repairs still produce real mutations. First-party MCP session control now returns the same versioned mutation receipt for agent-bound and sessionless callers.