---
"@opengeni/contracts": minor
"@opengeni/vaults": minor
"@opengeni/sdk": minor
---

Add the signed remote vault protocol `opengeni.vault.v1`. `@opengeni/contracts/vault-provider-wire` defines its bounded request and response schemas; item metadata has no value fields. `@opengeni/vaults` adds `createRemoteVaultProvider`, which signs each request with the connection secret, verifies signed responses, pages inventory without silent truncation, and reports an uncertain write as `provider_outcome_unknown` instead of retrying it. Server-side embedders can serve their own password manager with `createExternalVaultReceiver` from `@opengeni/sdk/external-vault-receiver`. It checks the signature, request age and replay, maps Opengeni's account, workspace and user to the host's tenant and user on every request, and records writes in a caller-owned durable store keyed by idempotency key.
