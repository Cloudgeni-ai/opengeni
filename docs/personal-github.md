# Personal GitHub connections

Personal GitHub is a user-owned OAuth credential path for actions that must be
attributed to the exact GitHub user. It is deliberately separate from the
workspace-owned Opengeni GitHub App described in [`github-app.md`](github-app.md).
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
   encryption key above, then restart Opengeni.
4. Open **Integrations → GitHub → Your GitHub**, select **Connect**, and choose
   the repositories Opengeni may use as that user. The repository chooser opens
   by itself when GitHub returns.

Single-user `local` mode recognizes only its exact built-in `dev` human as the
credential owner and stores a standing grant for that same local workspace.
A self-hosted deployment with managed human sign-in uses the normal per-user
authority path. A shared configured/service key by itself is deliberately not a
personal identity; that deployment must provide verified delegated-human auth
or managed sign-in before personal OAuth can be enabled.

Device flow is unnecessary because Opengeni already has a browser UI. OAuth
authorization code + PKCE keeps the same flow usable in managed, self-hosted,
and local environments without teaching agents or containers the user's GitHub
password or provider token.

When the Docker sandbox backend is used, set `OPENGENI_MCP_URL` to an API URL
reachable from sandbox containers. `bun run dev` does this on Linux Docker
Engine with its Docker sandbox route (see
[local-development.md](local-development.md#start-the-full-stack)), and Docker
Desktop reaches the API through `host.docker.internal`. A Compose service URL
such as `http://api:8000/v1/workspaces/{workspaceId}/mcp` is accepted; a
loopback URL is translated to the Docker host gateway, which works only when
the API listens there. The broker remains the only recipient of the short-lived
Opengeni bearer.

## User experience

GitHub remains one integration tile. With personal OAuth enabled, its sheet has
two named sections, each with one action:

- **Your GitHub** ("Work appears under your name. Only in chats you start, on
  repos you choose."): **Connect** (or **Reconnect**), then **Choose repos**,
  with the status `Connected as @login · N repos`. Commits, branches, pull
  requests and reviews appear as the signed-in user.
- **Opengeni app** ("Work appears as the Opengeni bot, shared with the
  workspace."): **Install app**, **Install on another account** or **Repair**,
  installed per organization or account. Its shared repositories are listed as
  **Opengeni app repositories**; the sheet header keeps only **Disconnect
  Opengeni app**. With several installations, each has its own row with
  **Change repositories** and **Unlink** (confirmed first).

Without `connections:write` or `github:manage`, the matching section shows a
short note instead of its action. After a successful personal connect started
from the sheet, the repository chooser opens directly. The chooser contains
only sign-in status, a searchable repository allowlist, read/write choice,
reconnect, and disconnect. Without personal OAuth, the sheet keeps the single
Opengeni app layout.

`/workspaces/<workspaceId>/plugins?open=integration%3Agithub&github=personal`
opens the sheet on **Your GitHub**: the repository chooser when connected,
otherwise the focused **Connect** action (it does not start the OAuth redirect
by itself). The agent hands this link to the person for "connect my GitHub".

The agent knows both identities. `github_connect_link` returns a `personal`
field next to the App fields (see [GitHub App](github-app.md#status-contract)),
and `capability_catalog_search` offers `api:github-personal` (**Your GitHub**)
next to `api:github-app`. Its in-chat card connects the person's account and
then links to the repository chooser. Requests such as "connect my GitHub" or
"do it as me" map to the personal identity; "install the GitHub app" or "give
Opengeni access to the org" map to the App. The repositories prompt lists each
mounted GitHub repository's identity (as the person, with their login when
known, or as the workspace's GitHub app). In a managed sandbox it says that git and `gh`
act as the person on personal repositories, through the
[gh gateway](#gh-in-managed-sandboxes); elsewhere (Connected Machines) the
agent uses plain git and the `github_personal__*` tools.

The session repository picker is for picking. With your GitHub connected, each
switched-on repository says who it acts as: **Acts as You (@login)** or **Acts as
Opengeni app**, as a choice when both can reach it. Without your GitHub there is
one identity and the picker does not mention it. Account management lives on
the GitHub settings page above, behind one **Manage GitHub access** row; with
nothing connected and nothing to pick, the picker offers **Your GitHub**
(**Connect**) and **Opengeni app** (**Install**) with the same one-line
descriptions. The list has no Refresh button: it updates in the background when
the picker opens (at most once every 30 seconds) and as soon as you come back
from GitHub or the GitHub settings page; a failed load offers **Try again**.
Choosing a personal repository both selects the exact repository
and grants this workspace reusable access to the connection for that user; the
OAuth token is not copied into the session. A repository already mounted
through one identity cannot also be mounted through the other at the same path.
Existing-session pickers keep repositories already in the chat visible as
**In chat**: people who may change the chat can switch them off, and a new
chat changes their branch.

## Authority contract

The start route accepts only an exact authenticated human with
`connections:write`. It uses authorization code + PKCE S256 and signed,
single-use state bound to the Opengeni organization, workspace, subject,
environment, client marker, return path, and optional reconnect generation.
The callback consumes the nonce before provider exchange, requires exactly the
V1 `repo` scope, verifies the immutable numeric GitHub user ID through
`GET /user`, rechecks live Opengeni authority, and persists one encrypted
subject-owned `Connection`. A reconnect is CAS-fenced to the same Connection and
GitHub user. A different GitHub account never overwrites the existing row.

`repo` is broad GitHub-account authority: it includes public and private
repositories available to the user and permits repository writes. Opengeni's
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

Managed sandboxes consume this authority through Opengeni's dedicated personal
GitHub smart-HTTP broker. The worker mints a five-minute encrypted bearer bound
to the exact account, workspace, session/root, turn, active attempt and
execution generation, connection generation, credential binding, repository
selection generation, and owner. The bearer contains no repository names,
URLs, or provider credential. Each stable, credential-free broker route is
separately HMAC-bound to one repository snapshot and remains unchanged when the
bearer renews. Git persists the canonical `https://github.com/<owner>/<repo>`
remote; runtime `insteadOf` configuration redirects only the physical smart-Git
request to the broker, for both the `<repo>` and `<repo>.git` spellings. Because
Git matches `insteadOf` by prefix, the runtime also installs longer identity
rules for every character that can continue a brokered URL other than `/`, so
a repository whose URL only starts with the brokered one (for example
`<repo>-demos`) is never sent to the broker. Initial delivery and renewal stage
the bearer through a private sandbox editor/file ingress; the token-free
lifecycle command only atomically moves those bytes into the stable binding
file, so the bearer never enters command text or process arguments.

The broker permits only smart-HTTP discovery, upload-pack, and receive-pack.
Before every upstream request it revalidates the exact accepted attempt,
connection/grant generations, current repository selection, live GitHub user
identity, repository identity, and pull/push permission. Provider OAuth tokens
are decrypted only at that server boundary. Requests use fixed GitHub hosts,
no redirects, bounded deadlines, stripped ambient headers, and streaming bodies.
A receive-pack transport failure is outcome-unknown and is never automatically
replayed. A push that deletes a branch or tag, or force-updates one, asks the
person first (see [Git pushes](#git-pushes)); ordinary pushes are unchanged.
The standalone consumer remains default-off with personal GitHub OAuth; GitHub
App and Connected Machine credential paths are unchanged.

The default-off GitHub API bridge (`OPENGENI_GITHUB_REST_MCP_ENABLED`) consumes
that same frozen repository authority without exposing the broad OAuth token.
It revalidates the exact accepted connection/grant generation, selection head,
repository identity, and current read/write permission before each provider
request. `github_personal__*` tools are always attributed to the connected user;
the separate `github_app__*` namespace acts as the Opengeni bot. Tool arguments
cannot choose either actor or a repository outside the accepted resource set.
A turn that carries no personal GitHub delegation leaves the
`github_personal__*` tools out instead of failing; any turn other than
compaction logs a warning to worker telemetry (no visible chat warning yet),
and a compaction whose accounts could not be resolved logs its own warning.
A compaction checkpoint normally carries the person's current delegation, like
the turn it compacts after, and goes without it when that turn could not lend
it or its accounts could not be resolved (see `docs/context-compaction.md`). A goal continuation with no earlier
turn to copy from also goes without. A delegation that only partly matches, or
more than one, still fails closed.
Writes use the attempt-frozen connector Allow/Ask/Block policy. When no explicit
policy exists, the accepted repository write capability is authoritative and
the action proceeds without manufacturing an approval requirement. Mutations
are never replayed after an ambiguous outcome. The reviewed surface covers
repository, branch, ref, file, issue, pull-request, review, check, and code-search
reads plus ref creation, issue creation/update/comment, pull-request
creation/update/comment/reviewer request, review submission (`COMMENT`, `APPROVE`,
or `REQUEST_CHANGES`), and merge (`merge`, `squash`, or `rebase`). Merge is marked
destructive and all writes remain subject to the configured confirmation policy.

The GitHub integration sheet exposes that policy per acting identity in three
independent groups: routine creation/update work, review submission, and merge.
Routine work includes branch, issue, pull-request, comment, and reviewer-request
writes. Choosing Allow there does not broaden review or merge. Explicit policy rows retain their configured decision. Missing rows inherit
accepted repository write capability and project as Allow, matching execution;
this does not grant missing repository access. A pre-existing per-tool split projects
as Mixed until the user chooses one group decision. The API surface is
`GET`/`PATCH /v1/workspaces/:workspaceId/github/action-policies`; workspace App
changes require `github:manage`, while a Personal policy requires the exact
authenticated connection owner with `connections:write`. Updates are effective
for the next attempt snapshot. An approval request that is already open keeps
its original decision.

## gh in managed sandboxes

In a managed sandbox whose session mounts a repository as the person, `gh`
acts as the person, as on their own computer: `gh repo list/view/clone`,
`gh pr create/view/checks/diff/review/comment/merge`, `gh run list/view
--log/rerun`, `gh workflow run`, `gh issue`, `gh release` and `gh api`. The
person's token stays in Opengeni; the sandbox holds only the session's
short-lived broker bearer, which `gh` never sees either.

The sandbox `gh` wrapper chooses the gateway when the repository it runs in is
mounted as the person, or when it runs outside any GitHub checkout. In an
Opengeni app repository, and in sessions without a repository mounted as the
person, `gh` behaves as before. In gateway mode the wrapper starts a small
local proxy for that one command and points `gh` at it with a private,
temporary config (`http_unix_socket`). The proxy sends `api.github.com` and
`uploads.github.com` requests to the API's gateway with the bearer read fresh
from the binding file; requests to other hosts (for example redirects to
download logs or archives) go direct, without credentials. Because the
checkout's remote stays `https://github.com/<owner>/<repo>`, `gh` resolves the
repository as usual. `gh repo clone` and the Git commands `gh` runs clone and
push through the same gateway (`git/<owner>/<repo>`), so a clone keeps working
with plain git afterwards. The person's own `gh` config (aliases) is not used
in this mode.

The gateway (`/v1/github/personal/gateway/{api,uploads,git}/...`) checks, for
every request: the bearer, its turn, the delegation's credential binding and
connection generation, the connection itself, the live repository allowlist,
and repositories removed from the chat. Repository requests outside the
allowlist are refused with a 403. Account and organization reads (`gh api
user`, `gh repo list <org>`), search and GraphQL reads pass as the person.
GraphQL mutations are checked against the repositories of the node IDs they
name; when those can't be resolved, the request asks. The gateway replaces
`Authorization` with the person's token, never forwards the bearer, does not
follow redirects, buffers API bodies up to 32 MiB (larger ones get 413),
streams uploads and responses, and passes only safe response headers back.

### Approvals

Each request is mapped to the GitHub action policy the `github_personal__*`
tools use, so one setting covers both:

- Reads pass.
- Ordinary writes (branches, file commits, issues, pull requests, comments,
  review requests, labels, releases, workflow runs and reruns) follow the
  person's policy for the matching action, or the strictest of the routine
  group when no single action matches. Reviews and merges follow their own
  groups.
- Destructive or hard-to-undo requests always ask: deleting repositories,
  branches, tags, releases, comments or other data; force-updating a branch;
  repository settings, collaborators and teams, secrets and variables,
  webhooks and deploy keys, branch protection, transfer, archive and
  visibility. So do REST writes and GraphQL mutations the gateway doesn't
  recognise.
- Block always wins. Unattended sessions refuse instead of asking.

A request that needs approval is not sent. `gh` prints `Waiting for your
approval in Opengeni: <title>…`, the response carries `x-opengeni-approval:
pending`, and the turn ends with the normal approval card. The approval is
bound to a digest of the exact request (method, path, query and body); after
approval, running the same command again sends it once. A declined request
answers `Declined in Opengeni`. Outcomes are recorded in the same connector
action ledger as tool calls: a 5xx or transport failure is outcome-unknown and
is not replayed.

### Git pushes

Pushes through the broker or the gateway are inspected before they reach
GitHub. A push that deletes a branch or tag, or moves a branch to a commit
that does not descend from its current tip, asks the person; the approval is
bound to the exact ref updates. Git reports a waiting push as a rejected ref
with the same message. When the gateway can't tell whether an update is a
fast-forward (for example a push over 64 MiB), it asks.
Ordinary fast-forward pushes and new branches follow the existing write
access.

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
