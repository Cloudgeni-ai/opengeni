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
server credentials, connection tokens, platform GitHub tokens, or direct
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

The TTL follows the turn-appropriate token policy used for the platform GitHub
token path. Delivery mirrors `OPENGENI_GIT_TOKEN_FILE`: the token value is
written into a sandbox file and the environment exposes only
`OPENGENI_TOOLSPACE_TOKEN_FILE` plus `OPENGENI_TOOLSPACE_URL`. The token value
must not appear in the sandbox manifest, env delta, event log, run state, or
logs.

When the flag is off, behavior is byte-identical to the current tree: no
permission is minted, no file path appears, no URL appears, and no toolspace
surface is added.

## Audit And Budgets

Toolspace calls emit the same `tool.call` and `tool.output` session events as
model-originated tool calls, attributed to the sandbox subject id from the
delegated token. Proxied third-party calls must publish these events even if the
worker path did not previously emit events for third-party MCP calls.

The API enforces a per-turn toolspace call budget, configured with a sane default
such as 200 calls per turn. Exhaustion returns an MCP-shaped typed error result
instead of throwing an HTTP 500 or leaking a partial proxy failure.

Gateway recursion is structurally impossible in v1: the token does not carry
token-minting permissions, the toolspace surface never includes token minting,
and `mcp_servers:attach` is not present.

## Security Invariants

- No escalation: `toolspace:call` admits only the toolspace MCP surface. REST
  routes and non-toolspace MCP tools still require their normal permissions.
- No cross-session access: the signed `sessionId` is mandatory and every
  persisted per-session server lookup includes `(workspaceId, sessionId)`.
- No credential exposure to the sandbox: third-party MCP headers are decrypted
  or broker-resolved only inside the API proxy path and are never returned to the
  sandbox.
- SSRF posture: proxy targets come only from validated persisted rows and
  enabled pack/capability refs, not from sandbox-supplied URLs.
- Human approval is not bypassed: approval-required tools are excluded or return
  the v1 typed error.
- Recursion is blocked: the surface does not include token minting, MCP server
  attachment, or session mutation beyond permissions explicitly held by the
  bearer.

## `ogtool`

The sandbox image carries a small dependency-light CLI, `ogtool`, that reads
`OPENGENI_TOOLSPACE_TOKEN_FILE` and `OPENGENI_TOOLSPACE_URL` and performs
`tools/list` and `tools/call` with JSON input/output. It is a convenience shim,
not a new API surface.

## Follow-Ups

- Approval v2: block on a durable human approval and resume the direct call after
  the decision.
- Results by reference: large tool outputs should be able to land in OpenGeni
  storage and return a reference instead of a giant inline JSON-RPC payload.
