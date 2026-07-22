# Embedding OpenGeni

This guide is for a host application that embeds OpenGeni instead of running it only as the stock API + worker service. Embedding means binding host-owned concerns (identity, tenancy, billing admission, credentials, persistence, worker process, and event bus) into the same OpenGeni domain/runtime code the standalone stack uses.

The contract is simple: **all ports unset means standalone**. The defaults in `apps/api/src/index.ts`, `apps/worker/src/activities.ts`, and `packages/db/src/index.ts` preserve the normal local/self-hosted deployment behavior. An embedded host opts in by binding only the seams it owns.

## Consumption Shapes

**V1: mount the router.** Import `createApp(deps)` from `@opengeni/api-router/app` (`apps/api/src/app.ts`) and mount the returned Hono app under the host's route prefix. The dependency bag is `AppDependencies` from `@opengeni/core` (`packages/core/src/dependencies.ts`): `settings`, `db`, `bus`, and `workflowClient` are required; `documentIndexer`, `documentServices`, `observability`, `managedAuth`, `sandboxClient`, and `resumeBoxById` are optional host bindings. The routes remain `/v1/...` inside the mounted app. If the mount prefix makes the worker's loopback MCP URL wrong, set `OPENGENI_MCP_URL` / `settings.opengeniMcpUrl`; `firstPartyMcpBaseUrl` in `packages/config/src/index.ts` is the canonical rule.

**V2: call core directly.** Import from `@opengeni/core` and call domain helpers without HTTP. The main session surface is:

```ts
createSessionForRequest(deps, grant, workspaceId, rawPayload)
acceptSessionUserMessage(deps, grant, workspaceId, sessionId, input)
```

Both live in `packages/core/src/domain/sessions.ts` and expect `ApiRouteDeps` plus an `AccessGrant`. Scheduled-task validation/sync helpers live in `packages/core/src/domain/scheduled-tasks.ts`. V2 skips Hono parsing/routing, but it does not skip Postgres, EventBus, Temporal wakeups, or worker execution.

### Agent persona: two levers

A host that runs multiple agent personas has two composable, system-level instruction levers. Both ride the same authoritative instructions channel the agent obeys — neither is ever rendered as a user/timeline message — and they compose in a fixed order: **deployment default template → workspace persona → per-session instructions** (session-specific last), with the non-bypassable CORE (goal-loop ownership + variable set block) always substituted in.

- **Workspace `agentInstructions`** (`Workspace.agentInstructions`, set at workspace create/update) — the white-label persona for *every* session in a workspace. Use it for stable, tenant-wide branding/behavior. It may embed the `{{core}}` marker to place the non-bypassable CORE; if it omits the marker, CORE is appended.
- **Per-session `instructions`** (`CreateSessionRequest.instructions`) — an optional, per-*session* refinement layered after the workspace persona. Use it to deliver a **per-agent-type prompt** (reviewer vs. planner vs. fixer) when many personas share one workspace, without minting a workspace per persona. It is org-visible metadata (returned on the session record, exposed like `title`/`goal`), **never** a timeline event, so internal prompt content does not leak to shared-session readers and carries full system-level authority.

Prefer `instructions` over stuffing persona text into `initialMessage`: `initialMessage` renders as visible timeline content, has weaker instruction authority, and is readable by anyone with the session. Reach for workspace `agentInstructions` when the persona is the same for the whole tenant; reach for session `instructions` when it varies per session. Omitting `instructions` is byte-identical to today's composition. It is trimmed, non-empty, and capped at 32768 characters.

## Ports

### Identity Resolver Chain

Canonical source: `packages/core/src/access/index.ts`.

HTTP routes use `requireAccessContext(c, deps)` and `requireAccessGrant(c, deps, workspaceId, permission)`. The chain is selected by `settings.productAccessMode`:

- `local`: calls `bootstrapWorkspace` for the default local account/workspace.
- `configured`: accepts an `ogd_` delegated bearer when `settings.delegationSecret` is set; otherwise bootstraps a configured workspace using `x-opengeni-subject`.
- `managed`: tries a delegated bearer, then hashed API key, then `managedAuth.api.getSession(...)`.

There is no separate exported `IdentityResolver` type in this pass. A V1 host binds identity through `managedAuth`, delegation/API-key settings, and HTTP headers. A V2 host may resolve identity itself and pass an `AccessGrant` directly to core domain functions.

### Immutable turn identity

Canonical sources: `TurnInitiator` in `packages/contracts/src/index.ts`,
`packages/db/src/turn-initiator.ts`, and the producer transitions in
`packages/db/src/index.ts` / `packages/db/src/session-queue-commands.ts`.

Every session response carries a frozen `createdBy` principal and every turn
response carries its own frozen `initiator`. They are deliberately different
facts: the creator is used only for creation attribution and idempotent repair
of that create command's first turn. A later Send or Steer records the
authenticated actor of that command. Queue move/edit/resubmit preserves the
original turn authority. Recovery, approval, and retry update the existing turn
and cannot replace it.

`TurnInitiator.kind` is `subject | service`; `subjectId` remains opaque to
OpenGeni. Hosts must not encode or infer the kind from a subject-id prefix,
because the host owns that namespace. Agent-created work inherits the caller's
frozen principal only through the HMAC-signed session/turn/attempt claims minted
by the worker, and records a bounded `via` provenance chain. Scheduled,
compaction, goal-continuation, and mixed service-only internal-update turns use
named service principals. When ordinary machine notices coalesce with an Agent
Steer, the Steer's inherited subject remains authoritative and the notices are
context rather than a replacement principal. Pre-contract and rolling
old-writer rows are explicitly
`{ kind: "service", subjectId: "unattributed-legacy" }`; a host credential
resolver must deny that sentinel rather than substitute the session creator,
API-key owner, sandbox token, or current worker.

The normal first-party orchestration MCP and Toolspace use deliberately
different bearer scopes. The worker re-signs the normal first-party bearer for
every request with the exact current turn, attempt, and execution generation;
an agent-created child is accepted only while that attempt still owns the turn,
and the ownership proof and child-session insert share one database
transaction. The sandbox Toolspace bearer is renewable and session-bound so
long-running work does not lose Code Mode after one hour, but Toolspace excludes
the first-party OpenGeni orchestration server and cannot use that broader
lifetime to call `session_create` or other first-party tools recursively.

### Tenancy / Bootstrap Workspace

Canonical source: `bootstrapWorkspace` in `packages/db/src/index.ts`.

`bootstrapWorkspace(db, input)` receives external account/workspace identifiers, display names, a subject id/label, and optional permission arrays. It creates or updates the account, workspace, and membership rows, then returns an `AccessContext`.

The workspace remains the operational boundary. Route and core code must use the workspace id from the grant/path, not a resource id, as the access boundary.

### Entitlements / Admit Run

Canonical sources: `EntitlementsPort` in `packages/contracts/src/index.ts`, core `checkLimit`/`requireLimit` in `packages/core/src/billing/limits.ts`, worker-side `ensureRunAllowed` in `apps/worker/src/activities/agent-turn.ts`.

`EntitlementsPort` is:

```ts
type EntitlementsPort = {
  admitRun(input: {
    accountId: string;
    workspaceId: string;
    action: string;
    quantity: number;
  }): Promise<EntitlementDecision>;
};
```

When bound on the worker through `ActivityDependencies.entitlements`, `admitRun` replaces local credit-balance admission for managed/Stripe-funded non-Codex turns. When unset, OpenGeni uses its local ledger/static limits exactly as standalone. The port is admission-only; metering remains the idempotency-keyed usage writer. In this branch the core API admission path still calls `requireLimit`; do not document an API-side entitlements binding until source wires one.

### Connection Credentials

Canonical sources: `ConnectionCredentialsPort` in `packages/contracts/src/index.ts`, consumers in `apps/worker/src/activities/environment.ts`.

The port can bind either or both legs:

```ts
type ConnectionCredentialsPort = {
  gitCredentials?(input: GitCredentialsRequest): Promise<GitCredentials>;
  sandboxSecrets?(input: SandboxSecretsRequest): Promise<SandboxSecrets>;
};
```

`gitCredentials` is provider-aware and remains GitHub-backward-compatible.
`RepositoryResourceRef.credentialBindingId` names one independently mintable,
host-owned credential; it is opaque, bounded to 256 characters, and never used
raw in sandbox paths. `access: "read" | "write"` tells the host what token scope
the repository needs (omitted retains the historical write-capable behavior).
One session may attach any number of repositories across GitHub, GitLab, and
Azure DevOps, including more than one account/installation for the same
provider. A host must not use `provider` alone as credential identity.

Legacy sessions with one binding for a provider retain the old request shape:
GitHub receives `{ accountId, workspaceId, installationId, repositoryIds }`
with omitted `provider`; non-GitHub requests receive `provider` plus
`repositoryRefs`. An explicit binding, or multiple bindings for one provider,
adds `credentialBindingId`, `provider`, and (for a single canonical host)
`providerHost`. The host must echo those fields exactly in `GitCredentials`.
OpenGeni validates those echoes together with `workspaceId` before accepting a
token. Provider-neutral repository refs carry the same binding/access fields
plus `provider`, `repositoryId`, `installationId`, `projectId`, and
`connectionId`; GitHub aliases remain accepted. `expiresAt` is per binding;
without it OpenGeni uses a conservative bounded refresh cadence.

The worker never writes token values into the sandbox manifest or attach-time
environment delta. The runtime stores each token at
`OPENGENI_GIT_CREDENTIALS_DIR/<sha256(binding-id)>-token`, installs a Git
credential helper that selects by protocol + host + path with
`credential.useHttpPath`, and resets broader helpers so an unbound remote cannot
fall through to a sibling credential. Provider aliases (including
`OPENGENI_GIT_TOKEN_FILE`) are written only while that provider has exactly one
binding; they are removed when a second appears. `gh`, `glab`, and `az` select
an explicit `OPENGENI_GIT_BINDING`, then the current repository's `origin`, then
a sole provider binding, and fail closed if selection remains ambiguous. Each
binding renews independently, so one failed connection cannot block or replace
a healthy sibling token. Renewal requires no model/MCP call and never mutates
the manifest.
`sandboxSecrets` receives `{ accountId, workspaceId, variableSetId }` and returns
plaintext variable set values plus the scoped `workspaceId`, with the same echo
check.

Unset legs fall back independently to standalone self-mint/decrypt. This port does **not** supply the first-party MCP delegated token: `firstPartyMcpRequestInit` in `packages/runtime/src/index.ts` self-mints the `ogd_` bearer with `signDelegatedAccessToken(settings.delegationSecret, ...)`.

### Persistence

Canonical sources: `packages/db/src/index.ts`, `packages/db/src/migrate.ts`, `packages/db/src/provision-roles.ts`, and `dbSearchPath` in `packages/config/src/index.ts`.

Standalone uses `createDb(settings.databaseUrl)` and no search-path override. Embedded hosts can use:

- `runMigrations(adminConnection, targetSchema)` / `migrate(databaseUrl, schema)` to apply the SQL chain under a caller-selected schema.
- `provisionRoles(adminConnection, { targetSchema, rlsStrategy })` for app/Temporal role setup.
- `createDb(databaseUrl, { searchPath, rlsStrategy, userLookup, max })` for postgres-js handles.
- `registerDbBinding(db, { rlsStrategy, userLookup })` for an externally constructed Drizzle handle.

Dedicated-schema deployments use a search path shaped like `<schema>,opengeni_private,public`; `public` stays last so pgcrypto/pgvector symbols resolve. `rlsStrategy: "force"` is the standalone posture: OpenGeni connects as a non-owner role and FORCE RLS applies. `rlsStrategy: "scoped"` is the embedded owner-role posture: the host owns the isolation boundary, but OpenGeni still emits the `opengeni.account_id` / `opengeni.workspace_id` GUCs on scoped queries.

### Worker

Canonical source: `createOpenGeniWorker(options)` in `apps/worker/src/index.ts`.

The worker is always a separate durable process for real agent turns. A host runs it next to the app and passes `WorkerOptions`:

```ts
type WorkerOptions = {
  settings?: Settings;
  activities?: ReturnType<typeof createActivities>;
  activityDependencies?: ActivityDependencies;
};
```

`ActivityDependencies` can inject `settings`, `db`, `bus`, `runtime`, `objectStorage`, `documentServices`, `observability`, `wakeSessionWorkflow`, `entitlements`, and `connectionCredentials`. If omitted, `createActivities` builds the standalone defaults from settings.

### EventBus

Canonical sources: `EventBus` / `createNatsEventBus` in `packages/events/src/index.ts`, SSE in `apps/api/src/http/sse.ts`.

API and worker must share the same broker-backed EventBus binding. The production implementation is `createNatsEventBus(natsUrl, auth?)`; it handles session fanout, selfhosted request/reply, and agent events over one managed NATS connection. Postgres remains the durable event log, but live SSE depends on worker publishes reaching API subscribers cross-process.

Do not replace this with an in-memory bus in an embedded deployment. In-memory fanout only reaches subscribers in the same process and would make worker -> API live SSE silently disappear; clients would only recover on replay/gap backfill.

For embedded UIs that page historical timelines, prefer `GET .../events?compact=1` (or SDK `listEvents(..., { compact: true })`) for windowed replay. It coalesces consecutive delta fragments in the page while preserving first-member `sequence`; use `payload.coalescedUntil` as the resume cursor for the live SSE stream. Streaming/gap backfill should keep using raw sequence replay.

## Trust model

The embed boundary has a deliberate split of authority. Getting this wrong in
either direction creates real vulnerabilities (too little host gating) or
pointless coupling (host ownership of engine internals), so it is a contract:

**The host owns the perimeter and external identity.**

- Every request reaching the mounted api-router has already passed the HOST's
  authentication. OpenGeni's own checks (delegated tokens, API keys) are the
  second gate, not the first — an embedded deployment must never be reachable
  except through the host's front door.
- The host decides which of its principals maps to which OpenGeni
  account/workspace, and mints `ogd_` delegated tokens (with the deployment's
  delegation secret) to act as them. Admission policy that depends on the
  host's business state (plans, quotas, feature gates) enters through the
  entitlements port on the worker side.

**The engine owns its internal plumbing tokens.**

- First-party MCP delegated tokens, stream tokens, and NATS credentials are
  self-minted by the engine with its own secrets. They never leave the engine's
  trust domain (the host's process and infrastructure), so routing them through
  a host token issuer would add coupling without adding security. Do not expect
  a port for these; there isn't one on purpose.
- Corollary for hosts: protect the engine's secrets (delegation secret,
  encryption keys) exactly like your own signing keys — inside the engine's
  trust domain they are root authority.

**API-side admission is local by design.** The API validates structure,
permissions, and workspace scoping; host-specific admission (may this tenant
run another turn?) is enforced where the work actually starts — the worker's
entitlements port. A request can therefore be *accepted* by the API and still
be *declined* at run admission; hosts that want earlier rejection should gate
at their own perimeter, which they control.
