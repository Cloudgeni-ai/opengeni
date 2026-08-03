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
| **Codex Apps MCP** | Deployment enables the registry; workspace-default or explicit session policy selects it | Workspace-default sessions receive it as an optional MCP; explicit/fixed sessions see it only when selected | Workspace's Codex tokens, resolved independently from visibility | A Codex-backed session should use connected ChatGPT apps without silently widening an exact tool allowlist |

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
runtime MCP; it does not bypass the durable session tool policy. Omitted
session tools use the workspace default and include it as optional. Explicit
and inherited-fixed policies remain exact. A usable Codex credential is
still required at call time, but authentication never changes which tools the
model is allowed to see.

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
  but it must not replay the current `tools/call`. The result is outcome-unknown
  and instructs the caller to verify provider state before any new attempt.
- Embedded hosts that already own provider connections should bind
  `ConnectionCredentialsPort.mcpCredentials` on both the API and worker. The
  host's connection remains authoritative; the sandbox bearer is never treated
  as a second GitHub/GitLab/Azure identity.

Details: first-party tools and grants in [architecture.md](architecture.md),
per-session servers in [session-mcp-servers.md](session-mcp-servers.md),
workspace capabilities in [capabilities.md](capabilities.md), credential
handling in [credentials.md](credentials.md), and the full Toolspace design in
[design/toolspace.md](design/toolspace.md).
