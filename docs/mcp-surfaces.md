# MCP surfaces — which one do you want?

Audience: integrators. OpenGeni touches the Model Context Protocol in six
places. They are different products with different owners and lifecycles; this
page exists so you pick the right one in one read.

| Surface | Who configures it | Scope / lifecycle | Credentials | Use it when |
| --- | --- | --- | --- | --- |
| **First-party OpenGeni MCP** (`/v1/workspaces/:id/mcp`) | Nobody — built in | Always available; tools mirror the REST API (session create/send/interrupt, packs, environments…) capped by the caller's grant | The caller's own bearer; internally delegated `ogd_` tokens per session | An AGENT (often a manager session) should orchestrate OpenGeni itself — spawn workers, steer sessions |
| **Toolspace MCP** (`/v1/workspaces/:id/mcp` with `toolspace:call` + `sessionId`) | OpenGeni worker, when `OPENGENI_TOOLSPACE_ENABLED=true` | One running session turn; session-selected safe first-party tools plus selected capability/per-session MCP tools, minus approval-required tools | Narrow `ogd_` token written to a sandbox file; upstream credentials resolve server-side through the same standalone/host broker as normal MCP | Sandbox code needs to list/call the session's tools programmatically without a model round-trip |
| **Docs MCP** (`/mcp/docs`) | Nobody — built in | Always available | Caller's bearer | An agent should search the workspace's documents store |
| **Capability MCP servers** | Workspace admin (capabilities settings) | Workspace-wide; on for every session while enabled | Admin-supplied headers, encrypted, write-only | A third-party tool (e.g. a SaaS MCP) should be available to *all* sessions in a workspace |
| **Per-session MCP servers** (`mcpServers` on session create) | The embedding host, per session | One session; static headers rotatable on every user turn; host connection refs resolved per request | Encrypted write-only headers or a non-secret opaque `connectionRef` resolved by the standalone/host broker | An embedding host injects its own tool server or binds an existing provider connection without duplicating it |
| **Codex Apps MCP** | Automatic for Codex-subscription runs | Per turn, only on the ChatGPT/Codex model path | Workspace's Codex tokens | You don't — it rides along with the Codex subscription provider |

First-party OpenGeni MCP memory tools:

- `memory_search` — search the workspace's shared long-lived memory with hybrid semantic + keyword retrieval.
- `memory_save` — save one durable, future-useful workspace memory through the deterministic write gate.
- `memory_correct` — archive or supersede an incorrect/outdated workspace memory by id.

These tools are session-scoped: they register only when the delegated bearer carries
a worker-signed `sessionId` claim and the workspace's `settings.memoryEnabled`
setting is true. The REST/UI memory audit and seed surfaces remain available when
the setting is off.

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
- Embedded hosts that already own provider connections should bind
  `ConnectionCredentialsPort.mcpCredentials` on both the API and worker. The
  host's connection remains authoritative; the sandbox bearer is never treated
  as a second GitHub/GitLab/Azure identity.

Details: first-party tools and grants in [architecture.md](architecture.md),
per-session servers in [session-mcp-servers.md](session-mcp-servers.md),
workspace capabilities in [capabilities.md](capabilities.md), credential
handling in [credentials.md](credentials.md), and the full Toolspace design in
[design/toolspace.md](design/toolspace.md).
