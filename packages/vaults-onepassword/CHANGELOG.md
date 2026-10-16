# @opengeni/vaults-onepassword

## 3.4.0

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/contracts@3.4.0
  - @opengeni/vaults@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/contracts@3.3.0
  - @opengeni/vaults@3.3.0

## 3.2.2

### Patch Changes

- a0c35a1: Scope the per-attempt 1Password item cache to the connection and token that read an item and to the vault's durable cache epoch, so a mirror refresh in any API or worker process makes later reads fetch the item again; `forceRefresh` always reads it again. A write that 1Password fails without a classified answer after it was sent is reported as `provider_outcome_unknown` instead of `provider_unavailable`, so it is never presented as safe to repeat.
- a0c35a1: Settle connected-vault inventory and status together against the cache epoch read before provider I/O. A late overlapping refresh cannot overwrite another completed check, including unchanged checks and failures. Superseded refreshes are not replayed; reference resolution rereads the settled inventory.

  Preflight managed 1Password creation through the exact local link checks, rolling back all local trial effects before provider I/O. Predictable name, quota and authority refusals create nothing upstream. If a race or a later step fails after confirmed creation, return the existing provider vault identity and link/refresh recovery guidance instead of inviting another create. Failed group grants retain the created identity and still link the vault; unknown creates are never automatically retried. No destructive compensation or exactly-once guarantee is introduced.

- Updated dependencies [a0c35a1]
- Updated dependencies [a0c35a1]
  - @opengeni/vaults@3.2.0
  - @opengeni/contracts@3.2.0

## 3.1.2

### Patch Changes

- Updated dependencies [17d61c6]
- Updated dependencies [1e67711]
- Updated dependencies [0bdb953]
- Updated dependencies [79af429]
- Updated dependencies [877c70d]
  - @opengeni/contracts@3.1.0
  - @opengeni/vaults@3.1.0

## 3.0.0

### Patch Changes

- e9a4fee: A server that cannot load the 1Password SDK (for example an image missing its WASM core) now reports `provider_unavailable` with a plain reason, instead of an unhandled error that surfaced as a generic 500. Connecting and syncing then say what is wrong, the vault records it as its sync status, and the next call tries to load the SDK again.
- Updated dependencies [501bb83]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
- Updated dependencies [d367818]
  - @opengeni/contracts@3.0.0
  - @opengeni/vaults@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [2ea5f7b]
  - @opengeni/contracts@2.0.1
  - @opengeni/vaults@2.0.1

## 2.0.0

### Minor Changes

- 945c247: Add `@opengeni/vaults-onepassword`, a 1Password service-account vault provider on the pinned `@1password/sdk` 0.5.0: live value reads with a per-attempt cache, a metadata mirror, two-way item writes (generated passwords and TOTP), archive, managed-vault creation, error mapping and a plan-aware request quota. Embedders can supply their own password manager as `connectionCredentials.vaultProvider`, linked as vaults with `source: "host"`. `OPENGENI_ONEPASSWORD_FAKE_TOKENS` enables fake 1Password tokens for local development and is refused by the managed runtime.

### Patch Changes

- 42c87e4: Spell the product Opengeni in agent prompts, bundled Skills, tool descriptions and vault messages. Code identifiers, header names, wire values, persisted labels and pinned curated Skills keep their existing spelling.
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
- Updated dependencies [945c247]
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
  - @opengeni/vaults@2.0.0
