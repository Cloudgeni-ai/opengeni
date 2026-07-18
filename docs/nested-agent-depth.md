# Nested-agent depth policy

OpenGeni enforces one absolute maximum session-tree depth at the PostgreSQL
session-creation boundary. The policy limits new descendants without changing
the lifecycle or control state of sessions that already exist.

## Depth and precedence

- A root session has depth `0` and its `rootSessionId` is its own id.
- A child has its parent's depth plus one and keeps the same root id.
- The maximum is inclusive. The default limit `3` permits depths `0`, `1`, `2`,
  and `3`; an attempted depth `4` is denied.
- The effective limit resolves in this order:
  1. an explicit session/agent override (`maxNestedAgentDepth` at create time),
  2. `workspaces.settings.maxNestedAgentDepth`,
  3. deployment setting `OPENGENI_MAX_NESTED_AGENT_DEPTH`,
  4. server default `3`.

An explicit override is an absolute depth, not a number of generations
remaining. A caller with `sessions:create` may keep or reduce the inherited
limit. Increasing it requires `workspace:admin`. The candidate policy applies
to the session being created, so it cannot authorize an attempted depth that is
already greater than that candidate limit.

Every session persists and exposes:

- `parentSessionId`, `rootSessionId`, and `nestedAgentDepth`;
- `maxNestedAgentDepthOverride`;
- `effectiveMaxNestedAgentDepth`;
- `nestedAgentDepthPolicySource` (`session`, `workspace`, `deployment`, or
  `default`); and
- `nestedAgentDepthPolicySessionId`, which identifies the session whose
  explicit policy is inherited.

These lineage and policy-snapshot fields are immutable after creation. The
application role cannot rewrite a session into another tree or retroactively
change the policy under which it was admitted.

An explicit session policy is inherited by all future descendants until an
authorized descendant supplies another explicit override. Without an inherited
session policy, each creation re-resolves the current workspace policy while
holding the workspace creation lock, then deployment/default policy. A
workspace policy changed while a parent turn is running therefore governs the
next child creation; a persisted session override does not change underneath
that tree.

## Authoritative boundary and denial contract

All production creation paths converge on `createSession` or
`createSessionWithIdempotencyKey` in `packages/db/src/index.ts`: public HTTP,
first-party MCP `session_create`, the TypeScript SDK (through HTTP), and worker
internal/scheduled root creation. The PostgreSQL transaction locks and validates
the workspace, locks the trusted parent when present, resolves lineage and
policy from server-owned rows/settings, then either inserts the session or
commits one complete denial record.

A denial returns the standard error envelope with code
`nested_agent_depth_exceeded` (HTTP `409`) or
`nested_agent_depth_override_forbidden` (HTTP `403`). MCP returns the same
envelope as an `isError: true` tool result. `details.denial` contains the durable
denial id, parent/root ids, current and attempted depth, effective limit, policy
source/session, requested override, subject, idempotency key, and timestamp.

The dedicated `session_spawn_denials` row is the denial's complete audit
evidence, not a partially-created session audit. A denied transaction creates
no session, MCP-server attachment, goal, event, history item, turn, workflow
wake/outbox entry, sandbox pointer/lease, workflow, usage or billing record. The
domain raises the transport-neutral denial only after that transaction commits;
no post-create initializer runs.

A non-null workspace-scoped create idempotency key deduplicates successful and
denied attempts. Concurrent/retried denied calls return the same denial id.
When a successful session already owns the key, that session remains the
winner. These rules are resolved under the same creation lock, so a retry
cannot turn one logical denied create into multiple audit rows or partial work.

The production migration is rolling-safe expand/backfill/contract work. It adds
nullable fields first, installs a mixed-version insert trigger so eligible old
binaries continue creating root and nested sessions, backfills committed batches
under bounded locks, validates constraints separately, makes the snapshot
immutable/non-null, validates deferred self-references, and builds the tree index
concurrently. A genuinely over-depth insert from an old binary still fails
atomically. Workspace deletion remains a valid cascade over the entire session
tree and its denial evidence; deleting only a referenced root does not.

## Existing trees, Pause, and budgets

Migration backfill computes lineage for existing trees, including trees deeper
than the newly effective limit. Those sessions remain readable, controllable,
resumable, and runnable. Only a new descendant whose attempted depth exceeds
its effective policy is blocked; an authorized explicit override may permit it.

Depth admission is separate from recursive Pause/Resume admission control. A
paused branch remains paused for current and future descendants according to
the control projection; depth admission neither resumes it nor replaces its
control state. If creation is depth-eligible under a paused branch, ordinary
session-start initialization observes the pause and creates no runnable wake.
UI tree collapse is presentation only and never changes either policy.

Depth is also orthogonal to budgets and concurrency. Existing
`agent_run:create` limit/entitlement checks remain the budget layer, and the
normal turn/workspace admission machinery remains the runtime concurrency
layer. A depth denial records no usage. Do not use depth as a model-call,
continuation, queue, or parallelism limit.

## Configuration

```bash
# Deployment-wide fallback. Omit to use the server default of 3.
OPENGENI_MAX_NESTED_AGENT_DEPTH=3
```

Workspace administrators set the workspace value through the existing
workspace-settings API using `maxNestedAgentDepth`; PATCH it to `null` to remove
the workspace override and restore deployment/default precedence. Session
creators may pass `maxNestedAgentDepth` to HTTP, SDK, or MCP create requests;
increases are privilege-checked server-side rather than trusted from a client.

## Production-safe canary

Run the canary only after the reviewed commit is merged, staging artifacts were
built from that merged `main`, and the identical image digests were promoted
with `rebuild=false` during an otherwise idle release window.

1. Record the deployed API/worker image digests and migration history. Create
   an isolated canary workspace or dedicated root with the effective limit `3`.
2. Through the first-party MCP path, use stable unique create idempotency keys
   to create depth `1`, then `2`, then `3`. Use only a connected Codex
   subscription if a bounded agent turn is needed; never use Azure-hosted
   inference.
3. Read each session back and verify its parent/root ids, depths `0..3`,
   effective limit, source, and policy-session id.
4. Attempt depth `4` twice with the same key. Verify both MCP results are typed
   errors with code `nested_agent_depth_exceeded` and the same denial id.
5. Query through the application database role (FORCE RLS active) and operator
   telemetry to prove the denial id has no session, MCP attachment, goal,
   event, history, turn, workflow-wake/outbox, sandbox/lease, usage, or billing
   artifact. Verify no Temporal workflow exists for the rejected attempt.
6. Pause a canary ancestor, verify an otherwise depth-eligible descendant
   remains non-runnable, then resume/cancel and clean up the canary tree through
   normal product controls. Preserve only redacted ids/counts and digests as
   release evidence.

Canonical implementation: `packages/contracts/src/index.ts`,
`packages/db/src/schema.ts`, `packages/db/src/index.ts`,
`packages/core/src/domain/sessions.ts`, `apps/api/src/routes/sessions.ts`, and
`apps/api/src/mcp/server.ts`.