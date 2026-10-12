---
"@opengeni/db": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": patch
---

Sessions keep one subscription account choice per provider on the shared subscription core, as they did before it. Work on one provider's model never reads, replaces or clears another provider's pinned account, so switching back to the pinned provider's model uses the pinned account again, and a session can hold a pin for each provider. Choosing "automatic" for Codex changes only the Codex choice. A pinned account that was deleted now waits for a new choice instead of silently pinning a different account. Migration 0730 rekeys the bindings table in a rolling-compatible way; a session still holds one binding until the next drained provider cutover.

The neutral model-account API lists all provider choices in `bindings`. Choosing an account changes only that provider's choice. Returning to automatic accepts an optional `provider` to clear only that choice; omitting it resets all explicit choices, preserving the original whole-session action.
