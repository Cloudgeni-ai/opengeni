---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
---

Console agents API, for organizations with Console agents turned on (`OPENGENI_ORG_AGENTS_ACCOUNT_IDS`): `/v1/organizations/:id/agents/*` manages organization agents, their versions, publishes and rollbacks, code deploys by key (`PUT /by-key/:key/apply`, idempotent by config hash, with `dryRun`), organization tool servers (shared keys stored encrypted and never returned) and the Console test workspace; `/v1/workspaces/:id/end-users/:externalUserId/tool-credentials/:toolServerKey` stores an end user's tool login write-only; `GET /v1/workspaces/:id/organization-agents` lists the published ones a workspace can use. New API key permissions `agents:read`, `agents:manage` and `tool_credentials:write` are held by full organization keys. Every write is in the Console audit log.
