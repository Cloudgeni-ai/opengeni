# MCP surfaces — which one do you want?

Audience: integrators. OpenGeni touches the Model Context Protocol in six
places. They are different products with different owners and lifecycles; this
page exists so you pick the right one in one read.

| Surface | Who configures it | Scope / lifecycle | Credentials | Use it when |
| --- | --- | --- | --- | --- |
| **First-party OpenGeni MCP** (`/v1/workspaces/:id/mcp`) | Nobody — built in | Always available; tools mirror the REST API (session create/send/interrupt, packs, environments…) capped by the caller's grant | The caller's own bearer; internally delegated `ogd_` tokens per session | An AGENT (often a manager session) should orchestrate OpenGeni itself — spawn workers, steer sessions |
| **Toolspace MCP** (`/v1/workspaces/:id/mcp` with `toolspace:call` + exact attempt claims) | OpenGeni worker, when `OPENGENI_TOOLSPACE_ENABLED=true` | One exact running turn attempt; selected capability/per-session MCP tools, with first-party recursion targets excluded and approval-required tools non-callable | Narrow `ogd_` token written to a compute-target file; upstream MCP headers stay server-side | Sandbox or Connected Machine code needs to list/call the session's tools programmatically without a model round-trip |
| **Docs MCP** (`/mcp/docs`) | Nobody — built in | Always available | Caller's bearer | An agent should search the workspace's documents store |
| **Capability MCP servers** | Workspace admin (capabilities settings) | Workspace-wide; on for every session while enabled | Admin-supplied headers, encrypted, write-only | A third-party tool (e.g. a SaaS MCP) should be available to *all* sessions in a workspace |
| **Per-session MCP servers** (`mcpServers` on session create) | The embedding host, per session | One session; credentials rotatable on every user turn | Host-supplied headers, encrypted, write-only, `credentialVersion`-bumped | An embedding host injects its OWN tool server with per-session, short-lived bearers |
| **Codex Apps MCP** | Automatic for Codex-subscription runs | Per turn, only on the ChatGPT/Codex model path | Workspace's Codex tokens | You don't — it rides along with the Codex subscription provider |

First-party OpenGeni MCP memory tools:

- `memory_search` — search the workspace's shared long-lived memory with hybrid semantic + keyword retrieval.
- `memory_save` — save one durable, future-useful workspace memory through the deterministic write gate.
- `memory_correct` — archive or supersede an incorrect/outdated workspace memory by id.

GitHub recovery is also first-party and permission-scoped:

- `github_connect_link` returns a short-lived workspace-bound human install link.
- `github_credential_status` reports whether the exact session has a host-managed,
  automatically renewed repository binding, or a typed configure/connect/rebind
  action. It never returns a provider token; the old model-visible `github_token`
  surface is intentionally absent.

The memory tools are session-scoped: they register only when the delegated bearer
carries a worker-signed `sessionId` claim and the workspace's
`settings.memoryEnabled` setting is true. The REST/UI memory audit and seed
surfaces remain available when the setting is off. GitHub recovery is separately
gated by `github:use`; its credential-status tool additionally requires the
worker-signed session claim, while the connect-link tool remains workspace scoped.

Docs MCP also has a `memory_search`, but it is the curated documents surface, not
the first-party turn tool. It now reads both `active` and `approved` memory records
so the curated lane and Workspace Memory V1 share the same agent-visible set;
`memory_propose` still writes `proposed` records for human review.

## Toolspace attempt and catalog contract

The Toolspace bearer carries UUID `sessionId`, `turnId`, and `attemptId` claims,
a positive integer `executionGeneration`, subject `sandbox:<turnId>`, and only
the `toolspace:call` permission. The token expires after one hour, but expiry is
not its primary revocation boundary: the API locks and checks the exact DB turn
attempt before listing or dialing upstreams, atomically reserves each call
against that same attempt/generation, and fences audit events the same way. A
recovered, replaced, paused, or settled attempt receives an empty/unavailable
surface even while its signed token has time remaining.

Delivery is compute-target-neutral. Managed sandboxes and Connected Machines
receive the token off-manifest in `OPENGENI_TOOLSPACE_TOKEN_FILE`; Connected
Machines still receive no platform git or model credential. Arguments and
results are not copied into the audit timeline: events retain only redacted byte
size and SHA-256 summaries.

Tool discovery is deterministic and bounded rather than unbounded fan-out:

- runtime connects selected MCP servers in stable batches of eight, with at
  most 64 selected servers, and closes all earlier batches if a later strict
  batch fails;
- per-server and aggregate tool-list counts/bytes, individual tool schemas,
  inbound/outbound bodies, tool results, and lazy-search disclosure all have
  hard ceilings in `@opengeni/runtime/mcp-network`;
- Toolspace's bounded 30-second LRU is keyed by workspace, session, sorted
  selected server ids, and per-session credential versions; live allow-list
  and approval policy are rechecked before every call;
- Codex connector `tool_search` freezes its connected-source description once
  sources are discovered for a turn, preserving a byte-stable tool prefix for
  subsequent model calls while disclosing only bounded matching schemas.

Rules of thumb:

- Building a product **on top of** OpenGeni (embed or API)? Per-session MCP is
  your integration point for host tools; the first-party MCP is your agents'
  steering wheel.
- Giving **every** session in a workspace a tool? Capability MCP.
- Do not proxy one MCP surface through another, except the Toolspace path above:
  it is a deliberate server-side proxy through the first-party gate for a
  session-bound `toolspace:call` bearer.

Details: first-party tools and grants in [architecture.md](architecture.md),
per-session servers in [session-mcp-servers.md](session-mcp-servers.md),
workspace capabilities in [capabilities.md](capabilities.md), credential
handling in [credentials.md](credentials.md), and the full Toolspace design in
[design/toolspace.md](design/toolspace.md).
