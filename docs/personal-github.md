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
repositories available to the user and permits repository writes. The product
repository picker introduced by the dependent repository-authority phase is an
additional OpenGeni allowlist; it does not narrow the OAuth grant held by
GitHub. Runtime execution must therefore remain behind exact selected-repository
authority and the normal Ask/Allow/Block action policy.

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

Generic Connection create/update rejects `github.com` OAuth credentials and
the reserved personal-GitHub metadata role. The current phase does not enumerate
or select repositories, expose the token to a sandbox, add Git transport, or
register GitHub API tools; those are dependent authority/broker phases.
