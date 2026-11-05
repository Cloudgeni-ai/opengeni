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
| `notifications`       | notify, call, and tidy the inbox of the user            |
| `privacyFacts`        | answer privacy questions from the deployment's facts    |
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

`"none"` pays only for what the session can use on every call. It gets a
neutral identity unless the session shares a workspace; `request_human_input`
offers the secret kind only with `secrets` and Skill reviews only with
`skills: "manage"`; `wait_for_input` comes only with a sandbox, `subagents`,
`goals`, `schedules`, `browser`, `media` or `workspaceAdmin` (a person needs no
wait: an answer resumes the turn), and Codemode guidance only with a sandbox or
`run_on`; tool search
only when a tool is deferred (list the product server with `eager: true`, not
`optional` and without a `connectionRef`, to avoid it); no Skill index without
Skills. Prompt sections follow their capability. Switch an item back on with
its capability, for example `{ from: "none", privacyFacts: true }`. Saved
workspace defaults and schedules keep notifications and privacy facts under
`"none"`. `getSessionModelContext` returns the latest request's provider body;
on the native Anthropic route it also lists the instructions and each tool.

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
