# Agent recipes

## Minimal agent

For a product agent that should only use the product's own tools, create the
session with every optional surface closed:

```ts
await og.asUser(user.id, { source }).createSession(workspaceId, {
  initialMessage,
  idempotencyKey,
  mcpServers: [{ id: "acme", url: ACME_MCP_URL, allowedTools: ["get_ticket", "update_ticket"] }],
  tools: [{ kind: "mcp", id: "acme" }], // exactly the product's server
  firstPartyMcpTools: [], // no OpenGeni workspace/session tools
  bundledSkillIds: [], // no bundled OpenGeni guidance
  sandboxBackend: "none", // no sandbox, shell, or file tools
  agentLearning: { knowledge: "off", instructions: "off", skills: "off" },
});
```

Workspace settings close two more: `memoryEnabled: false` (Memory tools) and
`agentHumanInputEnabled: false` (structured questions). What always remains:
skill loading and model listing, plus the model provider's native web search
where the model supports it. Omitting `tools` or `firstPartyMcpTools` instead
of passing them inherits workspace and deployment defaults.

Tool schemas are prompt cost: one run with 23 MCP tools spent about 35k input
tokens per turn. Trim with `allowedTools` on each server, and set
`eager: true` in `tools` only for a server the first request needs.

## Per-user tool tokens

When the product's MCP server should act as the signed-in user, give each
session a short-lived per-user bearer and rotate it on every message:

1. Onboard the user with `mcp_servers:attach` among their permissions.
2. Create the session as that user with
   `mcpServers: [{ id, url, headers: { Authorization: "Bearer <token>" } }]`
   and the same `id` selected in `tools`.
3. In `createSessionProxyHandler`, return a fresh token from
   `beforeForwardMessage`:
   `{ mcpCredentialUpdates: [{ id, headers: { Authorization: "Bearer <new>" } }] }`.
   OpenGeni applies it atomically as the message is accepted; the browser can
   never send credential updates itself.
4. The MCP server validates the token and enforces the user's own permissions.

Make the token outlive one turn (agents can work for many minutes). Header
rotation cannot change the server's URL or tools. Scheduled tasks cannot carry
inline `mcpServers`; background agents use a workspace MCP connection or
OpenAPI Integration instead.
