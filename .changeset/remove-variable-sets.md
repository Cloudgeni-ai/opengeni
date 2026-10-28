---
"@opengeni/sdk": major
"@opengeni/react": patch
---

Removed the retired Variable Set and environment fields. Vaults replaced Variable Sets in SDK 2.0.0, and nothing has used these fields since:

- Sessions, session create and fork requests, new-session drafts and scheduled tasks no longer carry `variableSetId`, `variableSetIds` or `environmentId`.
- Rig versions and rig create or edit requests no longer carry `defaultVariableSetIds`.
- Incident telemetry data routes name their vault and secrets directly (`{ kind: "vault", vaultName, secretNames }`), and the preflight reports `requiredVaultNames` and `requiredSecretNames`.
- The retired `variable-sets:*` and `environments:*` permissions in workspace roles, memberships, API keys and Slack access requests are rewritten to the matching `secrets:*` permissions.
