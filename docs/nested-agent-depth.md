# Nested-agent depth policy

OpenGeni enforces an inclusive maximum depth for session trees at the
PostgreSQL session-creation boundary. The policy limits new descendants without
changing the lifecycle or control state of sessions that already exist.

## Depth and precedence

- A root session has depth `0` and its `rootSessionId` is its own id.
- A child has its parent's depth plus one and keeps the same root id.
- The server default is `3`, so depths `0`, `1`, `2`, and `3` are allowed;
  attempted depth `4` is denied.
- The effective limit is selected in this order:
  1. an explicit session/agent override (`maxNestedAgentDepth` at create time),
  2. `workspaces.settings.maxNestedAgentDepth`,
  3. the persisted deployment policy from `OPENGENI_MAX_NESTED_AGENT_DEPTH`,
  4. the server default `3`.

An explicit override is an absolute depth, not generations remaining. A caller
may keep or reduce the inherited limit; increasing it requires `workspace:admin`.
An explicit session policy is inherited by future descendants until an authorized
descendant supplies another override. Lineage and policy snapshots are immutable
after creation.

## Authoritative boundary and denials

All production session creation paths converge on `createSession` or
`createSessionWithIdempotencyKeyResult` in `packages/db/src/index.ts`: HTTP,
first-party MCP `session_create`, and scheduled worker creation. The transaction
locks the workspace admission row, reads the persisted deployment policy, locks
the trusted parent when present, resolves the policy, and either inserts the
session or commits one complete denial row.

Denials use `nested_agent_depth_exceeded` (HTTP `409`) or
`nested_agent_depth_override_forbidden` (HTTP `403`). MCP returns the same
structured envelope as an `isError` tool result. The durable
`session_spawn_denials` row contains the policy/depth snapshot and idempotency
key. A denied create creates no session, turn, event, workflow wake, sandbox,
usage, billing, or scheduled-run artifact. Reusing a non-null create idempotency
key replays the same denial id, even if the request or mutable policy changes.

## Workspace and scheduled-task policy

Workspace administrators can set `maxNestedAgentDepth` through workspace
settings; sending `null` clears the workspace override and restores deployment
fallback. Deployment migrations persist the environment value (or default `3`)
in `nested_agent_depth_configuration`; runtime admission never trusts a stale
process setting once that row exists.

Scheduled task overrides are checked for `workspace:admin` only when an increase
over the current inherited limit is requested. The authorized task configuration
is durable: later scheduled dispatches preserve its explicit override under a
narrowed workspace or deployment fallback. Depth is orthogonal to budgets,
concurrency, Pause/Resume, and model-call limits.

## Rolling migration

Migrations `0108`–`0113` use an expand/backfill/boundary/contract/validation/
concurrent-index sequence. Existing trees remain readable, including legacy
trees deeper than the current policy. New descendants are admitted only when
their attempted depth is within their selected immutable policy, or when an
authorized explicit override raises that policy.

Canonical implementation: `packages/contracts/src/index.ts`,
`packages/db/src/schema.ts`, `packages/db/src/index.ts`,
`packages/core/src/domain/sessions.ts`,
`packages/core/src/domain/scheduled-tasks.ts`,
`apps/api/src/routes/sessions.ts`, `apps/api/src/mcp/server.ts`, and
`apps/worker/src/activities/scheduled-tasks.ts`.