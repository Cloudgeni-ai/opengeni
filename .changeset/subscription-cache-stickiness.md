---
"@opengeni/db": patch
"@opengeni/subscriptions": patch
---

Sessions on the shared subscription core keep their account while the provider's prompt cache is warm. A session moves only when its account can no longer serve it, its model changes or a pin changes, or once it has been idle longer than the cache lifetime the provider's adapter declares. Warmth is no longer carried to an account the session has never used, and parallel placements of one session agree on one account.
