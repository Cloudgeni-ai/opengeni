---
name: opengeni-client
audience: integration-agent
description: >-
  Integrate OpenGeni into an external product, website, backend, CLI, or
  automation. Defaults to embedding the full React conversation behind the
  packaged SDK session proxy. Use for discovery, connecting repositories and
  resources, SDK/API and React choices, implementation, verification, and
  handoff against a managed, self-hosted, or local OpenGeni deployment, including
  the agent's capabilities, identity and chat privacy. Not for
  changing OpenGeni internals or mounting its runtime inside the customer's
  process.
---

# OpenGeni Client

Use this skill when a customer's product and OpenGeni remain separate systems.
That is the normal integration shape: the product owns its users and business
UI, while a standalone OpenGeni deployment owns agent sessions and execution.

Do not confuse two meanings of "skill": this file teaches a customer's coding
agent how to integrate OpenGeni; session `skills` are runtime capabilities or
instructions attached to an OpenGeni agent. The former designs the integration.
The latter is product data sent through the installed SDK contract.

Code and the live service are authoritative. Prefer `/v1/config/client`,
`/v1/access/me`, the installed package types, and live probes over memorized
route, model, tool, or backend lists. When source is available, verify exact
behavior in `packages/sdk`, `packages/react`, contracts, and API routes.
Read `docs/product-integration.md` when the repository is available; it is the
canonical product boundary for organization keys, workspace mapping, and Skill
ownership.

Without repository access, start at https://docs.opengeni.ai/llms.txt and fetch
the relevant Markdown pages. Before replacing an AI provider, answering a cost
question, or reporting a setup blocker, read
[Compatibility and troubleshooting](references/compatibility-and-troubleshooting.md).

## Work Adaptively

This same guide is bundled as `builtin:opengeni-client` in ordinary OpenGeni
sessions and lives in `.agents/skills/opengeni-client` for external coding agents.
No Pack, installation, repository clone, or sandbox is needed to read the bundled
copy. It is guidance, not authority to access a repository, secret, or deployment.
Embedded products may narrow bundled guidance with `bundledSkillIds`.

- Inspect before you build. In the customer's repository: authentication,
  tenancy, data routes, frontend conventions, installed packages, tests, CI,
  deployment guidance, and any OpenGeni code already there. In OpenGeni:
  `getClientConfig()` (is `agentConfig.enabled`? which capabilities are
  offered?), the workspace's `settings.sessionAgentDefaults`, and an existing
  session's `agent` and `effectiveTools`. Only then ask questions or choose an
  integration shape.
- If the target repository or resources are missing, first inspect available
  authorized resources and connection/setup tools. Help the user connect or
  attach the specific missing source; explain the next action in product terms.
  Continue useful discovery without requesting broad credentials or pretending
  missing access is configured. Read
  [Discovery and autonomy](references/discovery-and-autonomy.md) for that workflow.
- Four choices belong to the user: who shares what (`chats`: private, shared
  or isolated), when things run (schedule and time zone), where outputs land
  (which screen, record, or channel), and whether the agent may write. If the
  request or repository does not settle any of them, ask ONE bundled question
  (the structured question UI when available) with a recommended answer for
  each, before building. This is the expected step, not an option: asking once
  is cheap, rebuilding is not. Never ask what the repository answers. See
  [Discovery and autonomy](references/discovery-and-autonomy.md).
- Use a reversible, clearly stated default only for choices outside those four,
  or when the user explicitly said not to ask. A busy user is not that signal.
- Match the requested delivery autonomy. Repository or cloud access is
  technical capability, not permission to push, deploy, merge, or change
  production.
- This Skill guides an implementation agent. Never copy it into the runtime
  Skills of the customer-facing agent.

## Default: the full conversation behind a packaged proxy

Default to OpenGeni's complete conversation experience: `OpenGeniProvider`,
`OpenGeniChat` (the user's chat list plus `SessionConversation`) from
`@opengeni/react/session-ui`, and `@opengeni/react/compiled.css` (brand it with
`--og-*` tokens). Import from `session-ui`, not the package root: the root also
exports the workbench, whose editors, terminal and desktop viewer are optional
peer dependencies your bundler would try to resolve. The UI is backed by the
normal session SDK through `createSessionProxyHandler`, a tenant/user-scoped
same-origin proxy on the product server with Next.js, Express, and Hono
adapters (other backends: see
[Proxy from any backend](references/proxy-from-any-backend.md)). It already
provides streaming, replay, queue, steer, approvals,
human input, attachments, and pause/resume. Deviate only when the product needs
a materially different interaction model, a non-React frontend, or compute
surfaces, and record why.

```ts
// Server only: the organization API key never reaches the browser.
import { OpenGeniClient } from "@opengeni/sdk";
import { createSessionProxyRoute } from "@opengeni/sdk/next";

const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!, // the deployment you target
  apiKey: process.env.OPENGENI_API_KEY!, // organization API key
});
const source = "acme-app"; // stable external-identity namespace

// 1. Onboarding, once per tenant and admitted user (persist workspace.id and operationId).
const { workspace } = await og.ensureWorkspace({
  accountId: process.env.OPENGENI_ORGANIZATION_ID!, externalSource: source,
  externalId: tenant.id, name: tenant.name,
});
await og.addExternalWorkspaceMember(workspace.id, {
  identity: { externalId: user.id, source },
  permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "mcp_servers:attach"], // attach: per-session mcpServers
  operationId,
});

// 2. The proxy, as a Next.js App Router catch-all: app/api/opengeni/[...path]/route.ts.
//    Express: toNodeMiddleware(createSessionProxyHandler(og, options)) from
//    "@opengeni/sdk/express"; Hono: toHonoHandler(...) from "@opengeni/sdk/hono".
const acme = (token: string) => ({ id: "acme", headers: { Authorization: `Bearer ${token}` } });
export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE } = createSessionProxyRoute(og, {
  chats: "private", // the default: each user's chats are theirs; "shared" | "isolated"
  resolve: async (request) => {
    const me = await authenticate(request); // the product's own session check
    return me
      ? { workspaceId: me.openGeniWorkspaceId, user: me.id, source }
      : new Response("Unauthorized", { status: 401 });
  },
  authorizeMutation: verifyCsrf, // the product's existing CSRF policy
  // New chats: the browser sends only the first message; the server picks the rest.
  createSession: async ({ initialMessage, idempotencyKey }, { user }) => ({
    initialMessage,
    idempotencyKey,
    agent: {
      identity: "You are Acme's support assistant. Friendly and brief.",
      capabilities: "none", // Acme's tools, asking questions, reading Skills; nothing else
    },
    skills: productSkills, // product-owned, inline
    mcpServers: [{ ...acme(await mintUserToken(user)), url: ACME_MCP_URL, allowedTools }],
    tools: [{ kind: "mcp", id: "acme" }], // a per-session server must also be selected here
    sandboxBackend: "none", // pure chat/tool agent: no sandbox to start or shell around tools
  }),
  // Every forwarded message: fresh per-user token and server-owned page context.
  beforeForwardMessage: async (_message, { user }) => ({
    mcpCredentialUpdates: [acme(await mintUserToken(user))],
    modelContext: `Today ${new Date().toISOString().slice(0, 10)}, time zone ${tz}`,
  }),
});
```

```tsx
// Browser: the unmodified SDK client, pointed at the mount.
import { OpenGeniClient } from "@opengeni/sdk";
import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });
<OpenGeniProvider client={client} workspaceId={workspaceId}>
  <OpenGeniChat /> {/* the user's chats (sidebar/drawer) + conversation */}
</OpenGeniProvider>;
```

`agent` needs the deployment's agent settings (`agentConfig.enabled` in the
client config); on an older or rollout-disabled deployment send
`firstPartyMcpTools: []` instead of `agent` and see
[Configure the agent](references/configure-the-agent.md).

For an assistant bound to one record (a ticket, a dashboard), create the session
server-side as the user (`og.asUser(user.id, { source }).createSession(...)`
with a stable `idempotencyKey`) and render `<SessionConversation sessionId>`.
The proxy calls `resolve` per request, acts only through `asUser`, pins the
workspace, and serves only provider/conversation routes; the chat list shows
only chats the user created (`sessionList: "visible"` widens it). Never replace the
proxy with a raw passthrough of arbitrary paths under the organization key.
Reset UI state when the user or tenant changes.

## Deliberate deviations

Choose one only for its stated reason; read
[Product shapes and UI](references/product-shapes-and-ui.md) first.

- **Headless React hooks** (`@opengeni/react/session`): the product needs a
  materially different interaction model but still wants canonical event,
  queue, composer, approval, and human-input behavior.
- **SDK only**: a non-React frontend (Svelte, Vue, native mobile), a CLI, or
  backend automation. Keep the SDK on a product backend route.
- **A non-JavaScript backend** (Django, Rails, Go, PHP, Java): keep the React
  conversation and implement the proxy's small HTTP contract in that backend
  instead of adding a Node sidecar. See
  [Proxy from any backend](references/proxy-from-any-backend.md).
- **Workbench**: the product genuinely exposes agent compute (changes, files,
  terminal, desktop). It has optional heavy peers.
- **Chat facade fallback** (`@opengeni/sdk/chat`): the product already has a
  chat UI speaking Vercel `useChat` or an OpenAI-shaped protocol, or a
  server-side bot needs `og.chat(...).send()`. It is a text-only projection:
  tool outputs are dropped, with no files, artifacts, images, goals, queue, or
  steer UI, and reopening restores only text. See
  [Chat facade fallback](references/chat-facade-fallback.md).
- **In-process embedding** of the OpenGeni runtime is infrastructure work; see
  the repo-maintainer `opengeni` skill and `docs/embedding.md`.

Verify delivery with representative product questions, checking useful answers
and actual tool execution, not just connectivity: see
[Integration configuration and verification](references/runtime-profile-and-verification.md).
Read selectively: [Product integration shapes](references/product-integration-shapes.md),
[API workflows](references/api-workflows.md),
[Isolation and authorization](references/isolation-and-authorization.md),
[Data tools and credentials](references/data-tools-and-credentials.md), and
[External users and embedded connection setup](references/external-users-and-connect.md).

## Configure The Agent

Every surface takes one `agent` object: `capabilities` (start from `"all"` or
`"none"`, then switch `webSearch`, `humanInput`, `skills`, `goals`,
`subagents`, `knowledge`, `schedules`, `artifacts`, `browser`, `media`,
`workspaceFiles`, `workspaceConnectors`, `workspaceAdmin`), `identity` (who the
agent is), `instructions` and `renderer` (`"opengeni"` for OpenGeni's React
components, `"markdown"` for your own UI). Pick capabilities from the product's
intent, not from tool names: a customer-facing assistant usually starts from
`"none"` plus what it needs; an internal operator agent from `"all"` minus what
it must not do. Set workspace defaults with `sessionAgentDefaults`, schedules
with `agentConfig.agent`, and change a running session with `updateSessionAgent`
(from its next turn). Check the result on `session.agent` and
`session.effectiveTools`. Read [Configure the agent](references/configure-the-agent.md)
before choosing; it also covers `chats`, the admission switch and error codes.

For per-seat included usage, administrator splits, top-ups, team budgets, or
browser progress meters, read [Usage allowances](references/usage-allowances.md).
Keep organization-budget writes on the backend; the conversation proxy exposes
only own usage. These are post-call ceilings, not prepaid reservations.

## Build Gotchas

- Always pass `baseUrl` (`process.env.OPENGENI_API_BASE_URL`); the chat facade
  otherwise targets production `app.opengeni.ai`. The SDK is ESM-only.
- A per-session `mcpServers` entry is usable only when also selected in
  `tools: [{ kind: "mcp", id, eager? }]`, and attaching it needs
  `mcp_servers:attach` for the acting user. MCP and OpenAPI spec URLs must be
  public HTTPS the deployment can reach; tunnel local servers (for example
  `cloudflared`).
- Install `@opengeni/sdk` and `@opengeni/react` from the same release. If the
  repository enforces a release-age policy (for example pnpm
  `minimumReleaseAge`), a just-published version may be refused: pin an older
  matching pair or ask before adding an exclusion; never bypass it silently.
- External member permissions cannot yet be edited in place (a re-grant with a
  new `operationId` conflicts, and the organization key cannot update the
  member). Grant the final set at onboarding; to change it, revoke
  (`cancelExternalWorkspaceMemberGrant`, which cancels that user's running
  turns) and re-add with a new `operationId`.
- `sandboxBackend: "none"` suits pure chat/tool agents: turns start in seconds
  instead of minutes, and there is no shell to route around the product's tools.
- For the smallest agent and prompt, see
  [Agent recipes](references/agent-recipes.md#minimal-agent).
- Stop in a chat UI is `pauseSession`: resumable, and messages sent while
  paused queue until `resumeSession`. `cancelSession` is terminal for the
  session and its children; never wire it to Stop.
- Background agents: use a scheduled task (`createScheduledTask`, with an
  explicit schedule and time zone), or an inbound automation webhook for
  events. Their agents reference a workspace OpenAPI Integration or MCP
  connection by id in `tools` (scheduled tasks take no inline `mcpServers`) and
  write results back through the product's own tools. On deployments with
  workspace integrations (check `/v1/config/client` and the SDK exports), a
  signed workspace webhook (`createWorkspaceWebhook`, verify with
  `verifyWebhookEvent`) tells the product when turns finish or need a person;
  treat it as an at-least-once, unordered signal and read the session (see
  `docs/workspace-integrations.md`).
- Advanced, not the default path: products that need background work with
  host-owned access can add a workspace credential provider (short-lived
  sandbox credentials, including Git) and recognize the calling turn from the
  informational `_meta.opengeni` on MCP calls. See
  `docs/workspace-integrations.md`.
- Organization integration administration, webhook reads and signing-secret
  rotation use functions imported from `@opengeni/sdk/workspace-integrations`,
  with `client` as the first argument. They are not eager client methods; see
  [Data tools and credentials](references/data-tools-and-credentials.md).

## Choose The Credential

- Use an **organization API key** when one server-side product integration
  provisions or manages many organization workspaces in one OpenGeni
  organization.
- Use a **workspace API key** when the integration is deliberately constrained
  to one organization workspace and should not provision others.
- Use a **delegated token** when the host acts with short-lived, explicit
  user/workspace authority rather than one standing product credential.
- A **deployment access key** is a coarse deployment perimeter. Never use it as
  tenant identity or infer organization/workspace authority from it.

## Default Trust Boundary

- Keep the organization API key and operator credentials on the product server.
- Authenticate the product's user first, resolve their allowed OpenGeni
  workspace/session server-side, and expose only the routes that product needs.
- Use `createSessionProxyHandler` for the React conversation, or
  `proxySessionEventStream` inside a custom same-origin SSE route.
- Direct browser access is valid only when the deployment's normal browser auth
  or an explicitly accepted bearer/CORS design makes it safe. Never ship a
  privileged shared API key in a browser bundle.

The product owns external identity, tenant-to-workspace mapping, business
entities, navigation, presentation, and product-specific admission. OpenGeni
owns sessions, turns, durable event history, approvals, agent execution,
selected tools/resources, files, realtime session state, and compute lifecycle.
Link records by opaque IDs; do not copy one system's whole data model into the
other.

## Organization And Workspace Bootstrap

Use one organization API key for the external backend (`createOrganizationApiKey`,
`listOrganizationApiKeys`, `deleteOrganizationApiKey`); the token is shown once,
so store it in the product's secret manager.

**A full-access organization API key is all the integration needs.** It creates
workspaces (`ensureWorkspace`, `workspaceIdFor`), adds external members, and
creates and controls sessions as those users (`asUser`). Do not judge it by
`/v1/access/me`'s `accountGrants` (`account:read`, `workspace:create`,
`api_keys:manage`) or its empty `workspaceGrants`: those list account-level
grants, not what the key may do inside shared workspaces. Check
`credential.access === "full"` and `credential.effectiveWorkspacePermissions`
instead; older deployments omit `credential`, so if it is missing, try the call
(`ensureWorkspace` is idempotent) rather than concluding the key is too weak.
Only an `access: "read"` key is limited, to reading.

For each chosen product sharing boundary, call `ensureWorkspace` /
`PUT /v1/workspaces/external` with a stable external mapping identity and persist
the returned `result.workspace.id`; `result.created` distinguishes the first
insert from an idempotent replay. Call it an **organization workspace** in
customer guidance; its exact wire kind is `"shared"`. Personal workspaces are
excluded and must never be selected through a default-workspace fallback.

Choose the workspace from who shares documents, workspace instructions,
Connections, and integrations: normally one per customer, and a separate one
when groups need different Connections, integrations, or instructions. When
each end user is their own boundary, a workspace per user (the user id as
`externalId`) called with the organization key alone is a valid, simpler
option; `chats: "isolated"` provisions exactly that per tenant user. Otherwise
use `asUser(externalId)` for the authenticated product user; the server derives
the canonical user, so never supply an `endUser` label as authority.

Choose chat privacy with `chats` on the proxy or facade: `"private"` (the
default: only the user sees their chats, the agent reaches only its own session,
Knowledge goes to the user's personal Knowledge), `"shared"` (the workspace sees
and shares them), or `"isolated"` (private, in a workspace per tenant user).
Private chats need the organization's private-session setting; without it the
SDK throws `OpenGeniSetupError` naming who can enable it. `chats` sets
`visibility`, `agentAccess` and `memoryScope`, which stay available as explicit
create fields; private sessions do not make workspace Files or Sites private,
and removing tools is not a substitute for private visibility. Unscoped
organization-key-created top-level sessions are workspace-visible. See
`references/external-users-and-connect.md`.

The external backend owns product Skills. Store and version them outside
OpenGeni, then pass the selected definitions inline in
`CreateSessionRequest.skills` for each product-created session. There is no
organization-wide Skill registry or Skill inheritance in this integration
contract.

`CreateSessionRequest.bundledSkillIds` narrows OpenGeni's bundled guidance
(omitted = defaults, `[]` = none); children, scheduled tasks, and automations
accept it too. It grants no tools and does not hide workspace or inline Skills.

New Skill inputs require valid `SKILL.md` frontmatter, which owns the name and
description. Do not replay old headerless Skills as new session input.

## Prompt And Context Contract

Use each prompt surface for its exact authority and lifetime:

- `agent.identity` (or the workspace's `sessionAgentDefaults.identity`): who the
  agent is. It replaces only OpenGeni's introduction; older workspaces may still
  carry this in `agentInstructions`.
- Workspace instructions (Knowledge > Instructions in the web app): stable
  workspace-wide rules.
- Session `instructions` (the same field as `agent.instructions`): durable
  refinement for one session. Instructions take priority over OpenGeni's
  default working style, never over its safety rules or how it runs tools.
- `modelContext`: ordinary model-visible content attached to one exact user
  message as a separate history part; standard timeline rendering omits it.
- `initialMessage` and later message text: the visible part of that user message.

`modelContext` is not secret or privileged; full event/audit reads return it.
Prefer concise per-message context plus authorized product tools over large
snapshots, and never move it into instructions.

## Client Workflow

1. Load the server-held organization API key; resolve the authenticated product
   tenant, call `ensureWorkspace`, and persist the opaque workspace mapping.
2. Read client config and access context without a Personal-workspace fallback.
3. Create sessions with an explicit `agent` (capabilities and identity chosen
   for the product), the product-selected inline Skills, a stable idempotency
   key (optionally a preallocated ID), canonical resources, and the product's
   own tools. Omitted `agent` inherits the workspace defaults, which are
   normally everything the workspace offers.
4. Serve the browser through the packaged proxy, or stream/replay through the
   SDK in a custom route; tolerate unknown additive event types.
5. Send visible text separately from `modelContext`; upload through the SDK
   helper, which owns begin, signed storage PUT, and completion.
6. Surface approvals, human-input requests, queue state, errors, credit limits,
   and reconnect state as product state rather than generic chat text.
7. Add realtime, Connected Machines, schedules, or the workbench only when the
   product use case needs them.

## Guardrails

- Workspace-scoped routes are canonical; resource IDs never authorize by
  themselves.
- Organization workspaces have wire `kind: "shared"`; Personal workspaces are
  outside the external product mapping.
- Knowledge settings and prompt instructions never create a tenant boundary;
  tool removal is defense in depth, not authorization.
- The SDK cannot accept arbitrary customer backend functions as remote tools.
  Expose an existing API through a reviewed OpenAPI/GraphQL Integration or an
  MCP server.
- OpenGeni's credential broker encrypts secrets and keeps them out of model
  context, but the trusted control plane can decrypt them for the authorized
  provider request. Do not describe it as zero knowledge.
- Do not call Temporal, NATS, Postgres, workers, sandbox providers, object
  storage APIs, or MCP transports as substitutes for the public SDK/API.
- Do not claim auth, model, tool, billing, CORS, storage, or compute behavior
  until the live deployment or current source proves it. Credentials come from
  a secret manager or environment, never from examples or Skills.
- Generate a customer-specific skill only for stable facts their coding agents
  repeatedly need. Keep it beside their integration code, point it at the SDK,
  include a config/access smoke probe, and never paste secrets into it.
  Start from `references/customer-skill-template.md` when the OpenGeni skill
  package is available.
