---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
---

An organization service key can change an existing external member's
permissions in one shared workspace without removing and re-adding them:
`PATCH /v1/organizations/:organizationId/workspaces/:workspaceId/external-members/:membershipId`
(`updateExternalWorkspaceMember` in the SDK) with `{ operationId, permissions }`.
It is keyed and idempotent like a grant, capped by the key's permissions, and
never cancels or tears down work. Narrowing also advances the member's
organization authorization revision so frozen authority re-checks on next use.
Rolling migration 0540 adds the `update` action to the external membership
operation ledger.
