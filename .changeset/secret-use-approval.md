---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
---

Vault items, or single fields of them, can be marked "ask me each time". Agents still see and reference a marked item, but a use that no approval covers stops before any value is read and fails with the new `approval_required` code, and Opengeni asks the person with its own card describing the blocked use (item and field, surface, tool and destination). Only the person the run acts for can answer it, and the answer becomes a grant: allow once, allow in this chat, allow for an hour across the person's chats in the workspace, or deny. The check runs in the shared resolver, so hosted and connected vaults and every surface behave the same. New routes `GET`/`PUT /v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId/approval` and `POST …/approval/grants/:grantId/revoke` (people only for changes), SDK methods `getItemApproval`, `setItemApproval` and `revokeItemGrant`, an "Ask before each use" section on the item page, and migration 0952 (rolling) adding the `secret_approval_rules` and `secret_use_approvals` tables. `SecretUseContext` gains optional `destination` and `lookupDestination`, and secret-use audit rows list the approvals a use relied on.
