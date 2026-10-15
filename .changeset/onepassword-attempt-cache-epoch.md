---
"@opengeni/vaults-onepassword": patch
---

Scope the per-attempt 1Password item cache to the connection and token that read an item and to the vault's durable cache epoch, so a mirror refresh in any API or worker process makes later reads fetch the item again; `forceRefresh` always reads it again. A write that 1Password fails without a classified answer after it was sent is reported as `provider_outcome_unknown` instead of `provider_unavailable`, so it is never presented as safe to repeat.
