---
"@opengeni/db": patch
---

Sessions keep one subscription account choice per provider on the shared subscription core, as they did before it. Work on one provider's model never reads, replaces or clears another provider's pinned account, so switching back to the pinned provider's model uses the pinned account again, and a session can hold a pin for each provider. Choosing "automatic" for Codex changes only the Codex choice. A pinned account that was deleted now waits for a new choice instead of silently pinning a different account. Migration 0729 rekeys the bindings table in a rolling-compatible way; a session still holds one binding until the next drained provider cutover.
