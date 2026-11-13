---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Opengeni Console (`/console`) lets organization owners and admins review the sessions of workspaces their product's organization key created (managed workspaces), including end users' private sessions, with cost from the credit ledger and an audit log of every transcript opened. Real people's Only me chats are never shown. Review is full transcripts by default and can be set to metadata only or off.

New `/v1/organizations/{organizationId}/console/*` endpoints back it; the SDK adds `getConsoleSummary`, `listConsoleWorkspaces`, `updateConsoleWorkspace`, `listConsoleSessions`, `getConsoleSession`, `listConsoleSessionEvents`, `getConsoleSettings`, `updateConsoleSettings`, `listConsoleAuditLog` and `getConsoleApiKeyUsage`, with types from `@opengeni/contracts/console`.
