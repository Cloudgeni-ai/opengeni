---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/vaults": minor
---

Add the shared contracts for vaults and secret references: vault, item, field and version schemas, vault policies and limits, the `{{secret:…}}` reference grammar and tokenizer, secret resolver types, the `secrets` agent capability, the `secrets:use` permission with aliases for the older variable-set names, and `kind: "secret"` human-input questions with write-only `secretAnswers`. Add the shared password generator and TOTP helpers. The new `@opengeni/vaults` package holds the vault provider interface, a provider registry, shell splice signatures, and test doubles under `@opengeni/vaults/testing`.
