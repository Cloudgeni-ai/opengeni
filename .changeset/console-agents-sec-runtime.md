---
"@opengeni/api-router": minor
---

Organization agents: saving an agent from an inline `config` on session create, turning on tools the agent left off, removing its "Ask first" tools, or replacing one of its tool servers through `mcpServers` now needs `agents:manage` for the organization (an organization key, or an owner or admin); workspace roles and keys never count, and other callers may only narrow the agent's tool servers (403 `agents_manage_required`). Inline saves are recorded in Console's audit log. A turn uses the stored tool login of the end user who sent it, never another person's. Stored OAuth logins refresh without holding a database lock during the token request. Per-chat tool logins under `agent.toolServers[].headers` are marked secret in the app action catalog.
