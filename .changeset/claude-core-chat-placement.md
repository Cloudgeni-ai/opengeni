---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/subscriptions": patch
---

Prepare Claude subscription chat turns for the shared subscription core. A Claude turn reads its provider route once: without the Claude cutover it runs exactly as before; during maintenance it fails with typed copy; on the core it is placed, leased and funded like the other subscriptions, every model, web-search continuation and session-title request is reserved and settled before and after it goes out, an unknown outcome is never replayed, and an unauthorized response is retried at most once, on the same account, after one forced refresh. On the core, workspace model policy must allow a workspace-scoped Claude model under both its own and the organization's provider identity. Nothing changes today: no organization has the Claude cutover, so Claude, SuperGrok and Codex behave exactly as before.
