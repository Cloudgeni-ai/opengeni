# GitHub App workspace bindings

OpenGeni uses a GitHub App for repository discovery and short-lived,
repository-scoped Git credentials. App server configuration and workspace
authority are separate facts: configured App credentials do not make a
workspace binding healthy.

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

## Owner-authority flow

Creating the App and binding an installation are distinct operations. A caller
with `github:manage` receives a signed, ten-minute browser handoff and first
authorizes the App as a GitHub user. OpenGeni discovers existing installations
visible to that user, but retains only exact personal-account ownership or live
active organization-owner membership. One retained installation advances
directly; several produce an owner-only chooser; none enters GitHub's new
installation UI. This order lets an existing installation connect without
depending on GitHub's Configure page to return OpenGeni state.

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

An existing binding exposes a workspace-scoped **Repositories** action. OpenGeni
mints fresh signed browser state before opening GitHub's installation settings.
The setup callback accepts that state from GitHub or the same-site browser
cookie, then repeats exact OAuth authority proof before updating the binding.
This keeps repository reconfiguration working even if GitHub omits `state` from
its update redirect.

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
