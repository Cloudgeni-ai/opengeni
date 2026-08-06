# Per-session MCP servers

OpenGeni supports third-party MCP servers attached to a single session. This is
for embedding hosts that need per-session tool endpoints and per-session bearer
credentials, without making those servers deployment-global.

## Contract

`CreateSessionRequest.mcpServers` accepts an array of:

- `id`: registry-id shape (`[A-Za-z0-9_-]+`), unique within the session and not
  colliding with built-ins, deployment MCP servers, or enabled capability MCPs.
- `name`: optional display name.
- `url`: HTTPS MCP endpoint.
- `allowedTools`, `timeoutMs`, `cacheToolsList`: same runtime meaning as
  deployment MCP server settings.
- `requireApproval`: `true` requires approval for every tool, `false` requires
  none, and a string array requires approval only for those unprefixed tool
  names. Selective policies are canonicalized as a sorted set and bounded to
  2,048 names, 256 KiB total UTF-8, and 1 KiB UTF-8 per name.
- `headers`: configured credential headers, authenticated-encrypted at rest.
- `connectionRef`: optional non-secret opaque connection pointer. Standalone
  deployments resolve it through OpenGeni's connection store; embedded hosts
  can resolve the same pointer through `ConnectionCredentialsPort.mcpCredentials`.

Session responses and session events expose only metadata:

```ts
{
  id: string;
  name: string | null;
  url: string;
  headerNames: string[];
  credentialVersion: number;
  requireApproval: boolean | string[];
  connectionRef: McpServerConnectionRef | null;
}
```

Create, list/get, session-event, and ordinary SDK/React projections expose only
metadata. The approved release-held follow-up adds a separate tenant-
scoped exact-plaintext operation requiring the owning resource permission plus
`secrets:read`, with metadata-only audit. That dedicated operation is not
implemented in the current emergency head and is never inferred from an
unrelated session response.

## Permission

Attaching a server at create time and rotating its credentials both require
`mcp_servers:attach`. `workspace:admin` implies it through the normal permission
composition. The worker's default first-party MCP permission set deliberately
does not include `mcp_servers:attach`, so a sandboxed agent cannot attach a new
credentialed server to itself.

An agent-created child is the bounded exception for an already-authorized
server snapshot. If `mcpServers` is omitted, the child copies its trusted
immediate parent's server definitions, policy, connection refs, and encrypted
headers without requiring `mcp_servers:attach`; the parent comes only from the
worker-signed grant and cannot be supplied in the request body. Explicit
`mcpServers`, including an explicit empty array, never inherit and go through the
ordinary attach permission check when non-empty. This delegates existing tool
context without letting a child invent an endpoint or plaintext credential.

### Approval-policy updates

An authorized host can replace one attached server's policy without recreating
the session:

```http
PATCH /v1/workspaces/:workspaceId/sessions/:sessionId/mcp-servers/:serverId/approval-policy
Content-Type: application/json

{ "requireApproval": ["create_record", "delete_record"] }
```

The route requires `sessions:control` and the
`session.mcp.approval_policy.write` session-authorization operation. The SDK
exposes `OpenGeniClient.updateSessionMcpApprovalPolicy`; React session embeds
can use `useSessionMcpApprovalPolicy`.

The response returns the updated safe server metadata and
`effectiveFrom: "next_attempt"`. The update and attempt claim serialize under
the session lock. A claimed attempt keeps the exact policy snapshot it started
with; the next attempt captures the new policy. The update never cancels,
restarts, or reinterprets current work. A small
`session.mcp.approval_policy.updated` event tells other clients to reload the
authoritative session metadata.

## Storage and rotation

Credential headers are encrypted in `session_mcp_servers.headers_encrypted` with
the same AES-GCM helper used by workspace variable sets. The deployment must set
`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` before accepting session MCP credentials;
otherwise create/rotation requests fail with 503.

`connection_ref` is non-secret JSON and does not require the encryption key by
itself. This lets an embedding host attach its existing GitHub, GitLab, Azure
DevOps, or other provider connection without copying a token or creating an
OpenGeni connection row. Opaque host ids are accepted; standalone connection
lookups still use their ordinary UUID ids. A session server may use static
headers, a connection ref, or neither.

Credentials rotate through a `user.message` payload:

```json
{
  "type": "user.message",
  "payload": {
    "text": "continue",
    "mcpCredentialUpdates": [
      { "id": "crm", "headers": { "X-Synthetic-Key": "synthetic-test-value" } }
    ]
  }
}
```

Rotation can only update headers for servers already attached to that session.
It cannot change URL, name, allowed tools, timeout, or cache behavior. Each
successful rotation replaces the encrypted header map and increments
`credentialVersion`.

The connection ref is likewise immutable for the session server. To switch an
endpoint to a different host connection, create a new session attachment rather
than treating credential rotation as a connection-rebinding operation.

## Connector action policy enforcement

Connection-backed MCP tools can additionally be governed by workspace
`connector_action_policies`. Each versioned row scopes one connection, server,
tool, and action (with `*` wildcards for server/tool/action) to `allow`, `ask`,
or `block`. Attempt claim copies a bounded, ordered policy snapshot into
`session_turn_attempts.connector_action_policies`; later policy edits affect a
new attempt only, except that an already-created Ask request keeps its original
decision across the approval-resume attempt.

Resolution is most-specific-first. Two matching policies with equal specificity
fail closed as Block. No matching row preserves the historical unmanaged
behavior. The connector decision composes monotonically with `requireApproval`:
Block stops before MCP invocation, Ask requires the ordinary durable approval,
and Allow never removes a session-level approval requirement.

Managed calls use `connector_action_requests` as an idempotency and evidence
ledger. It freezes the initiating actor, original attempt, connection/server/
tool identity, the matched attempt-frozen policy action selector (`*` for a
wildcard or ambiguous match), policy id/version/source, and a canonical SHA-256
action fingerprint. A caller-controlled `arguments.action` is used only
transiently for policy matching and is never copied into request or audit rows.
Approval records the authenticated approver separately. The execution attempt
is recorded when an approved request resumes. A repeated call after execution
began is marked outcome-uncertain and denied rather than sent to the provider
again. Audit rows contain only these bounded identifiers, decisions, timestamps,
fingerprints, and coarse outcomes—never raw arguments, headers, credentials,
request bodies, tool results, or response payloads.

Child inheritance is a create-time snapshot, not a live credential link. A
static encrypted header map is copied as ciphertext and starts at credential
version 1 on the child; future parent and child rotations are independent. A
copied `connectionRef` continues to resolve fresh request-time credentials and
is therefore the preferred embedding-host path for rotating provider access.

Rotation is effective on the next turn: the API validates updates up front, then
applies credential updates only after the session has accepted the `user.message`
inside the locked append transaction, before the event is appended and the turn
is queued. The worker loads the latest decrypted headers during turn preparation
immediately before `runtime.prepareTools`.

## Runtime path

`packages/core/src/domain/sessions.ts` validates create-time servers, rejects id
collisions, encrypts headers, persists the rows in the same transaction as the
session, and records only metadata in `session.created` events.

`acceptSessionUserMessage` validates `mcpCredentialUpdates` before posting the
new turn. The encrypted row update runs after the cancelled-session guard in the
same locked acceptance path, and only metadata is persisted in the `user.message`
event.

`apps/worker/src/activities/agent-turn.ts` overlays session MCP servers after
capability and Codex overlays, and before `runtime.prepareTools`. The worker-only
DB accessor decrypts headers for that run path, combines them with the exact
attempt's approval-policy snapshot, and carries the connection ref into the
runtime settings. Normal model MCP and Toolspace/Code Mode use that same
attempt-fenced configuration and request-time resolver, including forced refresh
after a 401. Normal session reads return only safe metadata and the non-secret
connection pointer.

For model MCP execution, the worker also supplies attempt-bound connector policy
hooks to the runtime. The runtime wraps converted MCP function tools and every
sandbox clone, evaluates approval before interruption, rechecks durable
admission immediately before invocation, and commits completion or uncertainty
afterward. This wrapper does not change tool selection, connector visibility,
Toolspace exclusion rules, or Slack interaction progress delivery.

## Dedicated-read invariant

Configured credential values and canonical arbitrary content follow different
paths:

1. Core treats typed create/rotation fields as configured-secret writes and
   atomically stores authenticated ciphertext plus metadata. It does not
   regex-scan or rewrite arbitrary messages, tool results, errors, or source
   content that happen to resemble headers or tokens.
2. Ordinary session/event/list projections contain credential references,
   header names, and versions, not a hidden masked substitute. The approved
   release-held follow-up adds a dedicated tenant-scoped secret read that returns
   exact plaintext only after the owning resource authorization plus
   `secrets:read` succeeds and its metadata-only audit record commits; it is not
   implemented in this emergency head.

Do not expose header values through unrelated API, event, log, span, or audit
paths. When the dedicated authorized read ships, do not weaken it by masking,
hashing, or rewriting the returned plaintext.
