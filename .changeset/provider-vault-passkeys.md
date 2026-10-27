---
"@opengeni/vaults": minor
"@opengeni/vaults-bitwarden": minor
"@opengeni/vaults-keeper": minor
"@opengeni/vaults-protonpass": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/runtime": patch
---

Passkeys kept in a connected password manager now work for agents. A Bitwarden or Vaultwarden login with a passkey, a Keeper login record with a passkey, or a Proton Pass login with a passkey shows `hasPasskey`, matches a `passkey` search, and signs in through the agent's managed browser like a hosted passkey. Only which items hold a passkey is mirrored (credential id, site, account name); the private key is read live from the provider when a browser needs it and is never stored. After a sign-in the signature counter is written back to Bitwarden and Keeper unless the vault is linked read-only; for Proton Pass, whose CLI cannot edit items, Opengeni keeps the count itself. Providers implement the new optional `readPasskeys` and `updatePasskeySignCount`, and `capabilities().passkeys` becomes a boolean. 1Password's SDK does not expose passkeys, so 1Password passkeys stay unusable. Items that need approval for each use are no longer loaded into a browser, hosted passkeys included.
