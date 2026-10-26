# @opengeni/vaults-bitwarden

## 5.4.2

### Minor Changes

- 3cd4985: Passkeys kept in a connected password manager now work for agents. A Bitwarden or Vaultwarden login with a passkey, a Keeper login record with a passkey, or a Proton Pass login with a passkey shows `hasPasskey`, matches a `passkey` search, and signs in through the agent's managed browser like a hosted passkey. Only which items hold a passkey is mirrored (credential id, site, account name); the private key is read live from the provider when a browser needs it and is never stored. After a sign-in the signature counter is written back to Bitwarden and Keeper unless the vault is linked read-only; for Proton Pass, whose CLI cannot edit items, Opengeni keeps the count itself. Providers implement the new optional `readPasskeys` and `updatePasskeySignCount`, and `capabilities().passkeys` becomes a boolean. 1Password's SDK does not expose passkeys, so 1Password passkeys stay unusable. Items that need approval for each use are no longer loaded into a browser, hosted passkeys included.

### Patch Changes

- Updated dependencies [931325b]
- Updated dependencies [d649005]
- Updated dependencies [5aa883b]
- Updated dependencies [4488c59]
- Updated dependencies [5a48fe7]
- Updated dependencies [3ee89da]
- Updated dependencies [f6298be]
- Updated dependencies [58d272f]
- Updated dependencies [01188c9]
- Updated dependencies [995c16f]
- Updated dependencies [53e1fe5]
- Updated dependencies [d30a243]
- Updated dependencies [659f5a4]
- Updated dependencies [5b9feb9]
- Updated dependencies [de7087a]
- Updated dependencies [cb15454]
- Updated dependencies [a8b429e]
- Updated dependencies [57cfc37]
- Updated dependencies [f20b8fb]
- Updated dependencies [96502c5]
- Updated dependencies [5f332c1]
- Updated dependencies [3cd4985]
- Updated dependencies [24b71c6]
- Updated dependencies [54c2f9e]
- Updated dependencies [936d9e0]
- Updated dependencies [4651b0d]
  - @opengeni/contracts@5.4.0
  - @opengeni/vaults@5.4.0

## 5.3.1

### Minor Changes

- f3d19a2: Bitwarden and Vaultwarden connect directly, like the other password managers. A new package, `@opengeni/vaults-bitwarden`, talks to the server's client API with the account's personal API key and decrypts items itself, so connecting needs only the server address, the API key and the master password, entered once. No bridge program or Bitwarden CLI runs anywhere, and nothing has to be unlocked by hand. Opengeni stores the API key, the server's addresses and the account's user key; the master password is used during setup and never stored. Works with Bitwarden Cloud (US and EU), self-hosted Bitwarden and Vaultwarden.

  The account sees My vault and every organization collection it belongs to, each as its own vault, read-only where the collection is. A hide-passwords collection allows plain fields but refuses passwords, one-time passwords and files. Values are read live on every use and never cached. Writes create logins and notes, patch fields and move items to Bitwarden's trash, and a write that raced another client is a conflict instead of an overwrite.

  Breaking for Bitwarden connections only: the Bitwarden credential is now `{ provider: "bitwarden", serverUrl, clientId, clientSecret, masterPassword }`, Bitwarden is no longer a remote provider on the signed `opengeni.vault.v1` protocol (`VaultProviderWireProvider` is `"external"` only), and a connection saved with the old bridge settings reports that it must be removed and connected again. The bridge package is gone. The shared provider operation helpers Keeper and Proton Pass used now live in `@opengeni/vaults`.

### Patch Changes

- 3fa5c6e: Show connected-vault usernames in secret search and vault summaries using an
  optional, bounded provider display hint. Encrypt the hint separately from
  provider-resolved fields without fetching additional secret values. Existing
  mirrors receive the hint on their next item sync; force a refresh to populate
  unchanged inventories immediately.
- Updated dependencies [c8ddf55]
- Updated dependencies [1988e97]
- Updated dependencies [e7f5d38]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
- Updated dependencies [ce72530]
- Updated dependencies [4c6bf32]
- Updated dependencies [f3d19a2]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [9f6cab2]
- Updated dependencies [6f6c356]
- Updated dependencies [d502ba3]
- Updated dependencies [cccd692]
- Updated dependencies [3fa5c6e]
- Updated dependencies [d6c7c4a]
- Updated dependencies [392db50]
- Updated dependencies [31bca3c]
- Updated dependencies [6acfbd3]
- Updated dependencies [21e7ecf]
- Updated dependencies [627b2f1]
- Updated dependencies [c307566]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [f9f0607]
- Updated dependencies [cc319f3]
- Updated dependencies [3b1d8c1]
- Updated dependencies [7d419e2]
- Updated dependencies [e5446f1]
- Updated dependencies [83682c3]
- Updated dependencies [a9809ee]
- Updated dependencies [acac580]
- Updated dependencies [f3d19a2]
- Updated dependencies [31c3308]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0
  - @opengeni/vaults@5.3.0
