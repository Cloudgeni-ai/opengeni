# HTTP API overview

OpenGeni's public contract is the workspace-scoped HTTP API served by
`apps/api`. Canonical protected routes include the workspace id in the URL, and
every request resolves to an internal access grant before route code touches
workspace-owned data. Most clients should use the typed
[`@opengeni/sdk`](../packages/sdk/README.md) rather than calling routes
directly; this page lists the main route families so the shape of the API is
easy to see. Authentication and access modes are described in
[`credentials.md`](credentials.md) and
[`deployment.md` § Security Boundary](deployment.md#security-boundary), and
the product-integration contract (organization API keys, organization
workspaces, external users) in [`product-integration.md`](product-integration.md).

## Core endpoints

- `GET /healthz`
- `GET /v1/config/client`
- `GET /v1/access/me`
- `GET /v1/organization-memberships` (managed-human self membership and personal-workspace identity)
- `POST /v1/organizations/additional` (managed-human creation of another isolated organization with its first shared workspace)
- bounded/keyset `GET /v1/organization-invitations` and exact subject-bound
  `POST /v1/organization-invitations/:id/accept`
- `GET|POST /v1/organizations/:id/invitations` for bounded admin listing and
  creation, plus explicit invitation revoke
- `GET /v1/organizations/:id/members` and revision-fenced member lifecycle `PATCH`
- `GET|PATCH /v1/organizations/:id/retention-policy`
- `GET /v1/workspaces`
- `POST /v1/workspaces`
- `POST /v1/workspaces/:workspaceId/sessions`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events/stream` (SSE; backfills from Postgres by event sequence)
- `POST /v1/workspaces/:workspaceId/sessions/:sessionId/events`

Session goals support `GET`, `PATCH`, and idempotent `DELETE` on
`/v1/workspaces/:workspaceId/sessions/:id/goal`; see [`goals.md`](goals.md).

Expired offboarded personal data and the organization-tenancy parity check are
explicit operator commands, not API routes; see
[`organization-tenancy.md`](organization-tenancy.md).

## GitHub endpoints

- `GET /v1/workspaces/:workspaceId/github/app`
- `GET /v1/workspaces/:workspaceId/github/connect`
- `GET /v1/workspaces/:workspaceId/github/repositories`
- `POST /v1/workspaces/:workspaceId/github/repositories/sync`
- `POST /v1/workspaces/:workspaceId/github/installations/select`
- `POST /v1/workspaces/:workspaceId/github/installations` (legacy, `410 Gone`)
- `DELETE /v1/workspaces/:workspaceId/github/installations/:installationId`
- `POST /v1/workspaces/:workspaceId/github/app-manifest`
- `GET /v1/github/app-manifest/callback`
- `GET /v1/github/setup`
- `GET /v1/github/oauth/callback`

See [`github-app.md`](github-app.md) for the authority contract.

## Document and Knowledge endpoints

- `GET /v1/workspaces/:workspaceId/document-bases`
- `POST /v1/workspaces/:workspaceId/document-bases`
- `GET /v1/workspaces/:workspaceId/document-bases/:baseId/documents`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/documents`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/search`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId/reindex`
- `POST /v1/workspaces/:workspaceId/knowledge/search`
- `GET /v1/workspaces/:workspaceId/knowledge/memories`
- `POST /v1/workspaces/:workspaceId/knowledge/memories`
- `GET /v1/workspaces/:workspaceId/knowledge/memories/:memoryId`
- `PATCH /v1/workspaces/:workspaceId/knowledge/memories/:memoryId`

See [`knowledge.md`](knowledge.md).

## Connected Machine endpoints

All return `404` unless `OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true`:

- `POST /v1/enrollments/device/start` (agent-side, unauthenticated)
- `POST /v1/enrollments/device/poll` (agent-side, unauthenticated)
- `POST /v1/enrollments/device/lookup`
- `POST /v1/enrollments/token/exchange` (agent-side headless enroll-token redemption)
- `POST /v1/workspaces/:workspaceId/enrollments/device/approve`
- `POST /v1/workspaces/:workspaceId/enrollments/device/deny`
- `POST /v1/workspaces/:workspaceId/enrollments/token` (mint a headless enroll token)
- `GET /v1/workspaces/:workspaceId/enrollments`
- `POST /v1/workspaces/:workspaceId/enrollments/:enrollmentId/revoke`

`POST /v1/workspaces/:workspaceId/sessions` (and the `session_create` MCP tool)
accept `targetSandboxId` (the enrolled machine to run on) and `workingDir` (the
per-session folder; only valid alongside `targetSandboxId`, and omitted means
the machine's default working root). See
[`connected-machines.md`](connected-machines.md).
