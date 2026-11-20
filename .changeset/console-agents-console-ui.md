---
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Console has Agents and Tool servers pages for organizations with Console agents turned on. Owners and admins create an agent, edit its Instructions, model, built-in tools, tool servers (each tool on or off, "Ask first", and what happens to tools a server adds later), workers and where it is available, save drafts, try a draft in a test chat, compare versions, publish or roll back (optionally moving running chats), and see each chat's version and what it changed. Code-managed agents open read-only with "Managed by code"; an owner can move one to Console. "Export as YAML" downloads the agent file. In the app, the Agents page lists the workspace's organization agents read-only under "Managed in Console". `AgentsPage` takes an optional `after` slot, the SDK knows the `agents:read`, `agents:manage` and `tool_credentials:write` permissions, and the permission picker shows them under Agents.
