---
"@opengeni/db": minor
"@opengeni/core": minor
---

Linked vaults accept the external, Proton Pass, Keeper and Bitwarden sources (migration 0786). Linking checks the connection's provider identity, active and verified status and ownership in the database: a personal connection backs only its owner's Only-me vaults, and a shared connection only vaults of its own ownership. Vaults record the provider's effective operations, its own freshness observation and a durable cache epoch that every complete mirror replacement advances.

A mirror is replaced only by a complete inventory of at most 2,000 items; otherwise the previous mirror is kept and the failure recorded. Refreshes never bypass an active provider rate limit, even when forced, and record operations and freshness even when nothing changed. `secret_search` accepts `refresh` (first page only) and reports `complete` and the checked `sources` on every page, so an unavailable provider is never shown as an empty healthy vault. A reference that misses while a relevant connected vault could not be checked fails with that provider's error instead of a missing-secret ask card; explicitly named healthy or hosted vaults are unaffected. Vault summaries include `providerOperations` and `freshness`.

Connected-vault writes check the vault's effective operations (item type, field removal, one-time passwords, files, archive) before any value is resolved or generated. Permanent deletion, restore and field-history restore are refused for connected items. A move out of a connected vault needs a recoverable archive and archives the original only after the target confirmed the write. An unconfirmed provider write is reported as `provider_outcome_unknown` and never retried; a confirmed write that cannot be listed yet is reported as saved (`provider_inventory_incomplete` with `details.saved`).
