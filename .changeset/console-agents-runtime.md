---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/observability": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Chats can run an organization (Console) agent. When Console agents are on for the organization, session create accepts `agent: "<key or id>"` or `agent: { ref, ... }`: the chat runs the agent's published version (a draft or `version` only in the organization's Console test workspace), its tool servers are attached as session MCP servers, and settings the request changes are recorded as `Session.orgAgent.overrides`; `agentOverrides: "reject"` refuses them with 422 `agent_override_rejected`. Inline `config` saves a version of a code-managed agent by config hash. Worker chats inherit the agent version, and its Instructions only when the version shares them. Turns resolve tool server logins from the credential provider, the end user's stored login (refreshed when it is about to expire) or the chat's own headers, never a shared key for per-user servers; a server without a login is attached as unavailable and the chat records `session.tool_server.unavailable`. A publish that moves running chats re-materializes each chat's tool servers on the new version and delivers its Instructions on the next turn. Chats that name no organization agent are unchanged.
