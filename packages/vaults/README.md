# `@opengeni/vaults`

Provider-side building blocks for Opengeni secrets (vaults). The shared types
(vaults, items, references, the resolver contract, the password generator and
TOTP) live in `@opengeni/contracts`; access decisions and the hosted resolver
live in `@opengeni/core` (`domain/vaults`).

This package owns:

- `VaultProvider`, the interface every external vault source implements
  (1Password in `@opengeni/vaults-onepassword`, an embedder's host provider,
  and the in-memory fake), plus `VaultProviderError` and its codes;
- `createVaultProviderRegistry`, which picks the provider for a vault;
- `createProviderCallBudget`, the per-attempt provider call budget;
- the shell splice contract (`spliceShellCommand`, `dialectFromShell`) used
  by `exec_command` and `run_on` to turn references into per-command
  environment variables;
- test doubles under `@opengeni/vaults/testing`: `createFakeVaultProvider`,
  `createStaticSecretResolver` and `runVaultProviderContractSuite`.

Providers never see principals: access is decided before a provider is called.
Provider errors always map to a `VaultProviderErrorCode`; nothing is swallowed.
