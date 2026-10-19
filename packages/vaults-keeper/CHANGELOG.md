# @opengeni/vaults-keeper

## 4.1.4

### Patch Changes

- Updated dependencies [47eeb80]
  - @opengeni/contracts@4.1.4
  - @opengeni/vaults@4.1.4

## 4.1.3

### Patch Changes

- @opengeni/contracts@4.1.2
- @opengeni/vaults@4.1.2

## 4.1.1

### Patch Changes

- Updated dependencies [afff3f9]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/contracts@4.1.0
  - @opengeni/vaults@4.1.0

## 4.0.4

### Patch Changes

- Updated dependencies [e7113e3]
- Updated dependencies [2f6b8bd]
- Updated dependencies [9482fe0]
- Updated dependencies [2a81601]
- Updated dependencies [71dfe30]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [79ec9fd]
- Updated dependencies [5927aae]
- Updated dependencies [6ab7b55]
- Updated dependencies [3e061d6]
- Updated dependencies [a22ed79]
  - @opengeni/contracts@4.0.0
  - @opengeni/vaults@4.0.0

## 3.4.0

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [c594c1d]
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

### Minor Changes

- a0c35a1: Add `@opengeni/vaults-protonpass`, a Proton Pass provider that runs an operator-installed `pass-cli` 2.4.2 under a scoped personal access token (live reads, file reads, creating logins, notes and custom items, and moving items to trash), and `@opengeni/vaults-keeper`, a Keeper Secrets Manager provider on the pinned official SDK 17.6.0 (one-time token bootstrap, persisted key rotation, live reads, file reads, creating logins and notes, and field updates with revision checks).

  The API and worker load both through `createNativeExternalVaultFactories(settings)`: Keeper always, with every request and file download DNS-pinned, and Proton Pass only when `OPENGENI_PROTON_PASS_CLI_PATH` names an operator-installed CLI, with one pooled CLI session per token. Both images ship the Keeper SDK as an installed package.

### Patch Changes

- Updated dependencies [a0c35a1]
- Updated dependencies [a0c35a1]
  - @opengeni/vaults@3.2.0
  - @opengeni/contracts@3.2.0
