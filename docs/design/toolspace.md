<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# Toolspace call

Status: implementation design for `toolspace:call` (2026-07-05).

## Problem

Sandboxed agents need to call their tools from scripts without spending a model
round trip for every loop, filter, or composition step. The feature restores the
old "in-sandbox script runtime can call host tools" capability, but as an
OpenGeni substrate primitive: code execution can use tools directly.

## Decision

OpenGeni will not add a new endpoint or token family. The existing first-party
MCP route, `apps/api/src/app.ts` at `/v1/workspaces/:workspaceId/mcp`, remains
the single policy gate. The bearer is still an `ogd_` delegated access token
verified by `packages/core/src/access/index.ts`, and the signed payload in
`packages/contracts/src/index.ts` already carries the account, workspace,
subject, permissions, optional `sessionId`, and expiry needed for attenuation.

The new permission is `toolspace:call`. It is intentionally absent from the
worker's default first-party MCP permission set in `packages/runtime/src/index.ts`
and from any default agent permission set. It must be explicitly minted for the
sandbox programmatic-call path.

The worker-minted sandbox token uses this minimal permission set:

```ts
["toolspace:call"]
```

It does not include `workspace:read`, `sessions:read`, `mcp_servers:attach`,
`api_keys:manage`, `sessions:create`, or any mutation/read permission. The MCP
route admits this token only when the signed bearer also has `sessionId`; all
ordinary API routes continue to check their existing permissions, so the bearer
cannot use the REST API as a side channel.

## Rationale

This is "one gate, many principals": humans, worker-created agents, manager
sessions, and now sandbox programs all enter through the same first-party MCP
authorization path. What changes is only the principal and its attenuated
permission list.

The split is control plane versus data plane. Token minting, session ownership,
MCP server attachment, credential decryption, pack expansion, approval policy,
budget checks, and audit events stay in the API/worker control plane. The
sandbox receives only a file path containing a short-lived delegated bearer plus
the workspace MCP URL. It sends MCP JSON-RPC over HTTP; it does not receive MCP
server credentials, connection tokens, platform git provider tokens, or direct
database/object-store access.

Capability attenuation happens in the signed `ogd_` payload. A sandbox script
can call only the session-scoped toolspace surface for its own session, and only
until the token expires.

## Surface Composition

When a verified `ogd_` bearer carries both `toolspace:call` and `sessionId`, the
first-party MCP server exposes a composed, session-scoped surface:

1. First-party OpenGeni tools that are safe for a session-scoped caller and that
   the bearer has explicit permissions for. The existing permission logic still
   applies. Historically unguarded first-party helpers must not become reachable
   merely because `toolspace:call` admitted the bearer.
2. Per-session MCP servers persisted in `session_mcp_servers` for that exact
   session. The API proxies them server-side using the same decrypted
   headers/broker-injected credentials the worker uses today, and the same
   `PrefixedMcpServer` naming rule (`<serverId>__<toolName>`) handles
   collisions.
3. MCP-backed tools contributed by the session's enabled pack refs, using the
   same runtime settings expansion rules the worker uses.

Everything remains workspace and session scoped. A toolspace bearer for session
A cannot see or call session B's per-session servers, and cannot attach or
rotate MCP credentials.

This is a deliberate, narrow exception to `docs/mcp-surfaces.md`, which
currently says not to proxy one MCP surface through another. That rule remains
right for general integration design. `toolspace:call` is the exception because
the first-party MCP route is being used as the policy gateway for a sandbox
principal, not as a generic MCP bridge.

## Approval Policy

Version 1 excludes tools that require human approval. If a per-session MCP
server row or any future workspace-level policy marks a tool as requiring
approval, `tools/list` may omit it or mark it unavailable. `tools/call` must
return an MCP-shaped typed error result with the message "requires approval -
invoke via the agent".

Version 2 can add a block-on-approval path that posts a durable approval request
and waits for a decision. That path is explicitly out of scope for v1 because it
would need run-state and user-experience work beyond a direct tool call.

## Delivery To The Sandbox

When `OPENGENI_TOOLSPACE_ENABLED` is on, the worker mints one additional
short-lived `ogd_` token during environment preparation:

```ts
{
  accountId,
  workspaceId,
  subjectId: `sandbox:${runId}`,
  subjectLabel: "sandbox toolspace",
  permissions: ["toolspace:call"],
  sessionId,
  exp
}
```

Each bearer has a one-hour TTL. After the initial seed reaches a real sandbox
session, the worker proactively re-signs the same account/workspace/session/run
authority and atomically replaces the file on a bounded cadence. Renewal is
single-flight, retries transient write failures, and is stopped and drained at
attempt finalization so a settled attempt cannot land a late replacement.
Delivery mirrors `OPENGENI_GIT_TOKEN_FILE`: the token value is
written into a sandbox file and the environment exposes only
`OPENGENI_TOOLSPACE_TOKEN_FILE` plus `OPENGENI_TOOLSPACE_URL`. The token value
must not appear in the sandbox manifest, env delta, event log, run state, or
logs.

### Every backend, including selfhosted

The token is minted and delivered on **every** compute backend, including a
connected machine (selfhosted). This is a deliberate departure from platform git
provider tokens, which are skipped on selfhosted because they are inert there — the
machine uses its own git credentials. That reasoning does not transfer to the
toolspace token: it is the machine's *only* path to programmatic tool calling,
and refusing to deliver it would silently downgrade selfhosted agents.

On a selfhosted turn the token seed is written to `OPENGENI_TOOLSPACE_TOKEN_FILE`
over the machine's existing exec channel (the same NATS-backed `exec` the agent
runs commands through), reusing the identical off-manifest seed hook the docker
path uses — the value never rides the manifest. The other platform setup hooks
(repository clone, `az login`) and file materialization still do **not** run
against the user's real computer; the toolspace token seed is the single piece of
per-turn material that crosses to it.

There is one accepted delta from the docker path. On docker the manifest
environment is exported into the box shell, so `ogtool` reads
`OPENGENI_TOOLSPACE_URL` / `OPENGENI_TOOLSPACE_TOKEN_FILE` straight from `env`. A
selfhosted machine owns its own shell and does **not** consume the manifest env
wholesale (pushing `HOME`, `GIT_*`, etc. onto a real computer would clobber it),
so selfhosted `exec` exports a strict two-key allowlist — exactly
`OPENGENI_TOOLSPACE_URL` and `OPENGENI_TOOLSPACE_TOKEN_FILE`, both non-secret
pointers — into every command's environment. That is enough for `ogtool` (and the
seed hook) to find the tool surface and the token file; the token VALUE is never
in that env. `OPENGENI_TOOLSPACE_URL` resolves to the public, sandbox-routable API
base (`OPENGENI_MCP_URL`) the machine enrolled against — the same URL every remote
backend uses — never a loopback or cluster-internal address the machine could not
reach.

When the flag is off, behavior is byte-identical to the current tree: no
permission is minted, no file path appears, no URL appears, and no toolspace
surface is added.

The current pointer is box-global. Sessions that intentionally share one
sandbox group therefore also share this token-file trust boundary and can
overwrite the pointer with the most recently seeded session-bound bearer. A
per-session pointer that remains compatible with existing warm manifests is a
separate follow-up; renewal writes through the declared pointer and does not
silently change manifest identity.

## Audit And Budgets

Toolspace calls emit the same `tool.call` and `tool.output` session events as
model-originated tool calls, attributed to the sandbox subject id from the
delegated token. Proxied third-party calls must publish these events even if the
worker path did not previously emit events for third-party MCP calls.

The API enforces a per-turn toolspace call budget, configured with a sane default
such as 200 calls per turn. Enforcement is a single atomic reservation: at call
time one conditional statement increments `session_turns.toolspace_call_count`
only while it is below the limit and returns whether it won a slot
(`UPDATE ... SET n = n + 1 WHERE n < $limit RETURNING n`). The row lock serializes
concurrent `tools/call` requests, so exactly `limit` of N simultaneous callers
succeed — the earlier read-count-then-append approach let concurrent calls all
observe a stale count and overrun the budget. Exhaustion returns an MCP-shaped
typed error result instead of throwing an HTTP 500 or leaking a partial proxy
failure, and the typed error distinguishes "no active turn" from
"budget exhausted" so a caller can tell why it was refused.

Gateway recursion is structurally impossible in v1: the token does not carry
token-minting permissions, the toolspace surface never includes token minting,
and `mcp_servers:attach` is not present. The first-party proxy ids (`files`,
`docs`) and the `opengeni` tool server — all of which route back through the
`/mcp` mount — are excluded from the toolspace surface by construction, so a
future grant that happened to carry `files:read` or `documents:search` still
cannot re-enter `/mcp` as a toolspace principal.

## Security Invariants

- No escalation: `toolspace:call` admits only the toolspace MCP surface. REST
  routes and non-toolspace MCP tools still require their normal permissions.
- No cross-session access: the signed `sessionId` is mandatory and every
  persisted per-session server lookup includes `(workspaceId, sessionId)`.
- No credential exposure to the sandbox: third-party MCP headers are decrypted
  or broker-resolved only inside the API proxy path and are never returned to the
  sandbox.
- No over-authority on a user machine: **no credential crosses to a connected
  (selfhosted) machine that grants more than the machine owner's own authority.**
  The toolspace token satisfies this — it carries `toolspace:call` only, is bound
  to its own session, expires at turn TTL, is per-turn budgeted, and cannot invoke
  approval-required tools — so it is safe to deliver to the machine, whereas the
  platform git provider token (which could grant repo access beyond the owner)
  is not, and stays off it. This invariant, not the git-token precedent, is what
  decides which per-turn credentials may reach a selfhosted box.
- SSRF posture: proxy targets come only from validated persisted rows and
  enabled pack/capability refs, not from sandbox-supplied URLs.
- Human approval is not bypassed: approval-required tools are excluded or return
  the v1 typed error.
- Recursion is blocked by construction: the surface excludes the first-party
  proxies (`files`, `docs`) and the `opengeni` tool server outright — not merely
  by permission checks — so it can never re-enter `/mcp`, and it includes no
  token minting, MCP server attachment, or session mutation.
- No raw upstream error leaks: a failed proxied `tools/call` returns a generic
  "upstream tool failed" result naming the tool; the raw error is logged
  server-side only, so no header or credential material can ride the message
  back to the sandbox.
- Budget holds under concurrency: the per-turn call budget is a single atomic
  DB reservation, not a read-then-append count.

## `ogtool`

The sandbox image carries a small dependency-light CLI, `ogtool`, that reads
`OPENGENI_TOOLSPACE_TOKEN_FILE` and `OPENGENI_TOOLSPACE_URL` and performs
`tools/list` and `tools/call` with JSON input/output. It is a convenience shim,
not a new API surface.

## Agent Awareness

For the capability to be used, the agent has to know it exists. This is done
with **generic substrate prompting**, not per-host prompt text: a single fixed
directive (`TOOLSPACE_PROGRAMMATIC_DIRECTIVE` in `packages/runtime`) is appended
to the composed agent instructions by `appendToolspaceInstructions`. It tells the
agent that every tool on its MCP surface is also callable programmatically from
the sandbox (`ogtool list` / `ogtool call <name> '<json>'`, or MCP JSON-RPC to
`$OPENGENI_TOOLSPACE_URL` with the bearer from `$OPENGENI_TOOLSPACE_TOKEN_FILE`),
that input schemas come from `tools/list`, that programmatic calls are preferred
for loops, polling, and bulk filtering because their results do not consume model
context, and that approval-required tools must still be invoked normally (they
return a typed error programmatically).

The directive is appended **only when a toolspace token was minted for this turn**
— the exact condition that gates the sandbox mint (feature enabled), surfaced to
the runtime as the per-turn toolspace token seed. The mint happens on every
backend including selfhosted, so the directive appears on a connected machine too;
a turn with no minted token has no `ogtool`/URL in its sandbox, so it never
advertises a capability that is not there. In the instruction composition order
the directive sits **after** the workspace persona + non-bypassable CORE and
**before** the per-session instructions, so host- and session-specific guidance
still refines it.

## Follow-Ups

- Approval v2: block on a durable human approval and resume the direct call after
  the decision.
- Results by reference: large tool outputs should be able to land in OpenGeni
  storage and return a reference instead of a giant inline JSON-RPC payload;
  investigate without preselecting a design in #536.
- Per-session Toolspace token pointers for shared sandbox groups, with a
  warm-manifest-compatible migration instead of changing an existing box's
  stable environment in place (#535).
- Distribute and discover `ogtool` independently of the stock sandbox image so
  custom rigs and connected machines can consume a release-coherent artifact
  (#537).
