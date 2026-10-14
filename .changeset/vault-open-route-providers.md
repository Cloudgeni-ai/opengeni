---
"@opengeni/api-router": patch
---

Opening a linked vault's item list now refreshes a stale mirror, because the items route reaches the vault's provider. Before, the route had no provider, so items added straight in 1Password still waited for Sync.
