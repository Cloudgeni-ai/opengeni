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

## Ports

### Identity Resolver Chain

Canonical source: `packages/core/src/access/index.ts`.

HTTP routes use `requireAccessContext(c, deps)` and `requireAccessGrant(c, deps, workspaceId, permission)`. The chain is selected by `settings.productAccessMode`:

- `local`: calls `bootstrapWorkspace` for the default local account/workspace.
- `configured`: accepts an `ogd_` delegated bearer when `settings.delegationSecret` is set; otherwise bootstraps a configured workspace using `x-opengeni-subject`.
- `managed`: tries a delegated bearer, then hashed API key, then `managedAuth.api.getSession(...)`.

There is no separate exported `IdentityResolver` type in this pass. A V1 host binds identity through `managedAuth`, delegation/API-key settings, and HTTP headers. A V2 host may resolve identity itself and pass an `AccessGrant` directly to core domain functions.

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
  gitCredentials?: (input: GitCredentialsRequest) => Promise<GitCredentials>;
  sandboxSecrets?: (input: SandboxSecretsRequest) => Promise<SandboxSecrets>;
};
```

`gitCredentials` receives `{ accountId, workspaceId, installationId, repositoryIds }` and returns a token plus the `workspaceId` it scoped. `sandboxSecrets` receives `{ accountId, workspaceId, environmentId }` and returns plaintext environment values plus the scoped `workspaceId`. Each result is checked by the FORK-7 workspace-echo assert before the worker injects anything. A mismatch hard-fails before tenant B's credential can land in tenant A's run.

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
