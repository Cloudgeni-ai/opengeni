# Configure the agent

One `agent` object says what an OpenGeni agent is and what it can do:
`capabilities`, `identity`, `instructions` and `renderer`. The same object is
accepted everywhere a session is created and is reported back on every
session. Chat privacy is a separate `chats` option on the session proxy and
the chat facade.

The examples below are compiled against the SDK in
`packages/sdk/test/agent-config-docs-examples.test.ts`.

## Inspect what exists first

Before you add or change any agent setting, read what the deployment,
workspace and product already do:

```ts
const config = await og.getClientConfig();
const admitted = config.agentConfig?.enabled === true; // false: send no `agent` yet
const offered = (config.agentConfig?.capabilities ?? [])
  .filter((capability) => capability.available)
  .map((capability) => capability.id);
const workspace = await og.getWorkspace(workspaceId);
const defaults = workspace.settings.sessionAgentDefaults; // absent: OpenGeni's defaults
const session = await og.getSession(workspaceId, sessionId);
// session.agent: the frozen configuration; null for sessions created before it.
// session.effectiveTools: what it can use, with up-front or on-demand visibility.
```

Also search the product's code for the older fields it already sends
(`firstPartyMcpTools`, `tools`, `instructions`, `visibility`, `agentAccess`,
`memoryScope`, `bundledSkillIds`). They keep working. Move to `agent` and
`chats` deliberately, one surface at a time, and check the result on
`session.agent` and `session.effectiveTools`.

If `admitted` is false the deployment has not turned agent settings on
(`OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED`). Any request with `agent` then
returns 422 `agent_config_not_enabled`. Do not work around it: use the older
fields (see [Agent recipes](agent-recipes.md#minimal-agent)) and tell the
deployment operator what the switch would give them.

## Capabilities

Start from `"all"` (everything this workspace offers, which is how sessions
without `agent` behave) or `"none"` (the session's own tools plus asking
questions and reading Skills), then switch single capabilities:

```ts
capabilities: "none";
capabilities: { from: "none", webSearch: true, knowledge: true };
capabilities: { from: "all", browser: false, workspaceAdmin: false };
```

| Capability | Lets the agent | In `"none"` |
| --- | --- | --- |
| `humanInput` | pause and ask the person for a decision or missing detail | on |
| `webSearch` | search the public web | off |
| `media` | generate images and videos | off |
| `goals` | work toward a goal across many turns | off |
| `subagents` | start, message and follow other sessions; list models | off |
| `skills` | `"read"`: read installed Skills; `"manage"`: also save, install, publish | `"read"` |
| `artifacts` | publish files, documents and Sites people can open | off |
| `browser` | use a browser or desktop computer | off |
| `schedules` | create and manage scheduled tasks | off |
| `knowledge` | search and save workspace Knowledge, task notes, instructions | off |
| `workspaceFiles` | read files uploaded to the workspace | off |
| `workspaceConnectors` | use the workspace's connected apps and integrations | off |
| `workspaceAdmin` | manage variable sets, projects, rigs, machines, connector setup | off |

Not capabilities, so never toggled:

- **The session's own tools.** MCP servers you attach to the session
  (`mcpServers` plus the same id in `tools`) and integrations you name in
  `tools` stay available under `"none"`.
- **Sandbox tools.** Shell, patching and image viewing come with an attached
  sandbox. `sandboxBackend: "none"` removes them.
- **Runtime mechanics.** Waiting for input, reading background commands and
  titling the session.
- **The tool search router.** It appears only when some tools are deferred.

A capability this deployment does not offer is reported off and listed in
`agent.unavailable`. Asking for it explicitly returns 422
`agent_capability_unavailable`. Deployment switches are the only hard limits;
workspaces set defaults, not caps.

## Identity and instructions

- `identity` (up to 8,000 characters) replaces only how OpenGeni introduces
  the agent: its name, product, domain and voice. `null` or omitted uses the
  workspace's default identity, then OpenGeni's.
- `instructions` is the same field as the session's `instructions` (send one
  of them; different values in both return 422 `agent_config_conflict`).

The prompt order is: identity, OpenGeni's working style, organization identity,
workspace instructions, session instructions. Product, workspace and session
instructions take priority over OpenGeni's default working style ("answer in
one sentence" wins), never over its safety rules or how it runs tools. There is
no option to replace the whole system prompt. Keep per-message facts in
`modelContext`, not in instructions.

## Renderer

- `"opengeni"`: for `OpenGeniChat` and `SessionConversation`. The agent may use
  `sandbox:` and `artifact:` links and inline visuals.
- `"markdown"`: for your own chat UI, Slack or email. The agent writes ordinary
  Markdown links only. The chat facade defaults to it.

## Chats: who sees and shares what

The session proxy and the chat facade take `chats`:

| `chats` | Human visibility | Agent reach | Knowledge written to | Workspace |
| --- | --- | --- | --- | --- |
| `"private"` | only the user | its own session | the user's personal Knowledge | the tenant's |
| `"shared"` | everyone in the workspace | the workspace | the workspace | the tenant's |
| `"isolated"` | only the user | its own session | the user's personal Knowledge | one per tenant user |

- The proxy defaults to `"private"`; the facade does too when it has a `user`.
  Explicit create fields (`visibility`, `agentAccess`, `memoryScope`) still win.
- Private chats need the organization's private-session setting. Without it
  the SDK throws `OpenGeniSetupError`, which says who can turn it on and where.
  Service-owned facade chats without a user should use `"shared"`.
- `"isolated"` needs the `OpenGeni` facade from `@opengeni/sdk/chat` as the
  proxy target and a `resolve` that returns `{ tenant, user }`. It provisions a
  separate workspace plus that user's membership:
  `og.workspaceIdFor({ tenant, user }, { isolation: "user" })`. The standalone
  resolver is `createWorkspaceIdResolver` from the server-only
  `@opengeni/sdk/tenant-workspaces` subpath.
  Initial member permissions allow workspace read, session create/read/control
  (including Send), file upload/read, and the host's per-session MCP attachment,
  with no admin permissions. `memberPermissions` on the facade constructor or
  resolver options replaces this list; it never updates existing or revoked
  memberships. The organization key must also allow each operation. Keep MCP
  URLs and credentials in the server's `createSession` hook.
  Existing users need an explicit `updateExternalWorkspaceMember` to gain new
  permissions. Returning a workspace address after an onboarding conflict or
  cancellation does not authorize the user; every `asUser` request checks live access.

`chats` is SDK sugar over `visibility`, `agentAccess` and `memoryScope`; the API
still authorizes each one.

## Where the agent object goes

```ts
// A session.
await og.createSession(workspaceId, {
  initialMessage,
  idempotencyKey,
  agent: {
    identity: "You are Acme Analytics' assistant. You help customers read their dashboards.",
    instructions: "Lead with the number, then one sentence of context.",
    capabilities: { from: "none", webSearch: true, knowledge: true },
    renderer: "opengeni",
  },
  sandboxBackend: "none",
});

// The proxy's createSession hook (the browser never chooses the agent).
createSession: async ({ initialMessage, idempotencyKey }, { user }) => ({
  initialMessage,
  idempotencyKey,
  agent: { identity, capabilities: "none" }, // only Acme's tools plus the essentials
  mcpServers: [{ ...acme(await mintUserToken(user)), url: ACME_MCP_URL }],
  tools: [{ kind: "mcp", id: "acme" }],
  sandboxBackend: "none",
}),

// The chat facade and its handler's resolve.
await og.chat({ tenant, user, conversation, chats: "private", agent: { identity, capabilities: "none" } });

// Defaults for new sessions in a workspace (null clears them).
await og.updateWorkspaceSettings(workspaceId, {
  sessionAgentDefaults: {
    capabilities: { from: "all", browser: false, workspaceAdmin: false },
    identity: "You are Acme's operations agent.",
  },
});

// A schedule: frozen with the schedule, used by every run.
await og.createScheduledTask(workspaceId, {
  name: "Morning digest",
  schedule: { type: "calendar", hour: 8, minute: 0, timeZone: "Europe/Oslo" },
  agentConfig: {
    prompt: "Summarize yesterday's new tickets and flag anything urgent.",
    agent: { capabilities: { from: "none", knowledge: true } },
    tools: [{ kind: "mcp", id: "acme" }],
  },
});

// A running session: applies from its next turn.
const current = await og.getSession(workspaceId, sessionId);
await og.updateSessionAgent(workspaceId, sessionId, {
  agent: { capabilities: { from: "all", webSearch: false } },
  expectedVersion: current.toolPolicyVersion, // 409 when someone changed it first
});
```

Rules the server enforces:

- Omitted `agent` uses the workspace's `sessionAgentDefaults` when set, and
  otherwise behaves like `"all"`. (Deployments with
  `OPENGENI_AGENT_CONFIG_DEFAULT_FOR_NEW_SESSIONS` record that as `"all"`;
  without it the session keeps the older, unrecorded behavior.)
- Child sessions inherit their parent's configuration and may only narrow it
  (422 `agent_config_widening`).
- A goal turns `goals` on; `goals: false` with a goal is 422
  `agent_config_conflict`.
- Older fields refine inside the capabilities. A `firstPartyMcpTools` entry or
  a `files`/`docs` entry in `tools` that belongs to a capability you turned off
  is 422 `agent_config_conflict`.
- Sessions created before agent settings keep exactly their old tools and
  prompt (`session.agent` is `null`). Updating one converts it, starting from
  what it can do now.

## Verify

Read response visibility from `session.tenancy?.visibility`, not
`session.visibility`. The top-level `visibility` field belongs to create
requests; the response's tenancy projection may be absent when private-session
support is unavailable. Absence means unknown, not `"workspace"`.

For a product-only background job, use both `firstPartyMcpTools: []` and
`firstPartyMcpPermissions: []` (see [Agent recipes](agent-recipes.md)). An
explicit empty permission ceiling is zero delegated OpenGeni authority, not a
default grant or a request to mint an empty token. Remote first-party MCP tools
are not prepared; requesting them or dedicated first-party `files`/`docs`
produces an `insufficient_scope` advisory and no executable catalog entry.
External-host MCP servers, host-owned local adapters, independent connections
and already-authorized native runtime mechanics retain their own authority.
Automation templates default omitted first-party arrays to `[]`; ordinary
sessions with undefined permissions retain their existing defaults. Never pad
the permissions merely to make startup succeed.

`effectiveTools.tools` is a flat list, not a capability-keyed object. Group it
locally if your UI needs capability sections:

```ts
import type { AgentEffectiveTools } from "@opengeni/sdk";

const session = await og.getSession(workspaceId, sessionId);
const visibility = session.tenancy?.visibility; // "private" | "workspace" | undefined
const byCapability = new Map<string, AgentEffectiveTools["tools"]>();
for (const tool of session.effectiveTools?.tools ?? []) {
  const group = byCapability.get(tool.capability) ?? [];
  group.push(tool);
  byCapability.set(tool.capability, group);
}
const knowledgeTools = byCapability.get("knowledge") ?? [];
```

An absent `effectiveTools` projection on an older session means the inventory is
unknown, not that every capability is off. Each tool's `visibility` means model
discovery (`"upfront"` or `"search"`), not who can see the session. Preserve it
when grouping. `mcpServers[].toolsKnown: false` means that server's schemas are
not known in this projection; do not invent tool names or treat it as disabled.

- `session.agent`: the resolved configuration, including `source` (request,
  workspace default, inherited, ...) and `unavailable`.
- The model-context inspector in the OpenGeni web app (session > Debug >
  Context) shows the instructions actually sent, split into titled sections.
