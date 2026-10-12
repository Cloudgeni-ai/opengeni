---
"@opengeni/db": patch
---

A session pinned to one provider's subscription account no longer stalls when it switches to another provider's model on the shared subscription core: that work picks an account automatically and the pin stays, so switching back uses the pinned account again. Choosing "automatic" for Codex no longer clears another provider's pin, and a pinned account that was deleted now waits for a new choice instead of silently pinning a different account.
