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
- `headers`: write-only credential headers.
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
  connectionRef: McpServerConnectionRef | null;
}
```

Header values are never returned at create time, on list/get, in session events,
or through the SDK/React surfaces.

## Permission

Attaching a server at create time and rotating its credentials both require
`mcp_servers:attach`. `workspace:admin` implies it through the normal permission
composition. The worker's default first-party MCP permission set deliberately
does not include `mcp_servers:attach`, so a sandboxed agent cannot attach a new
credentialed server to itself.

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
      { "id": "crm", "headers": { "Authorization": "Bearer ..." } }
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
DB accessor decrypts headers for that run path and carries the connection ref
into the runtime settings. Normal model MCP and Toolspace/Code Mode then use the
same request-time resolver, including forced refresh after a 401. Normal session
reads return only safe metadata and the non-secret connection pointer.

## Never-return-values invariant

The no-value invariant has two layers:

1. Core converts raw create/rotation inputs into encrypted DB rows plus safe
   metadata before appending events or publishing.
2. The DB event sanitizer defensively strips `mcpServers[].headers`,
   `mcpServers[].headersEncrypted`, `mcpCredentialUpdates[].headers`, and
   `mcpCredentialUpdates[].headersEncrypted` to header names if a future path
   accidentally attempts to persist them.

Do not add API, event, log, span, or audit paths that expose header values.
