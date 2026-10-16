---
"@opengeni/vaults-protonpass": minor
"@opengeni/vaults-keeper": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Add `@opengeni/vaults-protonpass`, a Proton Pass provider that runs an operator-installed `pass-cli` 2.4.2 under a scoped personal access token (live reads, file reads, creating logins, notes and custom items, and moving items to trash), and `@opengeni/vaults-keeper`, a Keeper Secrets Manager provider on the pinned official SDK 17.6.0 (one-time token bootstrap, persisted key rotation, live reads, file reads, creating logins and notes, and field updates with revision checks).

The API and worker load both through `createNativeExternalVaultFactories(settings)`: Keeper always, with every request and file download DNS-pinned, and Proton Pass only when `OPENGENI_PROTON_PASS_CLI_PATH` names an operator-installed CLI, with one pooled CLI session per token. Both images ship the Keeper SDK as an installed package.
