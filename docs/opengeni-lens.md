# OpenGeni Lens

OpenGeni Lens is the built-in `opengeni-lens` Capability Pack for automated
pull-request review. The Pack owns the review Skill and product setup; it does
not introduce another agent runtime. An authenticated provider webhook creates
an ordinary OpenGeni session with one repository resource, an immutable expected
head commit, the `pr-review` Skill, and the registered provider credential.

Lens supports GitHub pull requests, GitLab merge requests, and Azure DevOps pull
requests through one normalized dispatch contract.

## Setup

1. Install the `opengeni-lens` Pack from **Capabilities**. Because it contains
   an inline Skill, use the normal Pack preview/install flow.
2. In the Lens setup card, register one provider credential and webhook secret.
3. Configure the provider webhook to use the OpenGeni API base URL plus the
   returned `webhookPath`.
4. Add only the repositories Lens may review. Provider repository, installation,
   and project IDs are authority, not display metadata.

Secret registration and rotation require workspace administration plus
`secrets:write`. Stored private keys, provider tokens, and webhook secrets are
encrypted with the deployment environment-encryption key. List responses expose
only presence and expiry metadata.

### GitHub

Create a dedicated GitHub App named **OpenGeni Lens**. Do not reuse the GitHub
App that OpenGeni may use for its ordinary workspace GitHub integration.

Repository permissions:

- Metadata: read-only
- Contents: read-only
- Pull requests: read and write

Subscribe to the **Pull request** event and set a strong webhook secret. Install
the App only on repositories Lens may review. Register the App ID, downloaded
private key, and webhook secret in OpenGeni, then bind an installation ID and
repository ID. OpenGeni validates the repository against that exact App and
canonicalizes the clone URL from GitHub's response. Each run mints a fresh
installation token restricted to the selected repository.

The initial adapter targets `github.com`; it does not claim GitHub Enterprise
Server support because the App API base and token-mint route differ there.

### GitLab

Create a project access token named **OpenGeni Lens** where possible; use a
group or personal access token only when project-token policy cannot meet the
deployment's needs. The current adapter needs the `api` scope to clone/read and
publish merge-request discussions. Register the token and its optional expiry.

Add a **Merge request events** project webhook, set the same secret token in
GitLab and OpenGeni, and bind the numeric project/repository ID. Self-managed
GitLab instances use their credential-free HTTPS base URL. Binding calls the
GitLab project API with the registered token and persists the canonical project
path and HTTPS clone URL returned by GitLab.

GitLab tokens are broader than GitHub's repository-scoped installation tokens.
Prefer a project token and restrict the bot user to the smallest project role
that can read code and create merge-request comments.

### Azure DevOps

Create a dedicated **OpenGeni Lens** identity and token with the Code read/write
scope (`vso.code_write`) limited to the intended organization/projects. The
bootstrap adapter accepts that provider token and an optional expiry. Use an
organization base URL such as `https://dev.azure.com/example`.

Create Web Hooks service-hook subscriptions for **Pull request created** and
**Pull request updated**. Configure Basic authentication with the same username
and secret registered in OpenGeni. Bind the repository GUID and project GUID;
OpenGeni verifies both through the Azure Repos API and persists its canonical
HTTPS clone URL.

Azure DevOps and GitLab token rotation is explicit through the registration
update API. Expired tokens fail closed before sandbox injection.

## Dispatch and stale-review safety

The webhook endpoint authenticates the exact raw body before parsing it. GitHub
uses HMAC-SHA-256, GitLab uses its shared webhook token, and Azure DevOps uses
Basic authentication. Bodies are bounded to 2 MiB.

Accepted events are normalized to provider, repository ID, pull-request ID,
base/head refs, and a 40-character head SHA. Drafts, unsupported actions,
disabled repositories, and authority mismatches are ignored. Bot-authored pull
requests remain reviewable; comment events are not review triggers. Delivery
IDs plus digests over the provider, bounded event identity, and exact request
bytes form a durable replay journal; reusing one provider delivery ID for a
different authenticated request is rejected. Session
creation has a second idempotency key over repository binding, PR, and head, so
different delivery events for the same head converge on one review session.

The repository clone verifies that `HEAD` equals the webhook's expected commit
before publishing the workspace. The review Skill requires another provider
head lookup immediately before commenting. If the head moved, Lens publishes
nothing. This second check is necessary because a review can run long after a
valid webhook was accepted.

Lens requires managed compute; a deployment whose default backend is
`selfhosted` cannot register or dispatch Lens because OpenGeni must never clone
onto a connected user's machine. Stock headless and desktop sandbox images ship
`gh`, a checksum-pinned `glab`, Azure CLI, and the Azure DevOps CLI extension.

Disabling the Pack, provider registration, or repository binding prevents new
dispatch. The API rechecks all three inside the session-create transaction.
Existing sessions remain ordinary auditable OpenGeni sessions and follow normal
pause, cancellation, usage, model-policy, and sandbox lifecycle rules.

## Runtime authority

- Pack state packages and activates the review behavior; it is not credential
  authority by itself.
- A provider registration owns encrypted webhook and Git credentials.
- A repository binding grants that registration to one exact provider resource.
- The session resource freezes the provider, credential binding, repository
  identity, ref, and expected commit.
- The worker requires the exact live root session, turn, and attempt created for
  the recorded delivery, then rechecks the active Pack, registration, binding,
  expected head, repository URI/ID, and provider installation/project identity
  before returning a credential. An ordinary workspace session cannot imitate a
  Lens credential-binding ID.
- Credentials are seeded off-manifest for Git and `gh`, `glab`, or `az`; they
  are never placed in prompts, session history, events, repository URLs, or
  sandbox manifests.

The Skill permits only review comments. It forbids pushes, merges, approvals,
closing, labels, and repository-settings changes. Provider-side least privilege
remains the final enforcement boundary; especially for GitLab and Azure DevOps,
use a dedicated identity and the narrowest practical token scope.

## API and implementation map

Configuration routes:

```text
GET    /v1/workspaces/:workspaceId/lens/registrations
POST   /v1/workspaces/:workspaceId/lens/registrations
PATCH  /v1/workspaces/:workspaceId/lens/registrations/:registrationId
DELETE /v1/workspaces/:workspaceId/lens/registrations/:registrationId
POST   /v1/workspaces/:workspaceId/lens/repositories
PATCH  /v1/workspaces/:workspaceId/lens/repositories/:bindingId
DELETE /v1/workspaces/:workspaceId/lens/repositories/:bindingId
POST   /v1/webhooks/lens/:accountId/:workspaceId/:registrationId
```

`DELETE` is an audit-preserving disable operation. The SDK exposes matching
`listLensConfiguration`, registration, and repository-binding methods.

- contracts and Pack constants: `packages/contracts/src/index.ts`
- Skill, webhook verification, and normalization: `packages/core/src/domain/lens.ts`
- durable authority and delivery journal: `packages/db/src/lens.ts`
- schema/migration: `packages/db/src/schema.ts`, `packages/db/drizzle/0279_opengeni_lens.sql`
- HTTP adapter and session dispatch: `apps/api/src/routes/lens.ts`
- standalone credential broker: `apps/worker/src/lens-credentials.ts`
- exact-head repository materialization: `packages/runtime/src/index.ts`
- setup UI: `apps/web/src/components/capabilities/lens-setup-card.tsx`
