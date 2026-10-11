---
"@opengeni/db": patch
---

Add provider-neutral subscription-core database routines. The shared subscription runtime now passes the provider as data to one set of routines for credential refresh, connection health, accepted authority and personal account management, instead of calling routines named after one provider. Codex behaves exactly as before: the new routines are equivalent, take the same locks in the same order, and the Codex-named routines stay in place for binaries that still use them. A small registry of providers on the shared core supplies the few per-provider facts these routines need, and any provider without a registry entry is refused.
