# MCP surfaces — which one do you want?

Audience: integrators. OpenGeni touches the Model Context Protocol in seven
places. They are different products with different owners and lifecycles; this
page exists so you pick the right one in one read.

| Surface | Who configures it | Scope / lifecycle | Credentials | Use it when |
| --- | --- | --- | --- | --- |
| **First-party OpenGeni MCP** (`/v1/workspaces/:id/mcp`) | Embedding host selects tool names per session | Always attached; the model sees the session's exact catalog selection intersected with its authorization grant | The caller's own bearer; internally delegated `ogd_` tokens carry permissions and the separate tool-name selection | An agent should use selected OpenGeni-native orchestration or self-management tools |
| **Toolspace MCP** (`/v1/workspaces/:id/mcp` with `toolspace:call` + `sessionId`) | OpenGeni worker, when `OPENGENI_TOOLSPACE_ENABLED=true` | One running session turn; session-selected safe first-party tools plus selected capability/per-session MCP tools, minus approval-required tools | Narrow `ogd_` token written to a sandbox file; upstream credentials resolve server-side through the same standalone/host broker as normal MCP | Sandbox code needs to list/call the session's tools programmatically without a model round-trip |
| **Docs MCP** (`/mcp/docs`) | Nobody — built in | Built in; selected through the `docs` server ref | Caller's bearer | An agent should search the workspace's documents store |
| **Files MCP** (`/mcp/files`) | Nobody — built in | Default-on download-materialization surface selected through the `files` server ref; an explicit API policy may omit it | Caller's bearer with `files:read` | An agent needs a short-lived download URL for a ready file, including an original file identified by document search |
| **Capability MCP servers** | Workspace admin (capabilities settings) | Workspace-wide; on for every session while enabled | Admin-supplied headers, encrypted, write-only | A third-party tool (e.g. a SaaS MCP) should be available to *all* sessions in a workspace |
| **Per-session MCP servers** (`mcpServers` on session create) | The embedding host, per session | One session; static headers rotatable on every user turn; host connection refs resolved per request | Encrypted write-only headers or a non-secret opaque `connectionRef` resolved by the standalone/host broker | An embedding host injects its own tool server or binds an existing provider connection without duplicating it |
| **Codex Apps MCP** | Deployment enables the feature; a scoped human explicitly designates one workspace credential; session policy selects it | Available only while that exact designation remains authorized; workspace-default sessions receive it as optional, while explicit/fixed sessions see it only when selected | Only the designated Apps credential, independent of inference | A compatible model should use connected ChatGPT apps without tying their authority to inference routing or silently widening an exact tool allowlist |

First-party OpenGeni MCP memory tools:

- `memory_search` — search the workspace's shared long-lived memory with hybrid semantic + keyword retrieval.
- `memory_save` — save one durable, future-useful workspace memory through the deterministic write gate.
- `memory_correct` — archive or supersede an incorrect/outdated workspace memory by id.

These tools are session-scoped: they register only when the delegated bearer carries
a worker-signed `sessionId` claim and the workspace's `settings.memoryEnabled`
setting is true. The REST/UI memory audit and seed surfaces remain available when
the setting is off.

`CreateSessionRequest.firstPartyMcpTools` is an exact allowlist over the exported
`FIRST_PARTY_MCP_TOOL_NAMES` catalog. Omission selects the safe default catalog,
which excludes connector-wide `social_*` and `slack_bot_*` tools; those require
explicit selection plus their normal connection permission. Explicit `[]` means
no tools from the broad server. Unknown names fail validation. This field does
not grant authority: every catalog entry also has an explicit registration-time
permission predicate, and target-scoped authorization still runs on calls.
Child omission inherits the parent's exact effective selection.

GitHub App installation credentials are deliberately absent from this catalog.
Repository discovery and browser connect status remain model-visible, but token
minting and credential-file renewal stay host-side in the worker/runtime. No
first-party MCP, Toolspace, API, SDK, event, or audit projection returns a live
installation token to the model or sandbox command surface.

File and document resources are independent from this broad-server selection.
Attaching a resource still materializes it for the session when
`firstPartyMcpTools` is `[]` or title-only; selecting the dedicated `files` or
`docs` MCP server is a separate `tools` decision. Document search results carry
the backing `fileId`; reading an indexed chunk stays within Docs MCP, while
downloading the complete original uses Files MCP. Workspace-default policy
includes Files, but an explicit API/embedding policy may omit it.

Codex Apps follows that same separation. Enabling
`OPENGENI_CODEX_CONNECTED_APPS_ENABLED` registers `codex_apps` as a selectable
runtime MCP only for workspaces with one explicit, currently authorized Apps
credential designation; the flag alone exposes no executable tools. Omitted
session tools use the workspace default and include it as optional. Explicit and
inherited-fixed policies remain exact. A null designation means no Apps server
and there is no active-credential, pinned-credential, allocator, or static-header
fallback.

Inference and Apps authority are deliberately unrelated. The designated Apps
credential works with compatible Codex or non-Codex inference and remains usable
when every inference subscription is quota-exhausted, cooled down, allocator-
disabled, unpinned, or leased elsewhere. Only the current human owner of an
active connected credential may designate it, and that human must currently
hold `connections:write` (workspace-admin scope satisfies it). Any managed human
with that scope may clear the designation without owning the credential. Bearer,
agent, scheduled, and service identities cannot perform either mutation. Every
Apps request rechecks the exact designation, connection status, owner membership,
and owner permission immediately before resolving/sending credentials. Reconnect
never changes a credential's owner; disconnect clears the designation and audit
event atomically. Visibility still obeys the session tool policy independently.
Codex Apps is not proxied into Toolspace: its per-request designated-owner check
and connector-wire sanitizer remain on the direct model MCP path, so sandbox code
cannot accidentally receive a static or weaker version of the same authority.

### Codex Apps designation parity verdict

- **Pelle/MCP:** the designated credential powers the direct model MCP. There is
  deliberately no Pelle mutation tool for choosing or clearing a human-owned
  credential; those actions require a same-origin managed-human browser session.
- **Search and command navigation:** this workspace setting is not indexed domain
  content. The existing Workspace settings route is its navigation surface; no
  separate command-palette action is warranted.
- **Event spine:** designation, clear, and disconnect-clear write secret-free audit
  events in the same transaction. They do not create session-history events or
  notifications because they are workspace configuration, not conversation work.
- **Mobile:** there is no native OpenGeni administration surface. The responsive
  Workspace settings card is the supported mobile web surface.
- **Permissions and SDK:** REST and SDK mutations enforce the same
  `connections:write` managed-human boundary; enable additionally requires exact
  credential ownership, while disable does not.
- **Export and public links:** neither plane exposes credential selection or token
  material. Workspace state export remains unchanged.
- **Legal/processing scope:** this reuses the existing user-authorized ChatGPT
  connection and existing Apps destination. It adds no personal-data category,
  purpose, recipient, retention behavior, or additional owner field.

Docs MCP also has a `memory_search`, but it is the curated documents surface, not
the first-party turn tool. It now reads both `active` and `approved` memory records
so the curated lane and Workspace Memory V1 share the same agent-visible set;
`memory_propose` still writes `proposed` records for human review.

Rules of thumb:

- Building a product **on top of** OpenGeni (embed or API)? Per-session MCP is
  your integration point for host tools; the first-party MCP is your agents'
  steering wheel.
- Giving **every** session in a workspace a tool? Capability MCP.
- Do not proxy one MCP surface through another, except the Toolspace path above:
  it is a deliberate server-side proxy through the first-party gate for a
  session-bound `toolspace:call` bearer.
- A broker may refresh credentials after an upstream 401 for future requests,
  but it retries the current request only for the explicit replay-safe JSON-RPC
  allowlist: `initialize`, `notifications/initialized`, and `tools/list`.
  Malformed bodies, unknown extensions, non-list methods, and any batch with an
  unsafe entry return secret-free outcome-uncertain error `40102` without a
  second physical request and instruct the caller to verify provider state.
- Embedded hosts that already own provider connections should bind
  `ConnectionCredentialsPort.mcpCredentials` on both the API and worker. The
  host's connection remains authoritative; the sandbox bearer is never treated
  as a second GitHub/GitLab/Azure identity.

Details: first-party tools and grants in [architecture.md](architecture.md),
per-session servers in [session-mcp-servers.md](session-mcp-servers.md),
workspace capabilities in [capabilities.md](capabilities.md), credential
handling in [credentials.md](credentials.md), and the full Toolspace design in
[design/toolspace.md](design/toolspace.md).
