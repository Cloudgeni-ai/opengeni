---
"@opengeni/vaults-onepassword": minor
"@opengeni/vaults": minor
"@opengeni/core": minor
"@opengeni/config": minor
---

Add `@opengeni/vaults-onepassword`, a 1Password service-account vault provider on the pinned `@1password/sdk` 0.5.0: live value reads with a per-attempt cache, a metadata mirror, two-way item writes (generated passwords and TOTP), archive, managed-vault creation, error mapping and a plan-aware request quota. Embedders can supply their own password manager as `connectionCredentials.vaultProvider`, linked as vaults with `source: "host"`. `OPENGENI_ONEPASSWORD_FAKE_TOKENS` enables fake 1Password tokens for local development and is refused by the managed runtime.
