<!-- docs-refs: record -->

# Codemode

Codemode is the programmatic projection of the exact tools available to one
running agent attempt. It is not an MCP proxy, a second tool registry, or a
second execution implementation.

## Canonical invariant

After the worker has resolved tool selection, credentials, connection policy,
approval policy, and MCP discovery, `packages/runtime` freezes one
`AttemptToolEnvironment`. That object owns:

- one immutable, digest-addressed catalog bound to
  `(account, workspace, session, turn, attempt, execution generation)`;
- each tool's opaque `{serverId, toolName}` authority identity;
- its exact model name, Codemode path, schemas, annotations, icons, source, and
  approval classification; and
- the already-authorized executor closure.

The model-facing MCP adapter and Codemode dispatcher both invoke that same
environment. A display name or generated JavaScript path is never parsed back
into authority. All first-party OpenGeni, Files, Docs, Codex Apps, capability,
pack, interaction, and per-session MCP tools admitted to the attempt can enter
the catalog. Codemode never rediscovers or reconnects an MCP server.

The catalog is persisted in `session_attempt_tool_catalogs` before Codemode is
activated. On a fresh progressive-disclosure turn, only exact session refs with
`eager: true` plus in-process tools are prepared before the first model request;
all other MCPs build the same combined immutable catalog concurrently. A plain
model response may settle without Codemode ever activating, while search,
deferred invocation, or Codemode joins the catalog promise. Resume and
editable-artifact turns prepare it fully before model execution. A recovery or
successor attempt receives its own catalog and digest.

## Public attempt-scoped surface

An exact worker-signed `agent_attempt` bearer with `codemode:call` authority can
use:

- `GET /v1/workspaces/:workspaceId/codemode/catalog`
- `POST /v1/workspaces/:workspaceId/codemode/calls`
- `GET /v1/workspaces/:workspaceId/codemode/calls/:operationId`

Every request revalidates the signed account/workspace/session/turn/attempt/
generation tuple, the canonical session-authorization seam, the currently
running attempt, and the catalog digest. Ordinary workspace or session bearers
cannot use this surface, and the Codemode bearer cannot use the ordinary MCP
mount as a back door.

Codemode is outside the browser API-contract fence because its attempt catalog
digest is the compatibility token for this live protocol.

The caller supplies a UUID operation id. The first valid submission atomically
binds it to the exact request digest and creates a durable `queued` row. An
identical submission is a free idempotent replay. The same id with different
bytes is a conflict. Catalog absence, stale authority, unknown tools,
approval-required tools, and invalid payloads fail before execution;
approval-required tools must be called through the model path so the normal
human approval lifecycle remains authoritative.

## Dispatch and execution

Postgres is the operation journal and sole durable truth. The API sends only a
small NATS wake-up containing the operation id and catalog digest to the worker
that owns the exact attempt. NATS loss is harmless: a queued client periodically
re-notifies with the same operation id.

The attempt dispatcher:

1. claims the durable operation under a short renewable lease;
2. appends the fenced `agent.toolCall.created` projection;
3. records a durable execution-start boundary;
4. calls the same `AttemptToolEnvironment` used by model MCP; and
5. records exactly one terminal result and appends the fenced output projection.

Execution is bounded per attempt. Work beyond the active concurrency window
remains unclaimed and queued, so its lease cannot expire while merely waiting
for local capacity.

An abandoned claim before the execution-start marker is safe to reclaim. Once
the marker exists, OpenGeni never automatically replays the tool. Loss of the
worker, interruption, or an unclassified failure after that boundary settles as
`outcome_unknown`, telling the caller to inspect actual state before retrying.
Claim ids fence stale workers, and attempt/generation fences prevent a late
result from being attributed to successor work. Queued operations are cancelled
when the attempt closes.

## Sandbox delivery

Managed sandboxes receive only:

- a stable path to an attempt-token file;
- the Codemode base URL; and
- optionally an exact deployment-pinned `@opengeni/ogtool` package spec.

The bearer is seeded and renewed off-manifest, stored mode `0600`, and never put
in an environment value, event, run state, or log. Local development uses the
existing local-only first-party signing secret automatically; configured and
managed deployments use `OPENGENI_DELEGATION_SECRET`. There is no Codemode
feature flag: availability follows exact attempt authority and a reachable
execution environment.

Connected Machines receive no Codemode manifest pointer, token file, or durable
setup. The worker retains the same narrow bearer in memory, proactively renews
it, and snapshots `OPENGENI_CODEMODE_URL` plus the current direct bearer only
into each newly launched exact child exec. It is absent from machine storage,
argv, stable environment, session/RunState serialization, and logs. A process
already running retains its launch value; the next exec sees renewal. The Rust
agent adds its own absolute executable path only to an authorized child, making
`opengeni-agent codemode list|show|call` a dependency-free client. This is transport
only: it terminates at the same API journal and `AttemptToolEnvironment`.

## Clients

`@opengeni/codemode` exposes a persistent typed client and generates a nested,
collision-safe namespace from `codemodePath`. `@opengeni/ogtool` is the small
JavaScript command-line client; the installed Connected Machine agent contains
the equivalent no-runtime list/show/call client:

```bash
ogtool list
ogtool list --json
ogtool show docs.search
ogtool call docs.search '{"query":"durable catalogs"}'
"$OPENGENI_CODEMODE_NATIVE_CLIENT" codemode call docs.search '{"query":"durable catalogs"}'
```

Discovery is compact by default: `list` prints callable paths plus descriptions
bounded to 160 Unicode code points; `list --json` returns only `{tools:
[{path, description}]}`. `list --full` preserves the previous full catalog JSON
for explicit inspection and existing scripts. The two flags are mutually exclusive.
`show <path>` resolves exactly one tool using the same aliases as `call` and emits
its details and schemas as JSON, capped at 64 KiB including the final newline.
Unknown/ambiguous tools and oversized details fail without partial schema output;
use `list --full` redirected to a file for oversized entries. These are local CLI
projections only: the frozen catalog, authority, and API responses are unchanged.

All clients retain one caller-owned operation id, submit once, poll the journal,
and recover by `GET` if a POST response is lost after commit. None silently
retries a terminal failure or `outcome_unknown`. The agent directive recommends
Codemode for loops, polling, bulk filtering, and intermediate data that should
stay outside model context.

## Bounds

Contracts in `packages/contracts/src/tool-catalog.ts` centrally bound catalog
entries and bytes, arguments, results, path depth, content blocks, operation
leases, dispatch timeouts, and execution concurrency. Postgres repeats the
important identity, byte, lifecycle, ownership, and RLS constraints. Runtime
validation remains authoritative before invoking any executor.
