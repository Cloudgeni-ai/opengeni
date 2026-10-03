# Agent recipes

## Minimal agent

For a product agent that should only use the product's own tools, start from
`"none"` and close the remaining optional surfaces:

```ts
await og.asUser(user.id, { source }).createSession(workspaceId, {
  initialMessage,
  idempotencyKey,
  agent: {
    identity: "You are Acme's ticket assistant.",
    capabilities: { from: "none", humanInput: false, skills: false }, // Acme's tools only
  },
  mcpServers: [{ id: "acme", url: ACME_MCP_URL, allowedTools: ["get_ticket", "update_ticket"] }],
  tools: [{ kind: "mcp", id: "acme" }], // exactly the product's server
  bundledSkillIds: [], // no bundled OpenGeni guidance
  sandboxBackend: "none", // no sandbox, shell, or file tools
  agentLearning: { knowledge: "off", instructions: "off", skills: "off" },
});
```

The model then sees the Acme tools and the runtime mechanics (waiting for
input, titling), and the prompt has no text about goals, Knowledge, subagents
or repositories. `session.effectiveTools` lists exactly that; see
[Configure the agent](configure-the-agent.md).

On a deployment without agent settings (`agentConfig.enabled` is false in the
client config) the same request would be refused. Use the older fields there:
`firstPartyMcpTools: []` instead of `agent`, plus the workspace settings
`memoryEnabled: false` and `agentHumanInputEnabled: false`. Skill loading,
model listing and the model provider's native web search then still remain.
Omitting `tools` or `firstPartyMcpTools` inherits workspace and deployment
defaults.

Tool schemas are prompt cost: one run with 23 MCP tools spent about 35k input
tokens per turn. Trim with `allowedTools` on each server, and set
`eager: true` in `tools` only for a server the first request needs.

## Product-owned background job

Attribute automation to a service, not a fabricated human:

```ts
const job = og.asService("acme:reports", { jobId: jobRecord.id });
await job.createSession(workspaceId, {
  initialMessage: "Summarize the latest product report.",
  idempotencyKey: `reports:${jobRecord.id}`,
  skills: productSkills,
  tools: selectedProductTools,
  firstPartyMcpTools: [],
  bundledSkillIds: [],
});
```

The original `og` client remains unchanged. `asService` cannot chain with
`asUser` or `asLinkedUser`; it records non-secret attribution without granting
permissions or borrowing personal resources. Use a workspace-owned Connection
for background API/MCP access, or the product's signed workspace credential
provider for short-lived managed-sandbox Git/cloud material. See
[Data tools and credentials](data-tools-and-credentials.md).

`firstPartyMcpTools: []` narrows the broad first-party model-visible selection;
it does not set a zero permission ceiling. Public `createSession` rejects an
explicit `firstPartyMcpPermissions: []` with 422, including `asService` calls.
This recipe omits that override, preserving the top-level default worker
permission set (or inherited policy for a child), not zero authority. Any
intentional public permission override must be nonempty and within the
creator's grant; do not add permissions merely to make startup succeed.

Inbound automation `sessionTemplate` is a different boundary: both first-party
arrays default to `[]`, and explicit `[]` is supported. That empty effective
ceiling skips remote OpenGeni-delegated MCP preparation without a token or
endpoint request. Requested first-party tools or dedicated `files`/`docs` stay
unavailable with an `insufficient_scope` advisory. Product MCP servers,
independent connections, host-owned local adapters and already-authorized native
runtime mechanics keep their own authorization paths.

## Per-user tool tokens

On a Node backend that mounts `createSessionProxyHandler`, this is one option:
`toolServer: { url, approvals?: { ask: [...] } }` attaches the product's MCP
endpoint to every session the `createSession` hook creates, mints the
per-user token from the `resolve` result, and rotates it on every send, steer,
submit, approval, and answer. The endpoint calls `verifyToolRequest(request)`
from `@opengeni/sdk/tool-auth` and scopes every tool to the returned `user` and
`tenant`. See
[Data tools and credentials](data-tools-and-credentials.md#default-for-node-the-proxy-toolserver).

Without the Node proxy, give each session a short-lived per-user bearer and
rotate it on every message yourself:

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

Make the token outlive long agent work by default (hours, refreshed on every message); this is a default, never a question for the user. Header
rotation cannot change the server's URL or tools. Scheduled tasks cannot carry
inline `mcpServers`; background agents use a workspace MCP connection or
OpenAPI Integration instead.
