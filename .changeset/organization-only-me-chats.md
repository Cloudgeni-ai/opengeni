---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Add an owner/admin organization setting that enables Only-me chats in shared
workspaces for organizations holding the session-tenancy readiness receipt
(`GET`/`PATCH /v1/organizations/:organizationId/private-session-settings`,
`@opengeni/sdk/organization-private-session-settings`, and the organization
settings page). Already activated organizations are backfilled enabled.
