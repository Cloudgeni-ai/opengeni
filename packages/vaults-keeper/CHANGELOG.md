# @opengeni/vaults-keeper

## 3.3.0

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/contracts@3.3.0
  - @opengeni/vaults@3.3.0

## 3.2.2

### Minor Changes

- a0c35a1: Add `@opengeni/vaults-protonpass`, a Proton Pass provider that runs an operator-installed `pass-cli` 2.4.2 under a scoped personal access token (live reads, file reads, creating logins, notes and custom items, and moving items to trash), and `@opengeni/vaults-keeper`, a Keeper Secrets Manager provider on the pinned official SDK 17.6.0 (one-time token bootstrap, persisted key rotation, live reads, file reads, creating logins and notes, and field updates with revision checks).

  The API and worker load both through `createNativeExternalVaultFactories(settings)`: Keeper always, with every request and file download DNS-pinned, and Proton Pass only when `OPENGENI_PROTON_PASS_CLI_PATH` names an operator-installed CLI, with one pooled CLI session per token. Both images ship the Keeper SDK as an installed package.

### Patch Changes

- Updated dependencies [a0c35a1]
- Updated dependencies [a0c35a1]
  - @opengeni/vaults@3.2.0
  - @opengeni/contracts@3.2.0
