---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/subscriptions": patch
---

Prepare Claude subscription chat turns for the shared subscription core. A Claude turn reads its provider route once: without the Claude cutover it runs exactly as before; during maintenance it fails with typed copy; on the core it is placed, leased and funded like the other subscriptions, every model and session-title request is reserved and settled before and after it goes out, an unknown outcome is never replayed, and an unauthorized response is retried at most once, on the same account, after one forced refresh. Workspace model policy now judges each Claude model by its own scope. Nothing changes today: no organization has the Claude cutover, so Claude, SuperGrok and Codex behave exactly as before.
