# GitHub App workspace bindings

OpenGeni uses a GitHub App for repository discovery and short-lived,
repository-scoped Git credentials. App server configuration and workspace
authority are separate facts: configured App credentials do not make a
workspace binding healthy.

This workspace-owned bot/install path is independent from the exact-user
personal OAuth path in [`personal-github.md`](personal-github.md). The personal
path uses a separate per-environment OAuth App, callback, encrypted Connection,
and GitHub user identity. Neither credential may satisfy the other's authority
checks.

PR Review likewise uses a separately registered, workspace-owned
provider app. It never inherits this platform App or a personal GitHub
connection. See [`pr-review.md`](pr-review.md).

## Status contract

`GET /v1/workspaces/:workspaceId/github/app` and the
`github_connect_link` MCP tool report one of:

- `disabled`: the server is missing required GitHub App credentials.
- `unbound`: the App is configured, but the workspace has no audited binding
  whose installation is currently verified active by GitHub.
- `bound`: at least one audited workspace binding is currently active.

Stored rows remain visible for audit and unlink with lifecycle `active`,
`suspended`, `deleted`, or `unverified`. Only `active` rows can enumerate
repositories. Provider failure, malformed provider identity, or a legacy row
without an authority receipt is `unverified`, never healthy.

Chat setup uses the provider-neutral capability discovery and human authorization
card flow described in [MCP surfaces](mcp-surfaces.md). `github_connect_link`
remains a status/manager-link tool; reading status never posts a setup card.

## Owner-authority flow

Creating the App and binding an installation are distinct operations. A caller
with `github:manage` receives a signed, ten-minute browser handoff and first
authorizes the App as a GitHub user. OpenGeni discovers existing installations
visible to that user, but retains only exact personal-account ownership or live
active organization-owner membership. Any retained installation produces an
owner-only chooser that also offers installing the App on another account; none
enters GitHub's new installation UI directly. This lets an existing installation
connect without preventing the owner from adding a different personal account or
organization, and does not depend on GitHub's Configure page to return OpenGeni
state.

In the native Connect dialog, **Continue** on an account selection opens the
next authorization stage directly in an isolated popup. A new installation's
callback redirects that same popup to the committed owner-authorization stage;
it does not require another **Authorize connection** click. The original dialog
polls the durable attempt and refreshes repository state only after completion.
Blocked popups leave the selection uncommitted so the user can retry.

The selected installation then receives a second, exact fresh GitHub user
authorization immediately before binding. The second pass is deliberate: no
GitHub user token is persisted between discovery and selection, and authority is
revalidated near the durable commit. For a new installation, `install` and
`update` advance to this exact authorization. `setup_action=request` is only a
pending organization-policy request and never creates a binding. The exact
callback verifies:

1. the exact authenticated GitHub user, live App installation, installation
   account, suspension state, and current installation repositories;
2. one of the provider-supported authority cases below; organization ownership
   is queried again after repository enumeration, immediately before the proof
   is handed to the durable bind, and any revocation or unavailable recheck
   fails closed; and
3. the exact OpenGeni account, workspace, managing subject, signed-state nonce,
   installation ID, immutable GitHub account ID, GitHub actor ID, and explicit
   repository IDs committed by one transaction.

The transaction accepts proof for at most ten minutes, checks the database clock
before and after all writes, and consumes the nonce globally once. Replays,
cross-workspace nonce reuse, and concurrent duplicate commits fail closed. One
GitHub installation may be deliberately bound to multiple OpenGeni workspaces,
but every workspace requires an independent owner proof and owns an independent
repository allowlist.

The proof expiry bounds the consent transaction; it is not an automatic expiry
of the resulting delegation. After a successful owner consent, the binding is a
durable workspace delegation until unlinked. A later human role change does not
silently rewrite that delegation. GitHub installation suspension, deletion, or
repository removal remains effective immediately through live listing and
installation-token APIs.

An existing binding exposes a workspace-scoped **Change repositories** action
that opens a new tab and preserves the current chat. The workspace refreshes
GitHub status when the original tab regains focus. OpenGeni
mints fresh signed browser state before opening GitHub's installation settings.
The setup callback accepts that state from GitHub or the same-site browser
cookie, then repeats exact OAuth authority proof before updating the binding.
This keeps repository reconfiguration working even if GitHub omits `state` from
its update redirect.

### Links are minted on click

The `installUrl`, `linkUrl`, and per-installation `configureUrl` values in the
status response carry that ten-minute signed state, so a copy captured when a
page loaded goes stale. The new-session and follow-up repository pickers treat
`installUrl` only as "this principal may connect": **Connect workspace App**
opens the same native Connect dialog as the Plugins page GitHub card, which
starts a durable attempt and mints the authorization link at that moment, and
**Repositories** fetches a fresh `configureUrl` before navigating. The dialog
host lives outside the repository menu, because the menu closes when the
authorization popup takes focus.

The browser-navigation routes (`/github/connect`, `/github/setup`,
`/github/install/callback`, `/github/oauth/callback`,
`/github/installations/select`, installation `configure`, and the manifest
callback) answer failures with a readable page and a **Back to OpenGeni** link to
the workspace Plugins page, never a JSON body. The HTTP status is the one the API
error handler gives that failure. An expired or reused link, GitHub's **Cancel**
(`error=access_denied`), a non-owner's authority denial, a missing permission, an
organization integration policy that does not allow GitHub (403), and a
signed-out browser each get their own explanation. Any other failure, including
an unexpected server fault, shows a generic page without internal detail. The
native Connect callback also renders the expired page when its state is stale or
unreadable.

## Supported authority matrix

| GitHub case | Self-service binding | Evidence / result |
| --- | --- | --- |
| Personal-account installation owner | Supported | Fresh authorized user ID must equal the installation account ID. |
| Active organization owner | Supported when GitHub exposes it | The authenticated membership endpoint must return the exact organization ID, `state=active`, and `role=admin`. The App requests **Members: read**; existing installations must approve that permission. |
| Organization policy requires approval | Pending only | `setup_action=request` produces truthful pending UX and no binding. Retry after an owner approves and GitHub returns `install` or `update`. |
| Non-owner repository administrator | Denied | Repository `admin` or `maintain` permission is not installation/configuration authority. |
| Ordinary collaborator | Denied | Repository visibility and collaboration do not confer installation authority. |
| GitHub App Manager without organization ownership | Unsupported / denied | GitHub exposes no equivalent current-authority receipt accepted by this flow. |
| Membership hidden by policy, missing permission, or provider API failure | Unsupported / unverified | OpenGeni cannot prove ownership and fails closed. |
| Pending or stale organization membership | Denied | Membership must be active at authorization time. |
| Suspended or deleted installation | Denied / unbound | It cannot be newly bound, enumerate repositories, or mint a usable token. |

OpenGeni never infers installation or configuration authority from
`GET /user/installations`, setup callback IDs, App Manager metadata, repository
permission bits, or repository administration. A human-managed token injected
into an agent sandbox is also not a product binding mechanism.

The App uses one GitHub registration with two credential paths:

- App ID + private key mint short-lived installation tokens for repository work.
- Client ID + client secret perform human OAuth for identity and ownership proof.

An installation is an instance of that same App on a personal account or
organization. It is not a second App and has no second private key.

## Repository and token scope

Audited bindings always use `repository_scope='selected'` and persist a nonempty
set of GitHub repository IDs. Repository listing intersects live provider output
with that exact workspace allowlist. Session admission and every direct or
brokered token-mint boundary recheck the current workspace allowlist. The
exported GitHub installation-token mint refuses empty, duplicate, invalid, or
omitted repository ID lists and sends the explicit allowlist to GitHub.

Rows created before owner-authority receipts remain visible as `unverified` so
operators can unlink them, but they cannot enumerate repositories, authorize a
session resource, or mint an installation token. The legacy PR #518 chooser
endpoint remains `410 Gone`; it is not an alternate binding path.

### Bound repositories receive a scoped token, public or private

Repository visibility is not the credential decision; the workspace allowlist
is. Every repository in a bound installation's allowlist receives a short-lived
installation token scoped to exactly that repository, whether the repository is
public or private, so the sandbox can push and use `gh` against it. A
repository that is not in any of the workspace's allowlists (for example a
public upstream project) is cloned anonymously and is read-only: no token is
minted for it.

The web composer and the first-party `github_repositories_list` MCP tool stamp
`githubInstallationId`/`githubRepositoryId` on every allowlisted selection. For
a bare `https://github.com/<owner>/<repo>` resource that reached a session
without those ids (an API caller, a session created before bound public
repositories carried ids, or an agent-spawned child inheriting its parent's
resources), the turn worker resolves the binding before minting: the owner
login selects the workspace's auditable installation(s) from Postgres, one
server-side metadata-read (a `permissions: { metadata: read }` installation
token that never reaches the sandbox, bounded to 10 seconds) supplies GitHub's
repository id, and the resource is stamped for that turn only when exactly one
allowlist holds that id. The allowlist, `github_installation_repositories`,
stores repository ids rather than names, so this resolution cannot be completed
from Postgres alone and is therefore performed where OpenGeni already talks to
GitHub rather than at session create. Results (positive and negative) are
memoized per worker process for ten minutes keyed by workspace, installation,
and `owner/name`, so recovered attempts and sibling children do not re-read
GitHub; failures are not memoized. A bound owner whose allowlist does not hold
the repository, an ambiguous match across two bindings, or a suspended/deleted
installation leaves the resource bare and posts a visible
`credential.auth_needed` warning for `github.com` once per session and URI
within that window; resolution never fails the turn or the session, and a
GitHub outage proceeds bare after the bound timeout.

Connected Machines do not receive OpenGeni GitHub App credentials and continue
to use their machine's ambient Git authentication.

## Operational notes

- Set `OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET` explicitly for multi-instance
  deployments; a random per-process secret cannot survive callback routing.
- GitHub Enterprise hosts are not supported; provider URLs currently target
  github.com and api.github.com.
- The generated App does not register webhooks. Live installation and repository
  reads plus short-lived installation tokens enforce provider state.
- A manifest with a setup URL sets `request_oauth_on_install=false`; GitHub does
  not support requesting OAuth-on-install together with a setup URL.
- Managed deployments expose only install/connect UI and keep App registration
  identifiers and operator manifest creation server-side. Configured/local
  deployments retain the operator setup flow.
- Workspace unlink deletes only that OpenGeni binding. It does not uninstall the
  App from GitHub or change another workspace's independent binding.

## Operator setup

The GitHub App integration is optional, but it is the recommended way to give
agents scoped repository access. It lets the UI list installed repositories and
lets the worker mint short-lived installation tokens only for repositories
selected for a session. Each workspace binding owns an independent repository
allowlist and can be unlinked without uninstalling the App from GitHub.

From the web app (configured/local deployments):

1. Open the repository picker in the composer.
2. Expand **GitHub App**.
3. Optionally enter an organization login if the app should be created under an organization instead of your personal account.
4. Click **Create app**. The web app submits a GitHub App manifest to GitHub, and GitHub opens a prefilled app form.
5. Create the app in GitHub. The callback page prints `OPENGENI_GITHUB_APP_*` lines and includes a copy button.
6. Copy those lines into `.env`.
7. Restart the API and worker, or restart everything with `bun run dev`.
8. Reopen the repository picker and click **Connect GitHub**. Complete GitHub's installation/configuration screen and fresh user authorization as the personal-account owner or an active organization owner.

OpenGeni reports App server configuration and workspace binding separately as
`disabled`, `unbound`, or `bound` (see [Status contract](#status-contract)). It
binds only after fresh GitHub authorization proves exact personal ownership or
active organization ownership and then atomically stores the OpenGeni
account/workspace/subject, GitHub actor/account/installation, one-time proof,
and explicit repository IDs. An organization approval request remains pending
and unbound.

For local development, the manifest callback can use the API origin from the
running request. If you run behind a tunnel or deployed URL, set:

```bash
OPENGENI_GITHUB_APP_MANIFEST_BASE_URL=https://YOUR_DOMAIN
OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET=change-me
```

The generated App configures `<baseUrl>/v1/github/oauth/callback` and requests
**Members: read** so GitHub can expose active organization-owner membership.
Existing organization installations must approve the added permission before
organization-owner self-service can succeed; unavailable proof fails closed.

Existing database rows created without an owner-authority receipt remain
visible for audit/unlink as `unverified`, but they cannot enumerate
repositories, authorize session resources, or mint installation tokens. Session
creation, repository listing, and GitHub-authenticated worker turn startup
recheck the workspace binding, so unlinking or narrowing it revokes queued and
scheduled use before a new token is minted. Installation tokens remain
host-owned run material: the worker writes and renews them through the sandbox
credential-file boundary, and no model-visible MCP/API/SDK tool returns one.

The generated GitHub URL is only the manifest form target. Opening or copying
that URL by itself only sends `state`, so GitHub shows an empty app form instead
of the prefilled manifest.
