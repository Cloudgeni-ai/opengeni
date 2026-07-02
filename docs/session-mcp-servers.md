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

Session responses and session events expose only metadata:

```ts
{
  id: string;
  name: string | null;
  url: string;
  headerNames: string[];
  credentialVersion: number;
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
the same AES-GCM helper used by workspace environments. The deployment must set
`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` before accepting session MCP credentials;
otherwise create/rotation requests fail with 503.

Credentials rotate through a `user.message` payload:

```json
{
  "type": "user.message",
  "payload": {
    "text": "continue",
    "mcpCredentialUpdates": [
      { "id": "peloton", "headers": { "Authorization": "Bearer ..." } }
    ]
  }
}
```

Rotation can only update headers for servers already attached to that session.
It cannot change URL, name, allowed tools, timeout, or cache behavior. Each
successful rotation replaces the encrypted header map and increments
`credentialVersion`.

Rotation is effective on the next turn: the API applies credential updates before
the `user.message` event is appended and the turn is queued, and the worker loads
the latest decrypted headers during turn preparation immediately before
`runtime.prepareTools`.

## Runtime path

`packages/core/src/domain/sessions.ts` validates create-time servers, rejects id
collisions, encrypts headers, persists the rows in the same transaction as the
session, and records only metadata in `session.created` events.

`acceptSessionUserMessage` validates and applies `mcpCredentialUpdates` before
posting the new turn. It passes only metadata into the persisted `user.message`
event.

`apps/worker/src/activities/agent-turn.ts` overlays session MCP servers after
capability and Codex overlays, and before `runtime.prepareTools`. The worker-only
DB accessor decrypts headers for that run path; normal session reads return only
metadata.

## Never-return-values invariant

The no-value invariant has two layers:

1. Core converts raw create/rotation inputs into encrypted DB rows plus safe
   metadata before appending events or publishing.
2. The DB event sanitizer defensively strips `mcpServers[].headers`,
   `mcpServers[].headersEncrypted`, `mcpCredentialUpdates[].headers`, and
   `mcpCredentialUpdates[].headersEncrypted` to header names if a future path
   accidentally attempts to persist them.

Do not add API, event, log, span, or audit paths that expose header values.
