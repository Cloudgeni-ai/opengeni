# @opengeni/vaults-keeper

## 5.3.1

### Patch Changes

- f3d19a2: Bitwarden and Vaultwarden connect directly, like the other password managers. A new package, `@opengeni/vaults-bitwarden`, talks to the server's client API with the account's personal API key and decrypts items itself, so connecting needs only the server address, the API key and the master password, entered once. No bridge program or Bitwarden CLI runs anywhere, and nothing has to be unlocked by hand. Opengeni stores the API key, the server's addresses and the account's user key; the master password is used during setup and never stored. Works with Bitwarden Cloud (US and EU), self-hosted Bitwarden and Vaultwarden.

  The account sees My vault and every organization collection it belongs to, each as its own vault, read-only where the collection is. A hide-passwords collection allows plain fields but refuses passwords, one-time passwords and files. Values are read live on every use and never cached. Writes create logins and notes, patch fields and move items to Bitwarden's trash, and a write that raced another client is a conflict instead of an overwrite.

  Breaking for Bitwarden connections only: the Bitwarden credential is now `{ provider: "bitwarden", serverUrl, clientId, clientSecret, masterPassword }`, Bitwarden is no longer a remote provider on the signed `opengeni.vault.v1` protocol (`VaultProviderWireProvider` is `"external"` only), and a connection saved with the old bridge settings reports that it must be removed and connected again. The bridge package is gone. The shared provider operation helpers Keeper and Proton Pass used now live in `@opengeni/vaults`.

- Updated dependencies [ce72530]
- Updated dependencies [f3d19a2]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [9f6cab2]
- Updated dependencies [6f6c356]
- Updated dependencies [d502ba3]
- Updated dependencies [cccd692]
- Updated dependencies [392db50]
- Updated dependencies [c307566]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [cc319f3]
- Updated dependencies [3b1d8c1]
- Updated dependencies [7d419e2]
- Updated dependencies [e5446f1]
- Updated dependencies [83682c3]
- Updated dependencies [acac580]
- Updated dependencies [f3d19a2]
- Updated dependencies [31c3308]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [c194abb]
  - @opengeni/contracts@5.3.0
  - @opengeni/vaults@5.3.0

## 5.2.1

### Patch Changes

- Updated dependencies [fb72b9d]
  - @opengeni/contracts@5.2.0
  - @opengeni/vaults@5.2.0

## 5.1.2

### Patch Changes

- @opengeni/contracts@5.1.0
- @opengeni/vaults@5.1.0

## 5.0.2

### Patch Changes

- Updated dependencies [487bd43]
- Updated dependencies [a9d20b3]
- Updated dependencies [6d29c01]
- Updated dependencies [217ed52]
  - @opengeni/contracts@5.0.0
  - @opengeni/vaults@5.0.0

## 4.8.0

### Patch Changes

- Updated dependencies [85fb89e]
  - @opengeni/contracts@4.8.0
  - @opengeni/vaults@4.8.0

## 4.7.2

### Patch Changes

- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
  - @opengeni/contracts@4.7.2
  - @opengeni/vaults@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/contracts@4.7.1
- @opengeni/vaults@4.7.1

## 4.7.0

### Patch Changes

- Updated dependencies [31095f1]
  - @opengeni/contracts@4.7.0
  - @opengeni/vaults@4.7.0

## 4.6.1

### Patch Changes

- @opengeni/contracts@4.6.0
- @opengeni/vaults@4.6.0

## 4.5.0

### Patch Changes

- Updated dependencies [f838cb7]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
  - @opengeni/contracts@4.5.0
  - @opengeni/vaults@4.5.0

## 4.4.1

### Patch Changes

- Updated dependencies [e697879]
- Updated dependencies [11e56da]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [81a516c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [84b1a18]
  - @opengeni/contracts@4.4.0
  - @opengeni/vaults@4.4.0

## 4.3.1

### Patch Changes

- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
- Updated dependencies [2963eca]
- Updated dependencies [374dd81]
- Updated dependencies [91329fc]
- Updated dependencies [46a2ef3]
- Updated dependencies [579239a]
- Updated dependencies [ffe09c2]
- Updated dependencies [1b57d74]
- Updated dependencies [277c99c]
- Updated dependencies [b20c9b2]
- Updated dependencies [70f0522]
- Updated dependencies [23fed2a]
- Updated dependencies [e4915c1]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [724b529]
- Updated dependencies [3915617]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [b95784c]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/contracts@4.3.0
  - @opengeni/vaults@4.3.0

## 4.2.0

### Patch Changes

- Updated dependencies [641e179]
- Updated dependencies [e018445]
- Updated dependencies [5715a3e]
- Updated dependencies [47eeb80]
  - @opengeni/contracts@4.2.0
  - @opengeni/vaults@4.2.0

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
