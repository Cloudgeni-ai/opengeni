---
"@opengeni/sdk": major
"@opengeni/react": major
---

Variable Sets are replaced by vaults. Secrets live as items with fields in vaults owned by a task, a person ("Only me"), a workspace or the organization, and agents use them through `{{secret:Vault/Item/field}}` references that resolve when a tool, command or browser action runs. Existing Variable Sets were migrated to vaults with the same ids and values.

Removed: the `/variable-sets` and `/environments` routes (now 410 `variable_sets_removed`), `PUT /sessions/:sessionId/variable-sets`, the `variableSetIds`/`variableSetId`/`environmentId` request fields on sessions, forks, drafts and schedules and `defaultVariableSetIds` on rigs (now 422 when they carry a value), `OpenGeniClient` `listVariableSets`, `resolveVariableSetAttachments`, `createVariableSet`, `getVariableSet`, `getVariableSetVariable`, `updateVariableSet`, `deleteVariableSet`, `setVariableSetVariable`, `deleteVariableSetVariable`, `updateSessionVariableSets` and the deprecated `*Environment*` aliases, their types, and React `useVariableSets`/`useEnvironments`.

Added: `client.vaults(workspaceId)` (vault, item, field-history, reveal, session vault policy and 1Password routes), the vault wire types, `vaultErrorCode`/`vaultErrorDetail`, `vaultPolicy` on session create and schedules, and React `useVaults`, `useVault`, `useVaultItems`, `useVaultItem`, `useVaultFieldVersions`, `useSessionSecrets` and `useVaultsApi`. Read fields that carried the old selection (`variableSetIds`, `variableSetId`, `environmentId`, `defaultVariableSetIds`) remain on responses as inert, deprecated legacy data.

This removal ships in SDK 2.0.0 without the usual 90-day deprecation window, as an explicit exception to the API compatibility policy.
