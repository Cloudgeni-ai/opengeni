# MCP surfaces — which one do you want?

Audience: integrators. OpenGeni touches the Model Context Protocol in five
places. They are different products with different owners and lifecycles; this
page exists so you pick the right one in one read.

| Surface | Who configures it | Scope / lifecycle | Credentials | Use it when |
| --- | --- | --- | --- | --- |
| **First-party OpenGeni MCP** (`/v1/workspaces/:id/mcp`) | Nobody — built in | Always available; tools mirror the REST API (session create/send/interrupt, packs, environments…) capped by the caller's grant | The caller's own bearer; internally delegated `ogd_` tokens per session | An AGENT (often a manager session) should orchestrate OpenGeni itself — spawn workers, steer sessions |
| **Docs MCP** (`/mcp/docs`) | Nobody — built in | Always available | Caller's bearer | An agent should search the workspace's documents store |
| **Capability MCP servers** | Workspace admin (capabilities settings) | Workspace-wide; on for every session while enabled | Admin-supplied headers, encrypted, write-only | A third-party tool (e.g. a SaaS MCP) should be available to *all* sessions in a workspace |
| **Per-session MCP servers** (`mcpServers` on session create) | The embedding host, per session | One session; credentials rotatable on every user turn | Host-supplied headers, encrypted, write-only, `credentialVersion`-bumped | An embedding host injects its OWN tool server with per-session, short-lived bearers |
| **Codex Apps MCP** | Automatic for Codex-subscription runs | Per turn, only on the ChatGPT/Codex model path | Workspace's Codex tokens | You don't — it rides along with the Codex subscription provider |

Rules of thumb:

- Building a product **on top of** OpenGeni (embed or API)? Per-session MCP is
  your integration point for host tools; the first-party MCP is your agents'
  steering wheel.
- Giving **every** session in a workspace a tool? Capability MCP.
- Never proxy one MCP surface through another — each is already reachable where
  it is needed (API-side for callers, worker-side for the running agent).

Details: first-party tools and grants in [architecture.md](architecture.md),
per-session servers in [session-mcp-servers.md](session-mcp-servers.md),
workspace capabilities in [capabilities.md](capabilities.md), credential
handling in [credentials.md](credentials.md).
