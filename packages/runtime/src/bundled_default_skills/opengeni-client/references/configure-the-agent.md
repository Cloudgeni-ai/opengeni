# Configure the agent

One `agent` object sets who the agent is and what it can do. The proxy's
`createSession` hook, `og.client.createSession`, scheduled tasks, and the chat
facade all accept it, and every session reports it back as `session.agent`.

```ts
agent: {
  identity: "You are Acme Analytics' assistant. You help customers read their dashboards.",
  instructions: "Lead with the number, then one sentence of context.",
  capabilities: { from: "none", webSearch: true, knowledge: true },
}
```

## Capabilities

Start from `"none"` (the session's own tools, asking the user, reading the
session's Skills) or `"all"` (everything the workspace offers; also what an
omitted `agent` gets), then switch single capabilities on or off. `"none"` adds
no Opengeni workspace tools, connectors, or bundled Opengeni guides, so it
needs no empty `tools`, `firstPartyMcpTools`, or `bundledSkillIds` lists.

| Capability            | Lets the agent                                          |
| --------------------- | ------------------------------------------------------- |
| `humanInput`          | ask the user a question (on in `"none"`)                |
| `skills`              | `"read"` Skills (default in `"none"`), or `"manage"`    |
| `webSearch`           | search the web                                          |
| `knowledge`           | search and save workspace Knowledge                     |
| `artifacts`           | publish files, documents, and Sites                     |
| `media`               | generate images and video                               |
| `goals`               | work toward a goal across many turns                    |
| `subagents`           | start and follow other sessions                         |
| `schedules`           | create scheduled tasks                                  |
| `browser`             | use a browser or desktop                                |
| `workspaceFiles`      | read files uploaded to the workspace                    |
| `workspaceConnectors` | use the workspace's connected apps and integrations     |
| `workspaceAdmin`      | manage workspace settings, variables, and machines      |

Tools you attach to the session (the proxy's `toolServer`, `mcpServers`,
integrations named in `tools`) stay available under `"none"`. Shell and file
tools come from the sandbox; `sandboxBackend: "none"` removes them.

A customer-facing assistant usually starts from `"none"` plus what it needs. An
internal operator agent usually starts from `"all"` minus what it must not do.

## Identity, instructions, renderer

- `identity` replaces only Opengeni's introduction: name, product, voice.
- `instructions` add rules. They outrank Opengeni's default style, never its
  safety rules.
- `renderer` defaults to `"opengeni"`, which suits `OpenGeniChat` and
  `SessionConversation`; set `"markdown"` for your own UI, Slack, or email.
- Per-message facts go in `modelContext`, not in instructions.

## Other places to set it

```ts
// Defaults for new sessions in a workspace.
await og.client.updateWorkspaceSettings(workspaceId, {
  sessionAgentDefaults: { capabilities: { from: "all", browser: false }, identity },
});

// A running session, from its next turn.
const session = await og.client.getSession(workspaceId, sessionId);
await og.client.updateSessionAgent(workspaceId, sessionId, {
  agent: { capabilities: { from: "all", webSearch: false } },
  expectedVersion: session.toolPolicyVersion, // 409 if it changed meanwhile
});
```

## Check the result

`session.agent` is the resolved configuration, including `unavailable`
capabilities. `session.effectiveTools.tools` lists every tool the agent can
use, each with its `capability`. Errors: 422 `agent_capability_unavailable`
(the deployment does not offer it), `agent_config_conflict` (contradictory
fields), and `agent_config_widening` (a child session asked for more than its
parent).
