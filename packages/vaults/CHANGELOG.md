# @opengeni/vaults

## 3.2.2

### Minor Changes

- a0c35a1: Provider listings now say whether they prove which items are absent. `traverseProviderPages`, `readProviderVaultInventory` and `readProviderItemInventory` return `{ items, consistent }`, where consistent means one response or every page under one snapshot. `collectProviderPages`, `listProviderVaults` and `listProviderItems` keep their bounded enumeration for discovery.

  A connected vault's mirror is replaced only from a consistent inventory. A multi-page listing without a snapshot keeps the previous mirror and records `provider_inventory_incomplete`, because offset cursors can skip an existing item when an earlier one is deleted between pages; a vault missing from such a vault listing is not reported as removed. An item with more than 50 fields or 20 websites, or a website over 2,048 characters, also makes the inventory incomplete instead of being cut down, and the previous mirror is kept.

- a0c35a1: Add the signed remote vault protocol `opengeni.vault.v1`. `@opengeni/contracts/vault-provider-wire` defines its bounded request and response schemas; item metadata has no value fields. `@opengeni/vaults` adds `createRemoteVaultProvider`, which signs each request with the connection secret, verifies signed responses, pages inventory without silent truncation, and reports an uncertain write as `provider_outcome_unknown` instead of retrying it. Server-side embedders can serve their own password manager with `createExternalVaultReceiver` from `@opengeni/sdk/external-vault-receiver`. It checks the signature, request age and replay, maps Opengeni's account, workspace and user to the host's tenant and user on every request, and records writes in a caller-owned durable store keyed by idempotency key.

### Patch Changes

- Updated dependencies [a0c35a1]
  - @opengeni/contracts@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies [17d61c6]
- Updated dependencies [1e67711]
- Updated dependencies [0bdb953]
- Updated dependencies [79af429]
- Updated dependencies [877c70d]
  - @opengeni/contracts@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [501bb83]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
- Updated dependencies [d367818]
  - @opengeni/contracts@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [2ea5f7b]
  - @opengeni/contracts@2.0.1

## 2.0.0

### Minor Changes

- 945c247: Add `@opengeni/vaults-onepassword`, a 1Password service-account vault provider on the pinned `@1password/sdk` 0.5.0: live value reads with a per-attempt cache, a metadata mirror, two-way item writes (generated passwords and TOTP), archive, managed-vault creation, error mapping and a plan-aware request quota. Embedders can supply their own password manager as `connectionCredentials.vaultProvider`, linked as vaults with `source: "host"`. `OPENGENI_ONEPASSWORD_FAKE_TOKENS` enables fake 1Password tokens for local development and is refused by the managed runtime.
- 945c247: Add the shared contracts for vaults and secret references: vault, item, field and version schemas, vault policies and limits, the `{{secret:…}}` reference grammar and tokenizer, secret resolver types, the `secrets` agent capability, the `secrets:use` permission with aliases for the older variable-set names, and `kind: "secret"` human-input questions with write-only `secretAnswers`. Add the shared password generator and TOTP helpers. The new `@opengeni/vaults` package holds the vault provider interface, a provider registry, shell splice signatures, and test doubles under `@opengeni/vaults/testing`.

### Patch Changes

- Updated dependencies [fc57bd2]
- Updated dependencies [04ebc42]
- Updated dependencies [e03f1ff]
- Updated dependencies [c2f4153]
- Updated dependencies [de2d721]
- Updated dependencies [055015d]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [6861501]
- Updated dependencies [bfed4f1]
- Updated dependencies [4532435]
- Updated dependencies [f96605f]
- Updated dependencies [496ce55]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [ce7b403]
- Updated dependencies [445baf4]
- Updated dependencies [5b4a738]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [f7d53b2]
- Updated dependencies [c13d080]
- Updated dependencies [061ae01]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [6313dd8]
- Updated dependencies [945490f]
- Updated dependencies [8e878ac]
- Updated dependencies [9701372]
- Updated dependencies [bc40348]
- Updated dependencies [5eb1c32]
- Updated dependencies [da01634]
- Updated dependencies [ab3306a]
- Updated dependencies [4cb80a9]
- Updated dependencies [eb68b58]
- Updated dependencies [38b1ba1]
- Updated dependencies [6960770]
- Updated dependencies [3426850]
- Updated dependencies [412671a]
- Updated dependencies [63bf721]
- Updated dependencies [3a4a435]
- Updated dependencies [14343e4]
- Updated dependencies [2b8ee21]
- Updated dependencies [71c42bf]
- Updated dependencies [a390b9e]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [322f26c]
- Updated dependencies [945c247]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [5cb6d71]
- Updated dependencies [732a788]
- Updated dependencies [8cf9e0a]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [7ce535f]
- Updated dependencies [35fb6fd]
- Updated dependencies [35fb6fd]
- Updated dependencies [7bf1a02]
- Updated dependencies [a13bf1a]
- Updated dependencies [a91718c]
  - @opengeni/contracts@2.0.0
