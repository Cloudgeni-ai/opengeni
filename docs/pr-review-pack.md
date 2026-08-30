# OpenGeni Review Bot

OpenGeni Review Bot is the built-in `pr-review` Capability Pack. It adds a
provider-neutral pull-request adapter, a reviewed `pr-review` Skill, and setup
for narrowly scoped provider credentials. It does not add another execution
engine: authenticated provider deliveries enter the generic automation
substrate and accepted runs create ordinary OpenGeni sessions.

The initial adapter supports GitHub pull requests, GitLab merge requests, and
Azure DevOps pull requests through one normalized event contract.

## Setup

1. Install the `pr-review` Pack from **Capabilities** through the normal Pack
   preview/install flow.
2. For GitHub, choose **Install on GitHub** and authorize the deployment-owned
   **OpenGeni Lens** App as the personal-account owner or an active organization
   owner. GitHub's installation screen is the repository picker; the callback
   creates or repairs the exact registration and repository triggers
   atomically. GitLab, Azure DevOps, and self-hosted bring-your-own GitHub Apps
   remain available under the advanced credential form.
3. For an advanced provider registration, configure the provider webhook with
   the OpenGeni API origin plus the returned opaque path,
   `/v1/webhooks/automations/:endpointId`.
4. Enable only the repositories the bot may review, then choose the review
   model for each repository under **Review execution**. The selector is grouped
   by billing source. Choosing a Codex model uses the workspace's connected
   Codex subscription instead of OpenGeni credits. Provider repository,
   installation, and project identifiers are authority, not display metadata.

Registration and secret rotation require workspace administration and
`secrets:write`. App private keys, provider tokens, and ingress secrets are
encrypted with the deployment environment-encryption key. List responses expose
presence and expiry metadata, never secret values.

### GitHub

The ordinary product flow installs a deployment-owned GitHub App named
**OpenGeni Lens**. It is a separate identity from the platform GitHub App and
from every human connection. A deployment operator registers it once; workspace
administrators then install or reconnect it without handling an App ID, private
key, or webhook secret. Self-hosted deployments may instead use the advanced
bring-your-own App form.

Repository permissions:

- Metadata: read-only
- Contents: read-only
- Pull requests: read and write

Organization permission:

- Members: read-only, used only by the OAuth owner-proof callback

Subscribe to **Pull request** events and configure the webhook URL as
`/v1/webhooks/pr-review/github`. The App setup URL is
`/v1/pr-review/github/setup`; its OAuth callback is
`/v1/pr-review/github/oauth/callback`. Configure
`OPENGENI_PR_REVIEW_GITHUB_APP_ID`, `..._CLIENT_ID`, `..._CLIENT_SECRET`,
`..._APP_SLUG`, `..._WEBHOOK_SECRET`, and `..._APP_PRIVATE_KEY` on API and
worker processes. The flow also requires the existing
`OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET` and
`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`. OpenGeni proves exact personal or
organization ownership, reads the installation's selected repositories,
persists canonical clone URLs, and mints each live token for the exact
repository with only `contents:read` and `pull_requests:write`.

The shared App has one webhook URL. OpenGeni verifies its HMAC over the bounded
raw body before parsing provider ids, then resolves the globally unique
installation/repository route to one workspace source. A repository may have
only one active OpenGeni Lens route in a deployment, preventing duplicate review
sessions across workspaces. Disabling a registration removes those routes but
does not uninstall the App from GitHub.

The initial adapter supports `github.com`, not GitHub Enterprise Server.

GitHub's permission references are
[Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
and
[Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

### GitLab

Prefer a project access token on the exact project, issued to a dedicated bot.
Use scopes:

- `read_repository` for Git-over-HTTPS checkout
- `api` for API reads and merge-request discussion writes

Add a **Merge request events** project webhook and use the same secret token in
GitLab and OpenGeni. Self-managed GitLab is supported through a credential-free
HTTPS base URL. Binding verifies the numeric project ID and persists the
canonical project path and clone URL returned by GitLab.

The `api` scope is broad, so project membership is the effective least-privilege
boundary. Restrict the bot to the smallest project role that can read code and
create merge-request comments. See
[GitLab access-token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/).

### Azure DevOps

Create a dedicated identity and restrict it to the intended organization,
projects, and repositories. The adapter requires:

- `vso.code` for source and pull-request reads
- `vso.threads_full` for pull-request comment-thread reads and writes

Use an organization URL such as `https://dev.azure.com/example`. Create Web
Hooks service-hook subscriptions for **Pull request created** and **Pull request
updated**, using Basic authentication with the same username and secret stored
in OpenGeni. Binding verifies the repository GUID and project GUID through Azure
Repos and persists the canonical HTTPS clone URL.

See Microsoft's
[Azure DevOps OAuth scope reference](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth?view=azure-devops).

GitLab and Azure DevOps credential rotation is explicit through registration
update. Expired credentials fail closed before sandbox injection.

## Model and billing source

Each repository binding stores one optional exact product model. The model
catalog is the source of truth for both the serving provider and billing rail;
there is no second mutable `source` field that could disagree with the model.
The setup UI currently exposes the two unattended-review billing rails with
complete admission authority: OpenGeni credits and the workspace Codex
subscription pool.

Selecting a `codex/...` model freezes that exact model into the trigger revision
and accepted automation run. Dispatch rechecks that the workspace still has an
active Codex subscription, classifies the turn as externally billed, and then
uses the ordinary workspace-local Codex allocator and capacity-wait lifecycle.
It consumes no OpenGeni credits. OpenGeni does not freeze a concrete credential
row into the trigger: a workspace with multiple connected Codex accounts keeps
the allocator's normal rotation, lease, cooldown, and failover behavior.

Leaving the repository on **Deployment default** preserves the existing
deployment model behavior. Changing the selection creates a new immutable
trigger revision for future events; a run already accepted against an older
revision retains its original model. If the selected external subscription is
later disconnected or becomes unavailable, new dispatch fails closed instead
of silently falling back to OpenGeni credits.

## Generic automation composition

The Pack composes with [`automations.md`](automations.md) instead of owning a
second webhook or run lifecycle:

- the provider registration atomically creates one generic automation source;
  that source owns the adapter ID, opaque endpoint, encrypted ingress secret,
  non-secret provider configuration, status, and version, and is fenced to the
  exact Pack installation plus provider connector so only the Pack setup API
  can rotate or change it;
- a repository binding atomically creates one Pack-owned generic trigger whose
  immutable revision freezes exact repository matching and session parameters;
- a verified delivery becomes a bounded normalized generic event;
- delivery deduplication is `(source, provider delivery key)` plus an exact raw
  digest, while logical-review deduplication is `(trigger, repository + PR +
  head SHA)`;
- the accepted generic run freezes the source version, trigger revision, Pack
  installation, normalized event, and rendered session execution;
- the generic Temporal dispatcher links the run to an ordinary session with
  create idempotency `automation-run:<runId>`.

Disabling the Pack, source registration, or repository trigger prevents new
dispatch. Dispatch rechecks all three authorities in the same transaction that
creates and links the session. Historical events, runs, and sessions remain
auditable.

## Exact-head and action authority

Webhook authentication is over the exact bounded raw body before JSON parsing:
GitHub uses HMAC-SHA-256, GitLab its secret-token header, and Azure DevOps Basic
authentication. The adapter accepts only supported pull-request actions and
normalizes provider, repository, pull request, refs, and a full commit SHA.
Drafts and unsupported events are ignored.

The repository resource freezes the expected head SHA. Checkout must resolve to
that exact commit or materialization fails. Immediately before every provider
write, the Skill must fetch the current PR head again and publish nothing if it
moved.

Ingress secrets and provider action credentials are deliberately separate. The
generic source owns only webhook verification. At Git credential use time, the
worker requires the exact live root session, turn, and attempt linked to the
generic run, then rechecks:

- active Pack installation, source, trigger revision, registration, and
  repository binding;
- exact automation run/session linkage and `pull_request_review` policy role;
- exact provider, repository ID/URI, installation or project ID, credential
  binding, and expected head SHA.

Only then does it mint a repository-restricted GitHub installation token or
decrypt the exact GitLab/Azure credential. Credentials are seeded off-manifest
for Git and provider CLIs; they never enter prompts, history, events, repository
URLs, or sandbox manifests. An ordinary session cannot imitate this authority.

The Pack requires managed compute. It rejects `selfhosted` because an
unattended automation must not clone onto a connected user's machine.

## Review behavior

The Skill performs an applicability-driven review of changed code for concrete,
actionable failures across three families:

- security: authentication/authorization, tenant and trust boundaries,
  injection, secret/data disclosure, unsafe deserialization, SSRF/path
  traversal, cryptography, dependency/supply-chain, and privilege expansion;
- application: correctness, state and concurrency, error/retry/idempotency,
  API and data compatibility, migrations/recovery, resource lifecycle,
  observability, performance, and cross-layer integration;
- infrastructure: IaC/IAM/network exposure, containers and Kubernetes, CI/CD,
  rollout/rollback, backup/restore, resilience/capacity, and cost amplification.

A finding needs a concrete changed-code failure path and precise location. Style
feedback, generic hardening advice, speculative concerns, and unrelated
pre-existing defects are excluded. The agent first checks for equivalent
existing bot comments so retries do not duplicate findings.

Pull-request content is untrusted. While write credentials are available, the
Skill may inspect static source and provider metadata but must not execute
PR-controlled scripts, builds, tests, hooks, packages, binaries, containers, or
IaC plans. It may publish only review comments: no pushes, merges, approvals,
closing, labels, or settings changes. Provider-side least privilege remains the
final enforcement boundary.

## API and implementation map

Setup routes:

```text
GET    /v1/workspaces/:workspaceId/pr-review/registrations
POST   /v1/workspaces/:workspaceId/pr-review/registrations
PATCH  /v1/workspaces/:workspaceId/pr-review/registrations/:registrationId
DELETE /v1/workspaces/:workspaceId/pr-review/registrations/:registrationId
POST   /v1/workspaces/:workspaceId/pr-review/repositories
PATCH  /v1/workspaces/:workspaceId/pr-review/repositories/:bindingId
DELETE /v1/workspaces/:workspaceId/pr-review/repositories/:bindingId
```

Manually registered provider identities use the generic public route:

```text
POST /v1/webhooks/automations/:endpointId
```

The deployment-owned GitHub App uses its single shared ingress route:

```text
POST /v1/webhooks/pr-review/github
```

GitHub installation setup adds:

```text
GET /v1/workspaces/:workspaceId/pr-review/github
GET /v1/workspaces/:workspaceId/pr-review/github/connect
GET /v1/pr-review/github/setup
GET /v1/pr-review/github/oauth/callback
```

`DELETE` is an audit-preserving disable. The opt-in SDK surface is
`@opengeni/sdk/pr-review`. Registrations and repository bindings own Pack
sources and triggers, so their setup routes are the only mutation authority;
the generic automation routes cannot claim or alter those Pack-owned rows.

- Pack, adapter, Skill, verification, and normalization:
  `packages/core/src/domain/packs.ts`, `packages/core/src/domain/pr-review.ts`
- generic event/run/session substrate: `packages/core/src/domain/automations.ts`,
  `packages/db/src/automations.ts`, `apps/api/src/routes/automations.ts`,
  `apps/worker/src/activities/automations.ts`
- provider registration, binding, and action authority:
  `packages/db/src/pr-review.ts`, migration `0320_pr_review_pack.sql`
- setup HTTP adapter and provider repository verification:
  `apps/api/src/routes/pr-review.ts`,
  `apps/api/src/routes/pr-review-github.ts`,
  `apps/api/src/integrations/pr-review-provider.ts`
- standalone credential broker: `apps/worker/src/pr-review-credentials.ts`
- exact-head repository materialization: `packages/runtime/src/index.ts`
- SDK/UI: `packages/sdk/src/pr-review-client.ts`,
  `apps/web/src/components/capabilities/pr-review-setup-card.tsx`
