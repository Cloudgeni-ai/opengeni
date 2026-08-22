# Personal GitHub connections

Personal GitHub is a user-owned OAuth credential path for actions that must be
attributed to the exact GitHub user. It is deliberately separate from the
workspace-owned OpenGeni GitHub App described in [`github-app.md`](github-app.md).
The two clients, callbacks, stored authorities, and runtime identities must not
be substituted for one another.

## Current backend contract

The deployment must explicitly enable the feature and provide one dedicated
OAuth App client for that environment:

- `OPENGENI_GITHUB_PERSONAL_OAUTH_ENABLED=true`
- `OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_ID`
- `OPENGENI_GITHUB_PERSONAL_OAUTH_CLIENT_SECRET`
- `OPENGENI_INTEGRATIONS_ENABLED=true`
- `OPENGENI_INTEGRATIONS_STATE_SECRET`
- `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`
- `OPENGENI_PUBLIC_BASE_URL`, whose exact callback is
  `/v1/integrations/github-personal/oauth/callback`

The feature is disabled by default, is supported only in managed product mode,
and requires HTTPS outside local/test. Staging and production use different
OAuth Apps and client secrets. Device flow stays disabled. Creating those apps
and installing their secrets is an external operator action; repository code
does not create or mutate them.

The start route accepts only an exact authenticated human with
`connections:write`. It uses authorization code + PKCE S256 and signed,
single-use state bound to the OpenGeni organization, workspace, subject,
environment, client marker, return path, and optional reconnect generation.
The callback consumes the nonce before provider exchange, requires exactly the
V1 `repo` scope, verifies the immutable numeric GitHub user ID through
`GET /user`, rechecks live OpenGeni authority, and persists one encrypted
subject-owned `Connection`. A reconnect is CAS-fenced to the same Connection and
GitHub user. A different GitHub account never overwrites the existing row.

`repo` is broad GitHub-account authority: it includes public and private
repositories available to the user and permits repository writes. OpenGeni's
repository picker is an additional allowlist; it does not narrow the OAuth
grant held by GitHub. Runtime execution must therefore remain behind exact
selected-repository authority and the normal Ask/Allow/Block action policy.

Repository discovery is live and owner-only. The API uses only fixed
`api.github.com` endpoints, follows no redirects, bounds response bytes and
repository counts, derives canonical GitHub URLs from validated full names,
and persists only selected repository projections. It never persists the
private repository catalog. Repository IDs cross JSON as positive digit
strings and persist as Postgres `bigint`, so IDs larger than JavaScript's safe
integer range remain exact.

Each connection has a monotonic selection head and immutable per-row selection
generation. Full replacement and verification are fenced by both the current
connection authority generation and selection generation. Reconnect or
disconnect invalidates stale callers; a selection generation advances only
when repository identity or selected read/write authority changes. Verification
may refresh bounded repository facts without broadening selected access or
advancing that generation. Owner/account/workspace checks, FORCE RLS, lifecycle
functions, and idempotency receipts protect writes; the application role has no
direct table DML. The credential binding UUID is evidence only and never grants
repository authority.

## Token custody and lifecycle

Access tokens and optional rotating refresh tokens are encrypted in
`connections.credential_encrypted`; the OAuth App client secret remains only in
the current deployment secret configuration. Metadata and public API responses
contain no secret values. GitHub OAuth Apps may issue either a
long-lived access token or an expiring access token plus rotating refresh token,
so both shapes are accepted. Refresh omits the unsupported scope parameter,
retains the current scope when GitHub omits it, and uses the ordinary connection
broker's single-flight/CAS update and `needs_reauth` transition. Disconnect is
owner-only, generation-fenced, idempotent, and advances the existing connection
authority generation.

The lifecycle routes are:

- `GET /v1/workspaces/:workspaceId/connections/github`
- `POST /v1/workspaces/:workspaceId/connections/github/oauth/start`
- `POST /v1/workspaces/:workspaceId/connections/:connectionId/github/reconnect`
- `DELETE /v1/workspaces/:workspaceId/connections/:connectionId`
- `GET /v1/integrations/github-personal/oauth/callback`

The owner-only repository-authority routes are:

- `GET /v1/workspaces/:workspaceId/connections/:connectionId/github/repositories`
- `PUT /v1/workspaces/:workspaceId/connections/:connectionId/github/repositories`
- `POST /v1/workspaces/:workspaceId/connections/:connectionId/github/repositories/verify`

Generic Connection create/update rejects `github.com` OAuth credentials and
the reserved personal-GitHub metadata role. A human/API-created session,
follow-up, or scheduled-task definition that carries a personal GitHub
repository resource uses the explicit, non-colliding
`connectionType: "github_personal"` discriminator and must also carry one
explicit `github:personal` `connection.use` selection. Admission revalidates the same-organization target
grant and exact owner/connection/credential binding, verifies every requested
provider repository ID and read/write level against the current selected set,
and freezes the connection generation, selection generation, per-row
generation, canonical URI, ref, and access into the accepted turn or task.
Credential bindings remain selectors, never grants. Missing, stale, mixed-
account, or widened authority fails closed.

This phase still exposes no token to a sandbox, adds no Git transport, and
registers no GitHub API tools. Physical provider use must revalidate the frozen
snapshot immediately before broker access; that broker/runtime work and
agent-created inheritance, child/goal propagation, and recovery are separately
audited dependent phases. Agent-created personal GitHub use therefore fails
closed in this phase instead of silently dropping authority. Until a broker
consumer lands, selecting and freezing a repository grants no executable
runtime capability.
