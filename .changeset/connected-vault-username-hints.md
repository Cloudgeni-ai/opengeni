---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/vaults": patch
"@opengeni/vaults-bitwarden": patch
"@opengeni/vaults-onepassword": patch
"@opengeni/vaults-protonpass": patch
"@opengeni/vaults-keeper": patch
---

Show connected-vault usernames in secret search and vault summaries using an
optional, bounded provider display hint. Encrypt the hint separately from
provider-resolved fields without fetching additional secret values. Existing
mirrors receive the hint on their next item sync; force a refresh to populate
unchanged inventories immediately.
