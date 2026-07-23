# Embedding OpenGeni

This guide is for a host application that embeds OpenGeni instead of running it only as the stock API + worker service. Embedding means binding host-owned concerns (identity, tenancy, billing admission, credentials, persistence, worker process, and event bus) into the same OpenGeni domain/runtime code the standalone stack uses.

The contract is simple: **all ports unset means standalone**. The defaults in `apps/api/src/index.ts`, `apps/worker/src/activities.ts`, and `packages/db/src/index.ts` preserve the normal local/self-hosted deployment behavior. An embedded host opts in by binding only the seams it owns.

## Consumption Shapes

**Host-rendered product UI.** A host that keeps its own visual shell can consume
`@opengeni/react/session`. The subpath exposes the session event, composer,
queue and control hooks plus pure timeline projection, without importing the
styled workbench graph. Pass a proxy implementing the subpath's narrow
`SessionClientLike` plus host-safe workspace/session aliases through each
hook's `{ client, workspaceId }` override when workspace-global provider
behavior is not appropriate. The proxy does not need billing, rigs, files,
terminal, workbench, or workspace-administration methods; workspace-level
Resume is optional.

**V1: mount the router.** Import `createApp(deps)` from `@opengeni/api-router/app` (`apps/api/src/app.ts`) and mount the returned Hono app under the host's route prefix. The dependency bag is `AppDependencies` from `@opengeni/core` (`packages/core/src/dependencies.ts`): `settings`, `db`, `bus`, and `workflowClient` are required; `documentIndexer`, `documentServices`, `observability`, `managedAuth`, `sessionAuthorization`, `sandboxClient`, and `resumeBoxById` are optional host bindings. The routes remain `/v1/...` inside the mounted app. If the mount prefix makes the worker's loopback MCP URL wrong, set `OPENGENI_MCP_URL` / `settings.opengeniMcpUrl`; `firstPartyMcpBaseUrl` in `packages/config/src/index.ts` is the canonical rule.

**V2: call core directly.** Import from `@opengeni/core` and call domain helpers without HTTP. The main session surface is:

```ts
createSessionForRequest(deps, grant, workspaceId, rawPayload);
acceptSessionUserMessage(deps, grant, workspaceId, sessionId, input);
```

Both live in `packages/core/src/domain/sessions.ts` and expect `ApiRouteDeps` plus an `AccessGrant`. Scheduled-task validation/sync helpers live in `packages/core/src/domain/scheduled-tasks.ts`. V2 skips Hono parsing/routing, but it does not skip Postgres, EventBus, Temporal wakeups, or worker execution.

**Runtime dependency isolation.** `@opengeni/runtime` bundles its OpenAI Agents
implementation together with the Zod 4 instance that defines those runtime
schemas. An embedding host does not need to adopt OpenGeni's Zod major and must
not patch or symlink the Agents dependency tree. The published type declarations
still reference the public Agents types, so the Agents packages remain declared
dependencies, but OpenGeni's executable `dist` contains no external Agents or
Zod import. The publish-closure guard enforces that boundary.

### Agent persona: two levers

A host that runs multiple agent personas has two composable, system-level instruction levers. Both ride the same authoritative instructions channel the agent obeys — neither is ever rendered as a user/timeline message — and they compose in a fixed order: **deployment default template → workspace persona → per-session instructions** (session-specific last), with the non-bypassable CORE (goal-loop ownership + variable set block) always substituted in.

- **Workspace `agentInstructions`** (`Workspace.agentInstructions`, set at workspace create/update) — the white-label persona for _every_ session in a workspace. Use it for stable, tenant-wide branding/behavior. It may embed the `{{core}}` marker to place the non-bypassable CORE; if it omits the marker, CORE is appended.
- **Per-session `instructions`** (`CreateSessionRequest.instructions`) — an optional, per-_session_ refinement layered after the workspace persona. Use it to deliver a **per-agent-type prompt** (reviewer vs. planner vs. fixer) when many personas share one workspace, without minting a workspace per persona. It is org-visible metadata (returned on the session record, exposed like `title`/`goal`), **never** a timeline event, so internal prompt content does not leak to shared-session readers and carries full system-level authority.
- **Preallocated session identity** (`CreateSessionRequest.requestedSessionId`) — an optional UUID an embedding host may persist in its own projection before calling OpenGeni. OpenGeni creates that exact session and rejects collisions with `409`, so the initial worker claim cannot outrun the host link. Pair retries with the same workspace-scoped `idempotencyKey`; a replay that changes the UUID is rejected. The UUID is identity/correlation only and grants no access.

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

A trusted V1 embedding host may also sign `serviceInitiator` plus optional
`serviceInitiatorContext` into a domain-bound `ogd2_` delegated bearer. OpenGeni continues to
authorize the request with the bearer's ordinary `subjectId` and permissions,
but freezes the separately asserted service principal as causal provenance for
the new session/turn. The claim accepts only `kind: "service"`, cannot coexist
with exact agent turn/attempt claims, and is consumed only by commands that
create work; it cannot impersonate a human or change access. V2 core callers
can provide the same typed fields on their trusted `AccessGrant`. The optional
display label belongs on `serviceInitiator`, not in its context. Identity fields
and context are bounded; OpenGeni-owned lineage/backfill keys and the
`unattributed-legacy` migration sentinel are reserved.

Ordinary delegated and first-party/Toolspace credentials remain `ogd_`. The
`ogd2_` prefix is included in its HMAC input so a service-provenance token fails
closed on an older verifier during rolling deployment and cannot be downgraded
by changing its prefix.

The normal first-party orchestration MCP and Toolspace use deliberately
different bearer scopes. The worker re-signs the normal first-party bearer for
every request with the exact current turn, attempt, and execution generation;
an agent-created child is accepted only while that attempt still owns the turn,
and the ownership proof and child-session insert share one database
transaction. The sandbox Toolspace bearer is renewable and session-bound so
long-running work does not lose Code Mode after one hour, but Toolspace excludes
the first-party OpenGeni orchestration server and cannot use that broader
lifetime to call `session_create` or other first-party tools recursively.

### Session Authorization

Canonical sources: `SessionAuthorizationPort` in
`packages/contracts/src/index.ts`, the enforcement helpers in
`packages/core/src/session-authorization.ts`, and the mounted HTTP/MCP/SSE
surfaces in `apps/api/src/`.

Workspace permissions answer whether a principal may use a capability at all.
An embedding host may additionally own per-session ownership, sharing, and
revocation by binding `AppDependencies.sessionAuthorization`:

```ts
type SessionAuthorizationPort = {
  authorizeSession(input: AuthorizeSessionInput): Promise<SessionAuthorizationDecision>;
  resolveListScope(
    input: ResolveSessionAuthorizationListScopeInput,
  ): Promise<SessionAuthorizationListScope>;
};
```

`authorizeSession` receives the account/workspace, requested operation and
surface, the immediate target plus its server-resolved lineage root, and either
the authenticated subject or a live exact agent attempt. Agent authority is
reconstructed from durable attempt ownership and includes the caller session,
caller root, turn, attempt, execution generation, and frozen initiator; caller
input cannot nominate those fields. A settled, superseded, interrupted, or
otherwise stale attempt is rejected before the host is called.

An allowed decision may set `relatedSessionAccess: "root"` when the principal
may see the target's full tree. The fail-closed default is `"target"`: detail,
lineage, control, parent, and tree-stat projections remove information derived
from other sessions. This projection choice never authorizes an operation on a
second session; that target always receives its own authorization decision.

`resolveListScope` returns either `all` or a bounded database-applicable scope:
`rootSessionIds` include their descendants while `sessionIds` authorize exact
rows only. OpenGeni applies the scope inside search, pin, ordering, totals,
snapshot continuation, and MCP discovery queries. It does not hydrate a broad
page and filter afterward. Revocation between cursor pages skips newly hidden
rows and continues scanning to fill the next authorized page.

Once the port is bound, unknown session-addressed HTTP routes fail closed. The
same policy is enforced by shared core mutation entrypoints, cross-session
first-party MCP tools, every session-bound first-party MCP transport request,
and Toolspace. SSE performs an initial decision and reauthorizes even while
idle; hosts may request a 1–60 second interval and the default is 15 seconds.
Denied targets are externally indistinguishable from missing sessions; invalid
responses or an unavailable host return a retryable unavailable failure. All
ports unset preserves standalone behavior without the added lookups.

This port authorizes OpenGeni sessions; it does not replace OpenGeni's internal
delegated/MCP/stream credentials. The host still mints its ordinary user-facing
delegated token, while OpenGeni continues minting technical first-party tokens
and then consults this port with their durable caller authority.

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

Canonical sources: `ConnectionCredentialsPort` in `packages/contracts/src/index.ts`,
the worker consumers in `apps/worker/src/activities/`, and the API Toolspace
consumer in `apps/api/src/mcp/toolspace.ts`.

The port can bind any combination of its four legs:

```ts
type ConnectionCredentialsPort = {
  gitCredentials?(input: GitCredentialsRequest): Promise<GitCredentials>;
  sandboxSecrets?(input: SandboxSecretsRequest): Promise<SandboxSecrets>;
  runCredentials?(
    input: RunCredentialsRequest,
  ): Promise<RunCredentialsResolution>;
  mcpCredentials?(
    input: McpCredentialsRequest,
  ): Promise<McpCredentialResolution>;
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

Repository mounts are resource identity, not host-to-runtime mapping. An embedding
host may omit `mountPath`; OpenGeni then normalizes and persists
`repos/<encoded-host>/<owner>/<repo>`, including a non-default Git HTTPS port in
the encoded host segment. That keeps equal owner/repository names on GitHub,
GitLab, Azure DevOps, and custom hosts distinct. Explicit paths remain supported,
but are workspace-relative, separator-normalized, traversal-free, portable to
case-insensitive filesystems, and collision-checked before sandbox execution.
The normalized path is returned on the session resource and is the same value
used by the manifest, clone hook, agent filesystem, and workbench.

When upgrading existing sessions that omitted `mountPath`, the new default
materializes the repository at the host-aware location. A host that must retain
an existing warm workspace path should persist the session's former effective
`repos/<owner>/<repo>` path explicitly before upgrading. Previously accepted
explicit paths that are non-portable or collide after Unicode normalization and
case folding must be renamed. A repository whose name cannot itself be
used as a portable path segment (for example, a Windows-reserved device name)
can still be attached with a safe explicit `mountPath`.

Every request carries the current `sessionId`, root-session lineage,
turn/attempt/execution generation, frozen initiator, and immutable initiator
provenance. A host must authorize that authority against its own session binding
and selected repositories immediately before minting either a token or stable
Git identity. OpenGeni reuses the same frozen authority for initial provisioning,
deferred identity resolution, lazy provisioning, and proactive renewal; it fails
closed before calling a bound host broker when the authority is unavailable.

Legacy sessions with one binding for a provider retain the old request shape:
GitHub receives the authority plus `{ accountId, workspaceId, installationId, repositoryIds }`
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
check before values are applied.

`runCredentials` is the session-aware seam for credentials that programs inside
the sandbox need: cloud CLI variables, kubeconfigs, provider configuration files,
or equivalent host-owned material. It is independent of `variableSetId`; the
request includes a variable-set id/name only as informational context. An
embedding host should resolve the OpenGeni session through its own durable
session binding instead of creating a marker variable set or copying host
connection rows into OpenGeni.

Every request carries account/workspace/session, parent and root session,
the shared `sandboxGroupId`,
turn/attempt/execution generation, frozen initiator and provenance, effective
sandbox backend and OS, and whether the call is initial provision or renewal.
The host decides which of its connections apply—including whether to deliver
anything to a connected machine—and returns provider-neutral environment
values, relative credential files, and environment names that point at those
files. One response may contain credentials for multiple providers and multiple
accounts; OpenGeni does not infer or constrain provider combinations.
`not_applicable` is the explicit per-attempt opt-out for a target OS/backend or
host policy; it carries no material and must remain stable for the frozen
attempt. On a compatible command surface OpenGeni still removes any prior
session credential root before agent or Channel-A commands run, so a worker
crash cannot leave an old pointer readable merely because the next attempt opts
out.

Run material is never added to the sandbox manifest or `/workspace`. The worker
validates scope echoes, paths, sizes, expiry, and reconnect metadata, then the
runtime writes an immutable generation under a session-specific `/tmp` root and
atomically replaces a small pointer file. Every new agent command and
session-scoped Channel-A terminal process sources that generation. Renewal is
single-flight and proactive; a stopped attempt rejects late host responses,
drains any physical write, and removes only its own generations before admitting
a successor or capturing the workspace. A successor's already-active generation
cannot be erased by stale cleanup; its initial provision also prunes orphaned
generations left by a worker crash after the prior attempt was fenced. Renewal
retains the active and immediately prior immutable generation, which gives an
already-running process one rotation of overlap while bounding disk growth;
processes do not receive live environment mutation and should restart or perform
their own provider refresh if they outlive rotating credentials.

Credential selection and renewal are pinned to the effective sandbox backend
and unproxied session established at turn start. If a user swaps the active route
mid-turn, OpenGeni does not copy that turn's host material onto the new target;
the next admitted turn resolves and seeds credentials for that target. This is a
deliberate authority boundary, especially when the new target is a connected
machine. A chat-only lazy turn still resolves the host port so reconnect state
and model context are deterministic even if no sandbox is ultimately created;
hosts should therefore keep resolution bounded, idempotent, and inexpensive.

`sandboxGroupId` is also a security fact, not bookkeeping. Sessions in one group
share an OS user and filesystem; separate session directory names prevent
accidental activation collisions but are not an isolation boundary. A host must
therefore select credentials that are valid for the whole shared-box trust
domain (commonly the intersection or root-session policy), decline delivery, or
place differently trusted sessions in separate sandbox groups. OpenGeni never
claims that `/tmp` path separation protects one same-user process from another.

Environment values are automatically registered with event-output redaction.
When a credential file embeds atomic secrets (for example a bearer inside a
kubeconfig), the host must also return those values through `redactions`; this
lets OpenGeni redact chunked command output without understanding provider file
formats. `auth_needed` can coexist with usable material and becomes both bounded
model context and a structured `credential.auth_needed` reconnect card.

The box-global websocket `ttyd` server remains credential-free because one box
may be shared by several sessions. Session-scoped terminal exec and PTY calls do
receive the active generation. A future websocket terminal implementation must
first isolate its server/process by session; pointing the current group-global
server at one session's credential root would be a cross-session leak.

Materialization uses a POSIX `bash` command surface. Base64 decoding is probed
across GNU, macOS, and OpenSSL variants, and every file's decoded byte count is
verified before activation. Pointer updates prefer
`flock(1)` and fall back to an atomic, stale-reaped directory lock so macOS does
not require an extra package. A host targeting a non-POSIX command surface (for
example native Windows without a compatible shell/toolset) must return
`not_applicable` for that attempt.

`mcpCredentials` is the request-time credential seam for connection-backed MCP
servers. Bind the same port through `activityDependencies` on the worker service
and `createApp(deps)`. The worker uses it for ordinary model-visible MCP calls;
the API router uses it for Toolspace/Code Mode. When the leg is absent, both
surfaces use OpenGeni's standalone encrypted connection store and refresh broker.
When it is present, the host is the sole credential source: OpenGeni does not
create or require a duplicate provider connection.

Every request includes account/workspace scope, the immediate session and its
workspace-scoped `rootSessionId`, the exact durable turn and execution
generation, the immutable `TurnInitiator`, the non-authoritative technical
caller, the MCP server/tool, the opaque `connectionRef`, and whether a 401
forced a refresh. The same lineage is resolved for ordinary model tools and
Toolspace, so a host can authorize a child through one durable root binding
without mirroring every child row. The frozen initiator—not `sandbox:<runId>`,
the session creator, or a synthetic worker subject—is the authorization
principal.

For provider-native developer tooling, `connectionRef.provider` identifies the
provider family, `providerDomain` identifies its host/tenant, `connectionId` is
the host's opaque binding identity, and `selectedResources` freezes the exact
repository ids the server may access. Multiple server entries may bind different
accounts for one provider or different providers in the same session. The
singular `resource` field remains the OAuth resource indicator; it is not a
repository selector.

Successful results must echo account/workspace/immediate-session plus the exact
provider, provider domain, requested connection id, OAuth scopes/resource, and
selected-resource set. OpenGeni rejects a mismatched echo before any returned
header can reach the provider. Credential values never enter session events;
`auth_needed` carries only bounded connection metadata. A host that cannot
satisfy the configured endpoint's auth model returns `unsupported_auth`; one
that cannot enforce the selected repository set returns
`resource_scope_unavailable`. These reasons render as unavailable, not as a
duplicate OpenGeni reconnect flow, and a connection-backed optional MCP server
still degrades without breaking unrelated session tools.

The standalone generic connection broker intentionally rejects a
`selectedResources` binding with `resource_scope_unavailable`: it can refresh a
connection token, but it has no provider-specific proof that the token or
adapter enforces those repositories. A standalone provider adapter must add that
proof before it may resolve the scoped binding.

The port is provider-neutral. A host can resolve its existing GitHub, GitLab,
Azure DevOps, or other connection from the opaque reference, and can return a
provider-supported token or a short-lived capability bearer for a compatible
host-owned adapter. OpenGeni does not imply that one provider's bearer works at
another provider's hosted MCP endpoint. Normal MCP and Toolspace deliberately
share this resolver, so Code Mode is additive rather than a second connection or
authorization system.

Unset legs fall back independently to standalone self-mint/decrypt. `runCredentials`
has no standalone fallback because ordinary standalone sandbox credentials
continue to come from variable sets and existing lifecycle hooks. This port does
**not** supply the first-party MCP delegated token: `firstPartyMcpRequestInit` in
`packages/runtime/src/index.ts` self-mints the `ogd_` bearer with
`signDelegatedAccessToken(settings.delegationSecret, ...)`.

An embedded host can narrow a root session with
`CreateSessionRequest.firstPartyMcpPermissions`. Agent-created descendants
inherit the creating session's effective first-party permission set when
`session_create` omits an override; an explicit override must still be a subset
of the creating grant. This preserves a host's capability boundary across the
session tree while top-level omissions continue to use the deployment's normal
standalone worker defaults. The inherited set is frozen on the child at
creation; later deployment-default changes do not rewrite existing sessions.

### Child execution context

An agent-created child normally needs the same working context as its manager,
even when the two conversations are separate. When the creating grant carries
the worker-signed parent `sessionId`, `createSessionForRequest` treats omitted
`resources`, `tools`, and `mcpServers` as inheritance from that trusted immediate
parent. The snapshot preserves mixed GitHub, GitLab, and Azure DevOps repository
resources, multiple credential bindings for one provider, selected MCP tool
refs, full per-session MCP policy, connection refs, and static credential
headers. Static header values move only as encrypted database ciphertext and
never enter a response, event, or core plaintext value.

The parent's session attachment keeps its existing overlay precedence if a
deployment or workspace capability with the same server ID was enabled after
the parent was created. Inheritance therefore does not silently switch the
child to a different endpoint merely because workspace configuration changed.

Each field remains independently caller-controlled. Supplying an explicit
array—including `[]`—replaces that field instead of inheriting it. If an explicit
MCP-server replacement makes an inherited strict tool ref invalid, the create
fails validation; replace `tools` in the same request rather than silently
dropping a strict tool. A top-level create has no parent snapshot: omitted
resources and MCP servers remain empty, while omitted tools continue to receive
workspace-default capability MCP refs. Variable sets, rigs, model selection,
persona instructions, goals, and sandbox placement retain their own existing
resolution rules and are not part of this context snapshot.

There is deliberately no caller-supplied `parentSessionId`. Parent identity
comes only from the signed grant, is loaded inside the same workspace boundary,
and later receives the normal exact-attempt ownership check. Explicitly attaching
or replacing MCP servers still requires `mcp_servers:attach`; omission can copy
the parent's already-authorized servers without granting the child authority to
invent a new endpoint. Header-based credentials are snapshot values, so later
rotations on parent and child are independent. A `connectionRef` remains the
preferred host integration because normal model MCP and Toolspace resolve fresh
transport credentials at request time.

### Persistence

Canonical sources: `packages/db/src/index.ts`, `packages/db/src/migrate.ts`, `packages/db/src/provision-roles.ts`, and `dbSearchPath` in `packages/config/src/index.ts`.

Standalone uses `createDb(settings.databaseUrl)` and no search-path override. Embedded hosts can use:

- `runMigrations(adminConnection, targetSchema)` / `migrate(databaseUrl, schema)` to apply the SQL chain under a caller-selected schema.
- `provisionRoles(adminConnection, { targetSchema, rlsStrategy })` for app/Temporal role setup.
- `createDb(databaseUrl, { searchPath, rlsStrategy, userLookup, max })` for postgres-js handles.
- `registerDbBinding(db, { rlsStrategy, userLookup })` for an externally constructed Drizzle handle.

Dedicated-schema deployments use a search path shaped like `<schema>,opengeni_private,public`; `public` stays last so pgcrypto/pgvector symbols resolve. `rlsStrategy: "force"` is the standalone posture: OpenGeni connects as a non-owner role and FORCE RLS applies. `rlsStrategy: "scoped"` is the embedded owner-role posture: the host owns the isolation boundary, but OpenGeni still emits the `opengeni.account_id` / `opengeni.workspace_id` GUCs on scoped queries.

### Worker

Canonical sources: `createOpenGeniWorkerService(options)`, `runOpenGeniWorker(options)`,
and the lower-level `createOpenGeniWorker(options)` in `apps/worker/src/index.ts`.

The worker is always a separate durable process for real agent turns. Run one
`control` role and one or more independently scalable `turn` roles. An embedded
host normally uses the full lifecycle wrapper:

```ts
await runOpenGeniWorker({
  role: "control", // use "turn" for the inference fleet
  settings,
  activityDependencies: {
    db: hostScopedDb,
    bus: sharedBrokerBus,
    connectionCredentials: hostCredentialPort,
  },
});
```

`runOpenGeniWorker` installs `SIGTERM`/`SIGINT` drain handlers, exposes `/healthz`,
`/readyz`, and `/metrics`, registers engine-internal maintenance schedules on the
control role, and closes only the Temporal clients/listener it creates. It never
closes the injected database or EventBus; the host closes those after the worker
has drained. Pass `shutdownSignals: false` when a host process manager owns
signals, and use `createOpenGeniWorkerService` for explicit `run`, `drain`,
`state`, and `close` control. Set `internalSchedules: "none"` only when another
control worker in the same deployment owns the OpenGeni reaper, expired-upload,
and workflow-wake schedules. These are engine maintenance cadences; the
embedding host may continue to own all product-level scheduled-agent behavior.

The published package contains `dist/workflow-bundle.js`, generated by Temporal
from the exact package source during the same build. Installed control workers
load it through `WorkerOptions.workflowBundle`; a missing artifact fails startup.
Hosts must not copy raw workflow TypeScript out of `node_modules`. Source-tree
development keeps using `src/workflows.ts` so the local edit loop remains direct.
`workflowBundle` is an advanced explicit override for release systems that
provide an equivalently version-bound artifact.

Control and turn roles normally run as separate processes and may therefore use
the same configured HTTP port. A host constructing both roles inside one process
must disable one package listener with `http: false` and expose equivalent
lifecycle endpoints itself, or provide distinct per-process settings/ports.

`ActivityDependencies` can inject `settings`, `db`, `bus`, `runtime`,
`objectStorage`, `documentServices`, `observability`, workflow signalers,
`entitlements`, and `connectionCredentials`. The lifecycle API requires the
host-owned `db` and broker-backed `bus` so readiness and resource ownership are
unambiguous; the lower-level factory retains standalone defaults.

### Temporal transport

Canonical source: `temporalConnectionOptions(settings)` in
`packages/config/src/index.ts`. The API workflow client, worker native
connection, workflow signaler, and engine schedule clients all use this one
policy.

`OPENGENI_TEMPORAL_HOST`, `OPENGENI_TEMPORAL_NAMESPACE`, and
`OPENGENI_TEMPORAL_TASK_QUEUE` select the endpoint and logical queues. Set
`OPENGENI_TEMPORAL_API_KEY` for Temporal Cloud; an API key enables TLS
automatically. Set `OPENGENI_TEMPORAL_TLS_ENABLED=true` for server-auth TLS
without an API key. Custom deployments may additionally provide
`OPENGENI_TEMPORAL_TLS_SERVER_NAME`, a base64 root CA through
`OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64`, or the paired base64 mTLS
certificate/private-key variables. Any custom TLS material also enables TLS,
and an incomplete or malformed pair fails startup before a client connects.

These are deployment credentials, not host-user integration credentials. Keep
the API key and private key in the runtime secret consumed by both API and
worker processes; do not route them through `ConnectionCredentialsPort` or
write them into a sandbox.

### Durable host event and usage export

Canonical sources: the `HostEventSink` / `HostUsageSink` contracts in
`packages/contracts/src/index.ts`, the host-export repository API in
`packages/db/src/index.ts`, migrations `0097_host_export_outbox.sql` and
`0103_host_export_root_session.sql`, and
`createHostExportPump(options)` in `apps/worker/src/host-export-pump.ts`.

An embedded host can project OpenGeni's bounded durable session events and exact usage facts into
its own business store without polling tenant routes or treating NATS as a durable log. This surface
is optional. With no registered consumer, both export gates default to false and source transactions
write zero outbox rows, preserving standalone behavior.

Provision the projection identity **after the first migration run**. It is deliberately not the
normal `opengeni_app` role: an exporter reads a cross-workspace stream, while the app role is
tenant-scoped. Provisioning grants the current API and registers same-owner default privileges;
shipped migrations also preserve existing exporter ACLs when adding an export function, so the
standard migration-only upgrade job does not strand a live exporter. Re-run provisioning if a
different database principal owns later custom functions. One OpenGeni installation per database
is supported: dedicated data schemas do not make the shared private/export function schemas
multi-installation-safe.

```ts
await provisionRoles(adminDatabaseUrl, {
  targetSchema: "opengeni",
  rlsStrategy: "force",
  appPassword,
  hostExportRole: "opengeni_host_exporter",
  hostExportPassword,
});

const exporter = createDb(hostExportDatabaseUrl, { max: 2 });
const pump = createHostExportPump({
  db: exporter.db,
  eventSink: {
    consumerId: "host-business-events",
    deliverEvents: async (batch) => hostStore.applyEvents(batch),
  },
  usageSink: {
    consumerId: "host-business-usage",
    deliverUsage: async (batch) => hostStore.applyUsage(batch),
  },
});
await pump.start();
```

The exporter role receives `USAGE` and function `EXECUTE` on the isolated
`opengeni_host_export` schema and no table privileges. The normal app role cannot register, claim,
rewind, prune, or inspect a host consumer. Each sink has a named checkpoint and one renewable batch
lease. Cursors are decimal strings so they remain exact past JavaScript's safe-integer range.

Delivery is **at least once**. If a process dies after the sink commits but before OpenGeni advances
the checkpoint, the identical idempotency keys are delivered again. A sink must transactionally
deduplicate those keys. Session ordering is authoritative by `event.sequence`; cursor order is
stable across sessions but deliberately not claimed to be causal. High-volume raw delta event types
are excluded from the host stream; their completed semantic events remain. Event types are bounded
but forward-tolerant so an older consumer can carry a newer writer's event during a rolling upgrade.
Each session-bound event and usage fact also carries the immutable lineage `rootSessionId` captured
with the outbox row. A host can therefore retain the immediate child id for audit while attributing
usage or host-owned business signals to one root binding. An unresolved pre-lineage legacy row uses
`null`; consumers must fail closed rather than guess. Child lifecycle remains child lifecycle—the
root id is attribution context, not permission to settle a root run.
Execution IDs on usage rows are validated soft references: deletion never rewrites the frozen fact.
Usage field limits are enforced only when the optional usage export is enabled; an unrepresentable
new fact fails its source transaction instead of committing a poison export row, while standalone
mode retains its prior input behavior.

Transient sink failures release the lease with exponential backoff and eventually block the named
consumer visibly instead of dropping rows. `resumeHostExportConsumer` is explicit. A genuinely
poisonous head record can be moved with `deadLetterHostExportHead`; only the exact leased head can be
disposed, so a bad record cannot skip an unseen prefix. Schema failures are counted and block like
sink failures; `HostExportPayloadError` reports the bounded head cursor needed for an explicit
operator disposition without copying its payload into logs. `rewindHostExportConsumer` rejects
pruned or future cursors. The pump runs bounded retention housekeeping after successful checkpoints;
`pruneHostExportOutbox` deletes only below every named consumer checkpoint and keeps the configured
grace window available for replay. A disabled consumer deliberately keeps that retention floor;
after quiescing it, `retireHostExportConsumer` (or `pump.retire(kind)` after `pump.stop()`) permanently
removes the checkpoint so the remaining consumers can advance retention. Re-registering a retired
name starts at the then-retained floor, not its former checkpoint; calling `pump.start()` again after
`pump.retire(kind)` performs exactly that explicit re-registration.

`pump.stop()` only drains the current sink call and stops polling; it intentionally keeps capture
enabled across deploy restarts. `pump.disable(kind)` retains that consumer and its checkpoint (so it
continues to hold the pruning floor); when it disables the last consumer of a kind, capture stops and
events in that interval are deliberately not recoverable. Normal deploys must use `stop()`, not
`disable()`.

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
entitlements port. A request can therefore be _accepted_ by the API and still
be _declined_ at run admission; hosts that want earlier rejection should gate
at their own perimeter, which they control.
