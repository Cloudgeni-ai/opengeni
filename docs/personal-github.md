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

The chooser's first control picks the mode: **Choose repositories** (the
allowlist above) or **All my repositories**, with **Read only** or **Read and
write**. **All my repositories** works like `gh` on the person's own
computer: any repository they can currently reach on GitHub is usable, and
the status reads `Connected as @login · All repos`. The explicit list is kept
while the mode is on, so switching back restores it. Write still needs push
(or higher) permission on GitHub and a repository that is not archived; with
**Read only**, every repository is read-only. Searching in the chooser and the
session repository picker also asks GitHub (`GET
/v1/workspaces/{id}/integrations/github/personal/repositories?query=`), so
results are not limited to the first 100 repositories.

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
Opengeni access to the org" map to the App. Its `personal.repositoryCount` is
the person's chosen list, and
`personal.allRepositories` (`{ enabled, access }`, null when unknown) reports
the All my repositories mode, so the agent knows any repository the person can
reach is usable up to that access without choosing it first. The mode reads as
off while `OPENGENI_GITHUB_PERSONAL_ALL_REPOSITORIES_ENABLED` is off. The
repositories prompt lists each
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

## All my repositories

The mode lives on the connection's selection head
(`all_repositories_access`: `read`, `write` or null). Turning it on or off,
or changing its access, advances the selection generation like any other
selection edit and records it in `all_repositories_generation`. Work accepted
under the mode keeps working while the mode is unchanged; work accepted before
the mode last changed stops, so turning it off and on again, or narrowing and
widening it, never revives earlier work.

Catalog items keep `selectedAccess` as the saved per-repository choice and add
`effectiveAccess`: the access usable now, which in this mode is the mode's
access lowered to GitHub's permission on the repository. Every check uses the shared
`personalGitHubRepositoryAuthority` and `checkPersonalGitHubRepositoryAccess`
in `@opengeni/core` (`packages/core/src/domain/personal-github-repository-access.ts`):

- Session admission freezes `allRepositoriesAccess` into the personal
  delegation. A chat may then mount any repository; write needs mode
  `write`. A chat started with no repositories still gets the
  `github_personal__*` tools when the mode is on.
- The git broker, token minting and the REST bridge accept a repository when
  the mode is still on, its access still covers the request, and GitHub's
  live repository answer grants it (cached for 60 seconds, by id and by
  name). A renamed repository's redirect to `/repositories/<id>` on
  `api.github.com` is followed once. Editing the explicit list does not
  interrupt running work; turning the mode off, narrowing it to read,
  reconnecting or disconnecting does.
- A repository a person removed from a chat (or from its parent chat) stays
  refused in that chat in this mode too, by the git broker and the REST
  bridge, until a person attaches it again.
- The [gh gateway](#gh-in-managed-sandboxes) uses the same decision for every
  repository a `gh` request names, after its removed-from-chat check; GitHub
  enforces the person's own permission on the request.

Rollout: releases older than this change reject a delegation with the mode or
without repositories. The mode is therefore offered only when
`OPENGENI_GITHUB_PERSONAL_ALL_REPOSITORIES_ENABLED` is on (status
`allRepositoriesAvailable`); turn it on once every API and worker runs this
release. While it is off, the replace route refuses to turn the mode on (409),
admission, branch listing, the catalog and the pickers ignore a stored mode;
the person can still keep or turn off a stored mode.

## Read tools

These `github_personal__*` tools work in chats without a sandbox, as the
person, through the same REST bridge and action policy (all are reads):

- `organizations_list`: the organizations whose repositories the person can
  reach. The connection has only the `repo` scope, which `/user/orgs` does not
  accept, so the list comes from the person's repositories; `complete` is
  false when the scan stopped early.
- `owner_repositories_list`: repositories of a user or organization, with
  `filter` (name search through GitHub search) and pagination.
- `workflow_runs_list`: Actions runs, filtered by workflow, branch, pull
  request (its head commit), head SHA, event and status.
- `workflow_run_get`: one run with its jobs and steps.
- `workflow_job_logs_get`: one job's log, the end by default or from
  `offset`, at most 256 KB per call (32 KB by default), returning
  `nextOffset` to page. GitHub answers with a redirect to a signed log URL;
  the bridge follows it only to an `https` URL and sends no token or GitHub
  headers there. It asks the storage for just the needed bytes with an HTTP
  range (the end for the default read) and falls back to reading the stream.

The account tools (`organizations_list`, `owner_repositories_list`) need the
connection only. The repository tools need the repository to be selected or
the mode to be on.

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

A session or scheduled task that an agent creates from its own turn
(`session_create`, `scheduled_tasks_create`, `scheduled_tasks_update`) may name
a personal repository with only `uri`, `ref` and
`connectionType: "github_personal"`. The server resolves the rest from the
calling turn's frozen Your GitHub delegation
(`resolveAgentPersonalGitHubRepositoryResources` in
`packages/core/src/domain/agent-personal-github-resources.ts`): the same owner,
connection and credential binding, the repository ID looked up as the person,
and access capped by `checkPersonalGitHubRepositoryAccess`, so the chosen list
and All my repositories mode both work. Without `access` it takes the most the
turn holds (write only when the same check allows write now). A partly
specified resource is completed the same way; a `credentialBindingId` or
`repositoryId` it carries must match the turn's binding and the repository, and
GitHub App fields are dropped. The GitHub lookup in All my repositories is the
calling attempt's own accepted use of the person's connection, fenced like the
Git broker; GitHub refusing the token asks the person to reconnect. A repository outside the delegation, more access than the turn
holds, a repository a person removed from the calling chat, or a turn without
Your GitHub access is refused with a message naming the cause. The child then
inherits the connection use through durable propagation; it never receives
another person's connection or more than the parent turn holds.

No Your GitHub use is limited to one message or one chat. A turn's personal
repositories always come from the person's lasting choice on the connection,
their chosen list or All my repositories (Your GitHub is not turned on per
workspace; D-54 covers other logins), and a chat's attachments only narrow
which of them it holds. So a schedule an agent saves can name only repositories
the creating turn held, and those were already usable as the person beyond that
turn. Each run re-resolves the owner's connection, chosen list and All my
repositories: disconnecting, removing the repository from the list or turning
All my repositories off stops later runs, and a run never falls back to the
workspace's GitHub app.

Repository owners follow GitHub's login rules, including enterprise managed
users, whose logins carry an underscore suffix (`octocat_acme`): 1 to 39
letters, digits, `-` or `_`, starting with a letter or digit
(`GITHUB_OWNER_LOGIN_PATTERN` in `packages/contracts/src/personal-github.ts`;
migration 1370 widens the stored selection check the same way).

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
replayed. A push that deletes or force-updates a branch other than the default
branch follows the person's policy; one that deletes or force-updates the
default branch or a tag follows their Settings and deletions policy (Ask unless they chose otherwise; see [Git pushes](#git-pushes)).
Ordinary pushes are unchanged.
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
in this mode. The static part of this (the proxy and the wrapper logic) is
one content-addressed file in the wrapper directory, delivered through the
same private file ingress as the broker bearer, so the per-turn setup program
stays small; if that delivery fails, `gh` behaves as before for that turn.

The gateway (`/v1/github/personal/gateway/{api,uploads,git}/...`) checks, for
every request: the bearer, its turn, the delegation's credential binding and
connection generation, the connection itself, the live repository allowlist,
and repositories removed from the chat. Repository requests outside the
allowlist are refused with a 403, and any write (including a comment or a
fork) needs the repository chosen with write access. Account and organization reads (`gh api
user`, `gh repo list <org>`) and search pass as the person. GraphQL
`repository(...)` reads are checked like REST ones, also under
`organization`, `user`, `repositoryOwner` and `viewer`; `node(id:)` reads are
not. GraphQL mutations are checked against the repositories their input names
(node IDs, `repositoryNameWithOwner`, github.com URLs). When those can't be
found, or a write names no repository (account and organization writes, or a
request the gateway can't read), the allowlist can't apply, so the request
asks whatever the person's policies say (Block still wins). This is decided
per mutation: one on an allowed repository doesn't vouch for an organization
or project write sent in the same request, only ID inputs (`subjectId`,
`repositoryId`, …) and repository fields (`repositoryNameWithOwner`,
`subIssueUrl`) count as its target, and an unrecognised mutation that also
touches a node outside any repository, or one GitHub won't show, asks too.
A request nested too deeply to read is treated as unrecognised, strings GitHub might read differently (escaped quotes, tabs, form feeds or carriage returns in a block string, unknown escapes) make it unrecognised, and a value under an ID input or repository field the gateway can't read as a node ID leaves the mutation unconfirmed. With All my
repositories at write access and no repository removed from the chat there is
no allowlist to step around, so the person's policies decide as usual. The gateway replaces
`Authorization` with the person's token, never forwards the bearer, does not
follow redirects, forwards only the request headers GitHub needs, buffers
API bodies up to 32 MiB (larger ones get 413), streams uploads and responses,
and passes only safe response headers back.

### Approvals

Each request is mapped to the GitHub action policy the `github_personal__*`
tools use, so one setting covers both:

- Reads pass.
- Ordinary writes (branches, file commits, issues, pull requests, comments,
  review requests, labels, releases, workflow runs and reruns) follow the
  person's policy for the matching action, or the strictest of the routine
  group when no single action matches. Reviews and merges follow their own
  groups.
- Deleting or force-updating a branch other than the repository's default
  branch (REST `git/refs`, also with the ref's slashes encoded as `gh` sends
  them, e.g. `git/refs/heads%2Fmy%2Fbranch`; GraphQL `deleteRef`, `updateRef`
  and `updateRefs`) follows the person's `Create and update work` policy, so
  agents can rebase their own pull request branches and delete merged ones
  (`gh pr merge --delete-branch`). The gateway reads
  the default branch with the person's token (REST `default_branch`, kept for
  a minute per connection and repository, so a just-changed default branch
  can take that long to apply; or the GraphQL Ref and Repository nodes, which
  must belong to a repository the request was checked against); when it
  can't confirm every ref is such a branch, the request is treated as a
  settings-and-deletions request (below).
- Destructive or hard-to-undo requests follow the person's `Settings and
  deletions` policy (`sensitive` in the API; policy action
  `github_sensitive_request`), together with the policy of any matching
  action, and the strictest decision applies: deleting or force-updating the
  default branch, deleting or force-moving tags, deleting repositories,
  releases, comments or other data; repository settings, collaborators and
  teams, secrets, variables and environments, webhooks and deploy keys,
  branch protection, transfer, archive and visibility, approving deployments
  or fork workflow runs. So do REST writes and GraphQL mutations the gateway
  doesn't recognise. The policy asks until the person chooses otherwise; a
  connection-wide Allow for every GitHub tool does not cover it, and a
  connection-wide Block covers it only while Settings and deletions has no
  choice of its own. Only Your GitHub has it: the workspace app has no `gh`
  gateway.
- Block always wins. Unattended sessions refuse instead of asking.

A request that needs approval is not sent. `gh` prints `Waiting for approval:
<title>…` (gateway messages don't name the product, like other agent texts),
the response carries `x-opengeni-approval: pending`, and the turn ends with
the normal approval card. The approval is
bound to a digest of the exact request (method, path, query and body bytes); after
approval, running the same command again sends it once. A secret write
(`PUT …/secrets/{name}`, as `gh secret set` sends) is bound to everything but
`encrypted_value` and `key_id`: `gh` seals the value with fresh randomness on
every run, so the retry differs only in ciphertext. The repository,
environment, secret name and any other fields (such as an organization
secret's visibility) still have to match, and the approval card shows the
value as `[sealed]`. A declined request
answers `Declined by the person`. Outcomes are recorded in the same connector
action ledger as tool calls: a 5xx or transport failure is outcome-unknown and
is not replayed.

### Git pushes

Pushes through the broker or the gateway are inspected before they reach
GitHub. A push that deletes a ref, or moves a branch to a commit that does
not descend from its current tip (a force push), is decided as one request:
when every such ref is a branch other than the repository's default branch
(the `default_branch` of the live repository check the broker makes on every
request), it follows the person's `Create and update work` policy; when one
is the default branch, a tag or another ref, or the default branch is
unknown, it also follows their `Settings and deletions` policy (Ask unless
they chose otherwise), as does a push the gateway can't read. An approval is
bound to the exact ref updates.
Git reports a waiting push as a rejected ref with the same message. Pushes
from shallow clones (how managed sandboxes clone) are read like any other.
When the gateway can't tell whether an update is a fast-forward, it treats it
as a force push; past the 64 MiB inspection limit it uses the commits it read
before the cut. A push it can't read at all asks.
Ordinary fast-forward pushes and new branches follow the existing write
access.

## Durable propagation

Durable propagation means accepted follow-up work, goal continuations, recovery,
and agent-created child sessions keep the already-approved personal identity
without asking the user to reconnect on every turn. It does not broaden access:
the child must request an exact subset of the parent's personal GitHub
repositories and may narrow write access to read, never widen read to write.
The ref is only the branch to check out, not authority, so a child may check
out another ref of a repository the parent holds.
`once` grants stop at their accepted work; `session` grants remain within the
same session; `always` grants may cross to causally linked child/goal work. The
frozen connection and selection generations travel with the work, and every
physical Git or API operation revalidates the live connection, grant, and
repository selection before use. Revocation, reconnect generation changes, or
repository removal therefore stop later calls even when an older task snapshot
still exists.
