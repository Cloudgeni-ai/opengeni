# Personal GitHub connections

Personal GitHub is a user-owned OAuth credential path for actions that must be
attributed to the exact GitHub user. It is deliberately separate from the
workspace-owned OpenGeni GitHub App described in [`github-app.md`](github-app.md).
The two clients, callbacks, stored authorities, and runtime identities must not
be substituted for one another.

## Setup

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

The feature is disabled by default and requires HTTPS outside local/test.
Managed staging and production use different OAuth Apps and client secrets so
their callbacks, consent screens, credentials, and revocation boundaries cannot
cross. Creating those apps and installing their secrets is an external operator
action; repository code does not create or mutate them.

Local and self-hosted installations use the same ordinary browser OAuth flow:

1. Create a GitHub OAuth App for that installation.
2. Set its callback to the browser-reachable API origin plus
   `/v1/integrations/github-personal/oauth/callback`. For a stock local run this
   can be `http://127.0.0.1:8000/v1/integrations/github-personal/oauth/callback`.
3. Configure the client ID, client secret, state-signing secret, and environment
   encryption key above, then restart OpenGeni.
4. Open **Integrations → GitHub → Your GitHub identity**, connect, and choose the
   repositories OpenGeni may use as that user.

Single-user `local` mode recognizes only its exact built-in `dev` human as the
credential owner and stores a standing grant for that same local workspace.
A self-hosted deployment with managed human sign-in uses the normal per-user
authority path. A shared configured/service key by itself is deliberately not a
personal identity; that deployment must provide verified delegated-human auth
or managed sign-in before personal OAuth can be enabled.

Device flow is unnecessary because OpenGeni already has a browser UI. OAuth
authorization code + PKCE keeps the same flow usable in managed, self-hosted,
and local environments without teaching agents or containers the user's GitHub
password or provider token.

When the Docker sandbox backend is used, set `OPENGENI_MCP_URL` to an API URL
reachable from sandbox containers. A Compose service URL such as
`http://api:8000/v1/workspaces/{workspaceId}/mcp` is accepted; a loopback URL is
translated to the Docker host gateway for stock local runs. The broker remains
the only recipient of the short-lived OpenGeni bearer.

## User experience

GitHub remains one integration tile. The workspace GitHub App is the bot
identity used for workspace-owned automation; **Your GitHub identity** is the
personal connection used when an action must appear as the signed-in user. The
personal dialog contains only sign-in status, a searchable repository allowlist,
read/write choice, reconnect, and disconnect.

The session repository picker labels personal choices with `@login` and
**As you**. Choosing one both selects the exact repository and grants this
workspace reusable access to the connection for that user; the OAuth token is
not copied into the session. A repository already mounted through one identity
cannot also be mounted through the other at the same path. Existing-session
pickers keep mounted choices visible and locked.

## Authority contract

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

Managed sandboxes consume this authority through OpenGeni's dedicated personal
GitHub smart-HTTP broker. The worker mints a five-minute encrypted bearer bound
to the exact account, workspace, session/root, turn, active attempt and
execution generation, connection generation, credential binding, repository
selection generation, and owner. The bearer contains no repository names,
URLs, or provider credential. Each stable, credential-free broker route is
separately HMAC-bound to one repository snapshot and remains unchanged when the
bearer renews. Git persists the canonical `https://github.com/<owner>/<repo>`
remote; runtime `insteadOf` configuration redirects only the physical smart-Git
request to the broker. Initial delivery and renewal stage the bearer through a
private sandbox editor/file ingress; the token-free lifecycle command only
atomically moves those bytes into the stable binding file, so the bearer never
enters command text or process arguments.

The broker permits only smart-HTTP discovery, upload-pack, and receive-pack.
Before every upstream request it revalidates the exact accepted attempt,
connection/grant generations, current repository selection, live GitHub user
identity, repository identity, and pull/push permission. Provider OAuth tokens
are decrypted only at that server boundary. Requests use fixed GitHub hosts,
no redirects, bounded deadlines, stripped ambient headers, and streaming bodies.
A receive-pack transport failure is outcome-unknown and is never automatically
replayed. `gh` and other provider CLIs never receive the broker bearer and direct
the agent to GitHub tools instead. The standalone consumer remains default-off
with personal GitHub OAuth; GitHub App and Connected Machine credential paths
are unchanged.

The default-off GitHub API bridge (`OPENGENI_GITHUB_REST_MCP_ENABLED`) consumes
that same frozen repository authority without exposing the broad OAuth token.
It revalidates the exact accepted connection/grant generation, selection head,
repository identity, and current read/write permission before each provider
request. `github_personal__*` tools are always attributed to the connected user;
the separate `github_app__*` namespace acts as the OpenGeni bot. Tool arguments
cannot choose either actor or a repository outside the accepted resource set.
Writes use the attempt-frozen connector Allow/Ask/Block policy, default to Ask
when no explicit policy exists, and are never replayed after an ambiguous
outcome. The reviewed surface covers repository, branch, ref, file, issue,
pull-request, review, check, and code-search reads plus ref creation, issue
creation/update/comment, pull-request creation/update/comment/reviewer request,
review submission (`COMMENT`, `APPROVE`, or `REQUEST_CHANGES`), and merge
(`merge`, `squash`, or `rebase`). Merge is marked destructive and all writes
remain subject to the configured confirmation policy.

## Durable propagation

Durable propagation means accepted follow-up work, goal continuations, recovery,
and agent-created child sessions keep the already-approved personal identity
without asking the user to reconnect on every turn. It does not broaden access:
the child must request an exact subset of the parent's personal GitHub
repositories and may narrow write access to read, never widen read to write.
`once` grants stop at their accepted work; `session` grants remain within the
same session; `always` grants may cross to causally linked child/goal work. The
frozen connection and selection generations travel with the work, and every
physical Git or API operation revalidates the live connection, grant, and
repository selection before use. Revocation, reconnect generation changes, or
repository removal therefore stop later calls even when an older task snapshot
still exists.
