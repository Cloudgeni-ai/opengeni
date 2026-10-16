---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/vaults-onepassword": patch
---

Settle connected-vault inventory and status together against the cache epoch read before provider I/O. A late overlapping refresh cannot overwrite another completed check, including unchanged checks and failures. Superseded refreshes are not replayed; reference resolution rereads the settled inventory.

Preflight managed 1Password creation through the exact local link checks, rolling back all local trial effects before provider I/O. Predictable name, quota and authority refusals create nothing upstream. If a race or a later step fails after confirmed creation, return the existing provider vault identity and link/refresh recovery guidance instead of inviting another create. Failed group grants retain the created identity and still link the vault; unknown creates are never automatically retried. No destructive compensation or exactly-once guarantee is introduced.
