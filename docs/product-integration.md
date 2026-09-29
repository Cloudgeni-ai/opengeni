# Product integration

Audience: product teams integrating a standalone OpenGeni deployment through
`@opengeni/sdk` or `@opengeni/react`.

OpenGeni should normally remain a service behind the product backend. The
product owns its users, tenant admission, business data, navigation, and Skill
catalog. OpenGeni owns durable agent sessions, turns, events, approvals, files,
tools, and execution.

The canonical server-side integration uses:

- one **organization API key** held only by the external backend;
- one OpenGeni **organization workspace** for each smallest product group that
  may share workspace-scoped agent authority and resources;
- workspace-scoped session and file APIs after the backend resolves that
  mapping; and
- inline session Skills loaded from the external backend's own Skill store.

An organization workspace has wire `kind: "shared"`. Use “organization
workspace" in customer-facing integration guidance; `shared` is the exact wire
value. Personal workspaces are excluded from this service-provisioning model.
The separate verified `asUser` lane can access its own provisioned Personal
workspace; an unscoped service key cannot. See the external-user section below.

The repository Skill `.agents/skills/opengeni-client` guides the coding agent
that builds this integration, not the resulting product chatbot. Use it in the
implementation session; never attach implementation guidance to customer-facing
runtime sessions. The product continues to own its own session Skill catalog.
When a create uses an idempotency key, its ordered `installedSkillIds`
selection is immutable: a retry may repeat it exactly, but changing or removing
the selection conflicts instead of replaying a differently configured session.

## Default integration: the full conversation

The default is OpenGeni's complete conversation experience inside the product:
`@opengeni/react`'s `SessionConversation` (plus `@opengeni/react/compiled.css`,
branded with `--og-*` tokens), backed by the normal session SDK through
`createSessionProxyHandler`, a tenant/user-scoped same-origin proxy on the
product server. Streaming, replay, queue, steer, approvals, structured human
input, attachments, and pause/resume all work without a hand-written proxy.
Deviate only when the product needs a materially different interaction model
(headless `@opengeni/react/session` hooks), a non-React frontend (SDK only), or
compute surfaces (the workbench); see
[Browser and React integration](#browser-and-react-integration).

```bash
bun add @opengeni/sdk @opengeni/react
```

```ts
// Server only: the organization API key never reaches the browser.
import { OpenGeniClient, createSessionProxyHandler } from "@opengeni/sdk";

const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!, // the deployment you target
  apiKey: process.env.OPENGENI_API_KEY!, // organization API key
});
const source = "acme-app"; // stable external-identity namespace

// 1. Onboarding, once per tenant and per admitted user. Persist the workspace id.
const { workspace } = await og.ensureWorkspace({
  accountId: process.env.OPENGENI_ORGANIZATION_ID!,
  externalSource: source,
  externalId: tenant.id,
  name: tenant.name,
});
await og.addExternalWorkspaceMember(workspace.id, {
  identity: { externalId: user.id, source },
  permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read"],
  operationId, // stored before the call, so retries are safe
});

// 2. The server creates sessions: explicit tools, stable idempotency key.
const session = await og.asUser(user.id, { source }).createSession(workspace.id, {
  initialMessage: `Help me with ticket ${ticket.id}`,
  idempotencyKey: `ticket:${ticket.id}:${user.id}`,
  skills: productSkills,
  tools: [{ kind: "mcp", id: "acme" }],
  firstPartyMcpTools: [],
  sandboxBackend: "none", // pure chat/tool agent: no sandbox to start
});

// 3. Mount at /api/opengeni/* (Next.js route handler, Hono, Bun.serve, workers).
export const handler = createSessionProxyHandler(og, {
  resolve: async (request) => {
    const me = await authenticate(request);
    return me
      ? { workspaceId: me.openGeniWorkspaceId, user: me.id, source }
      : new Response("Unauthorized", { status: 401 });
  },
  authorizeMutation: verifyCsrf, // the product's existing CSRF policy
});
```

```tsx
// Browser: the unmodified SDK client, pointed at the mount.
import { OpenGeniClient } from "@opengeni/sdk";
import { OpenGeniProvider, SessionConversation } from "@opengeni/react";
import "@opengeni/react/compiled.css";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });
<OpenGeniProvider client={client} workspaceId={workspaceId}>
  <SessionConversation sessionId={session.id} />
</OpenGeniProvider>;
```

The proxy calls `resolve` on every request and acts only through
`asUser(user, { source })`; there is no fallback to the key's service
authority. It rejects any workspace other than the resolved one and serves only
the native routes `OpenGeniProvider` and the conversation use: client config;
workspace read, model catalog, live control stream, and workspace Resume;
session read and rename, event list and SSE (with `Last-Event-ID` resume),
send, steer, approval and human-input responses, queue, composer draft,
pause/resume, and (unless `files: false`) attachment upload and download URLs.
Every other route or method is a 404 (cancel and workspace Pause are refused);
unknown query parameters on served reads pass through for newer browser SDKs. Browser session creation is off unless the server
supplies `createSession`; the browser may then send only `initialMessage` and
`idempotencyKey`, and the hook returns the complete request, so tools, MCP
servers, Skills, instructions, and model policy stay server-chosen. Bodies are
bounded (`maxBodyBytes`, default 1 MiB), cannot rotate MCP credentials, and may
attach only files; `modelSelection: false` removes per-message model choices
and `authorizeSession` adds a product-level session check. Without
`authorizeMutation` only cross-site mutations (by `Sec-Fetch-Site`) are
refused, so cookie-authenticated products should pass their CSRF check.

The permissions above cover the conversation; drop `files:*` without
attachments. Membership is granted only by explicit onboarding: the proxy and
`asUser` never grant or restore it, and without it the API answers 403. Pass an
`operationId` you store first to make onboarding retries safe; see
[external membership operations](external-membership-operations.md). To map
tenants lazily, pass the `OpenGeni` facade from `@opengeni/sdk/chat` instead of
a client and return `{ tenant, user }` from `resolve`.

### Pick the privacy and memory of each session

Every session lives in the customer's one workspace, so all of them share that
customer's documents, workspace instructions, Connections, and integrations.
Two per-session create options decide what the agent may reach beyond its own
conversation:

| Scenario | `agentAccess` | `memoryScope` |
| --- | --- | --- |
| Support desk: each agent stays in its session tree | `"session"` | `"off"` |
| One customer's agents may reach that same user's sessions | `"user"` with authenticated `asUser` identity | `"user"` |
| A team that collaborates across sessions | `"workspace"` (raw create default) | `"workspace"` |
| Any of the above with Knowledge authoring initially Off | any | `"off"` |

`agentAccess` is enforced for agents in the single session-authorization seam:
a session's own tree (its children and their children) is always reachable,
peers are reachable when the caller's task scope and ordinary target authorization
allow it. Target task scope adds no incoming restriction. `memoryScope` selects
Knowledge authoring scope: personal entries use the verified user of the active
turn, not an arbitrary product label or the person who first created a shared
conversation. Use task notes for temporary conversation-tree coordination.
There is no active session Memory scope. The organization API key authenticates
the `asUser()` assertion; the server derives canonical identity, and children
inherit and may only narrow agent reach and Memory mode.

Human visibility is a separate axis: use `visibility: "user_private"` with
verified owning-user authority when other humans must not see the transcript.
Workspace-shared conversations remain accessible to their authorized members.
Use the same OpenGeni session ID for collaborators; identity must not change the
conversation address. See [Choose the credential boundary](#choose-the-credential-boundary).

### Chat facade fallback

`@opengeni/sdk/chat`'s `createChatHandler` is a fallback, not the default. Use
it only when the product already has a chat UI speaking Vercel `useChat` or an
OpenAI-shaped protocol and wants a compatible drop-in backend that reuses that
UI, or for server-side bots through `og.chat(...).send()`. It is a text-only
projection: tool outputs are dropped (the Vercel adapter emits only
`output: { status }`), there are no files, attachments, artifacts, or images,
no goals, queue, or steer UI, and reopening restores only a text snapshot.

```ts
import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

const og = new OpenGeni({
  baseUrl: process.env.OPENGENI_API_BASE_URL!, // omitted = production app.opengeni.ai
  apiKey: process.env.OPENGENI_API_KEY!,
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
});

export const POST = createChatHandler(og, {
  resolve: async (request) => {
    const me = await authenticate(request);
    if (!me) return new Response("Unauthorized", { status: 401 });
    return { tenant: me.accountId, user: me.userId };
  },
  format: "vercel", // or "openai-chat" / "openai-responses"; default streams native chunks
});

const chat = await og.chat({ tenant: "acme", user: "u_42", conversation: "c_9" });
const reply = await chat.send("What did we decide about the invoice?");
```

`tenant` becomes one organization workspace through `ensureWorkspace`,
`conversation` one deterministic session created on the first message, and the
same explicit onboarding is required for `user`. The facade defaults to
`agentAccess: "session"` and its `memory` option maps to `memoryScope`. The
adapters send only the latest user message and import earlier messages once as
context on the first message; after that OpenGeni owns the history. Reopen
legacy user-namespaced conversations with `chatBySessionId`. `og.client`,
`chat.workspaceId`, and `chat.sessionId` address the same session through the
full client, so `SessionConversation` can take over without a migration. The
runnable [chat quickstart example](../examples/chat-quickstart) is one backend
server file.

## Boundary and ownership

```text
product browser / mobile client
             |
             | product session and tenant-safe routes
             v
external product backend
  - authenticates product users
  - maps product tenant -> OpenGeni workspace id
  - stores the organization API key
  - stores/version-controls product Skills
             |
             | @opengeni/sdk
             v
standalone OpenGeni API
  - organization workspaces
  - sessions, turns, events, files, tools, execution
```

The browser should normally call same-origin product routes. The backend must
authenticate the product user, resolve the allowed product tenant, load the
corresponding OpenGeni workspace id, and reject caller-supplied workspace or
session ids that do not match that relationship.

Do not expose the organization API key to browser bundles, mobile apps, MCP
tool output, prompts, logs, or generated Skills. A short-lived signed storage
URL returned by the upload flow is scoped file-transfer authority; it is not an
OpenGeni API credential.

## Choose the isolation unit first

The workspace is the unit that shares documents, workspace instructions,
Connections, and integrations. Session isolation inside it is a per-session
setting, so the default is one workspace per customer:

| Product rule | Default OpenGeni mapping |
| --- | --- |
| Everyone in one product tenant may collaborate across chats | One workspace per tenant, `agentAccess: "workspace"` |
| Each user's chats must be private from other users | One workspace per tenant, `asUser()` and `visibility: "user_private"`; choose agent reach separately |
| Every chat must be isolated, including from the same user's other chats | One workspace per tenant, `agentAccess: "session"` |
| Several users access the same upstream data but their chats are private | One workspace per tenant; shared data lives there, chats use `visibility: "user_private"` |
| Groups need different Connections, integrations, or workspace instructions | One workspace per group |

This is an agent-authority decision, not only a UI visibility decision. A live
agent attempt may read, message, and control another session in the same
workspace only when the caller's `agentAccess` and target resource authorization allow it; the seam in
`packages/core/src/session-authorization.ts` enforces outbound-only task scope,
always allows a session's own tree, and filters `sessions_list` and the session
list routes the same way. Agent learning Off prevents Knowledge authoring while
existing authorized retrieval remains available. The compatibility `memoryScope`
field selects personal or workspace authoring; `off` initializes authoring to Off.

A top-level session created by an unscoped organization service key is
`workspace_shared`. The owning-user `user_private` / **Only me** capability
requires verified native-cookie or external `asUser` provenance, plus the
existing platform/organization readiness policy. An unscoped service key cannot
claim that provenance. External identity admission does not create an OpenGeni
login. Broader personal-resource and durable external execution guarantees must
be verified separately from core private-session access.

An organization-admin backend may read and update
`/v1/organizations/:organizationId/private-session-settings` with its organization
key (`workspace:admin`), without a browser login or synthetic membership. Enabling
the setting still requires platform readiness. Updates require `expectedVersion`
and `operationId`; retries preserve their result and recheck live key authority.
This product setting grants no private-session access: create and use sessions
through the intended user's `asUser` context.

`firstPartyMcpTools` and `firstPartyMcpPermissions` still narrow what a session
can do, and narrowing is monotone: a child session, an agent updating its own
tool policy, a scheduled task created by an agent, and the Codemode SDK proxy
can never widen tools, permissions, `agentAccess`, canonical scope identity, or `memoryScope`
beyond the creating session. Omitting `firstPartyMcpTools` inherits the
deployment's non-connector default catalog, and omitting `tools` inherits
workspace MCP defaults; explicit empty arrays suppress those respective
selections.

Creating a workspace does not create a dedicated cluster or permanently
running sandbox. It adds control-plane state and may require per-workspace
settings, Connections, and Integration installations. Provisioning hundreds of
workspaces is therefore reasonable, but a per-chat design needs automated
reconciliation and cleanup rather than repeated manual setup.

## Choose the credential boundary

| Credential | Use it when | Do not use it for |
| --- | --- | --- |
| Organization API key | One server-side product integration provisions or manages many organization workspaces in one organization | Browser/mobile clients or Personal workspaces |
| Organization API key with `access: "read"` | A reporting, audit, or analytics backend that must read every shared workspace's sessions and transcripts and nothing else | Creating sessions, controlling turns, or minting keys |
| Workspace API key | One backend or automation is deliberately constrained to a single organization workspace | Multi-workspace provisioning or organization administration |
| Delegated token | A host acts with short-lived, explicit user/workspace authority | A standing multi-tenant backend credential |
| Deployment access key | An operator needs a coarse configured/self-hosted deployment perimeter | Tenant identity, account selection, or workspace authorization |

An organization API key is the default for the product shape on this page.
Choosing it does not remove the product backend's obligation to authenticate
its own users and resolve their allowed tenant before every proxy call.

Either organization key reads every shared workspace in the organization. To
read all transcripts without touching each workspace, call
`listOrganizationSessions(organizationId, { limit, cursor, scopeSubjectId?, status? })`
or iterate `iterateOrganizationSessions`; the route is
`GET /v1/organizations/:organizationId/sessions`, every row carries its
`workspaceId`, and events are then read through the ordinary workspace routes.
Personal workspaces and managed-human **Only me** sessions are never included.
Mint the narrower key with `createOrganizationApiKey(organizationId, { name, access: "read" })`.

## Canonical provisioning flow

### 1. Create and store an organization API key

Organization API-key administration uses the organization control plane:

| Operation | SDK method | Route |
| --- | --- | --- |
| List keys | `listOrganizationApiKeys` | `GET /v1/organizations/:organizationId/api-keys` |
| Create a key | `createOrganizationApiKey` | `POST /v1/organizations/:organizationId/api-keys` |
| Revoke a key | `deleteOrganizationApiKey` | `DELETE /v1/organizations/:organizationId/api-keys/:apiKeyId` |

The create response returns the token once. Store it in the product's secret
manager and persist only non-secret key metadata in ordinary application data.
Rotate by creating the replacement, switching backend traffic, and then
revoking the old key. Do not use the legacy workspace-scoped API-key routes for
a new multi-workspace product integration.

Upgrades that introduce explicit organization-key provenance revoke ambiguous
historical null-workspace keys. If an integration predates the organization
API-key control plane, create a new organization key through the route above,
replace the stored backend secret, and discard the legacy token.

Organization keys have one fixed scope: `account:read`, `workspace:create`,
`workspace:read`, `workspace:admin`, and `api_keys:manage`. Workspace admin
implies ordinary workspace operations but not the literal `secrets:read`
permission. `api_keys:manage` also permits issuing narrower workspace keys when
an integration component should be constrained to one tenant workspace. Those
child keys cannot receive account, member, workspace-creation, billing, or
plaintext-secret permissions that the workspace grant does not literally hold.

### 2. Ensure an organization workspace

For each product tenant, user, chat, project, or other chosen isolation
boundary, call:

| Operation | SDK method | Route |
| --- | --- | --- |
| Idempotently resolve or create the mapped workspace | `ensureWorkspace` | `PUT /v1/workspaces/external` |

Use a stable external source/id pair from the product, not a display name, as
the idempotent mapping identity. The returned workspace is an organization
workspace and therefore has wire `kind: "shared"`. Persist the returned opaque
workspace id beside the product tenant record so later session requests do not
depend on a name lookup.

`ensureWorkspace` never selects, returns, or creates a Personal workspace.
Personal workspaces belong to individual native or external identities and are
not product tenant containers. Only an authenticated owning-user lane can use
its exact Personal pointer. Do not use `/v1/access/me`'s personal/default
workspace as a fallback for an unscoped service integration.

A server-side setup flow has this shape; use the request types exported by the
installed SDK as the exact schema authority:

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

const organizationId = process.env.OPENGENI_ORGANIZATION_ID!;
const { workspace, created } = await client.ensureWorkspace({
  accountId: organizationId,
  externalSource: "acme-product",
  externalId: productBoundary.id,
  name: productBoundary.displayName,
});

if (workspace.kind !== "shared") {
  throw new Error("Product integrations require an organization workspace");
}

await productBoundaries.storeOpenGeniWorkspaceId(productBoundary.id, workspace.id);

await client.updateWorkspaceSettings(workspace.id, {
  agentHumanInputEnabled: true,
});

const selectedSkills = await productSkillStore.resolveForSession({
  boundaryId: productBoundary.id,
  agentType: "support-agent",
});

const session = await client.createSession(workspace.id, {
  initialMessage: userMessage,
  idempotencyKey: productRequest.id,
  skills: selectedSkills,
  // Headless customer-facing sessions should choose an explicit minimal set.
  firstPartyMcpTools: selectedFirstPartyTools,
  tools: selectedIntegrationServers,
});
```

`created` is `true` only for the first successful insert. A retry returns the
same nested `workspace` with `created: false` and does not overwrite its name,
slug, or agent instructions with stale retry data.

The external source/id pair is unique within the organization. Two organizations
may independently use the same pair; neither can discover or replay the other's
workspace through this mapping. Within one organization, retries preserve the
existing workspace ID and presentation. Namespace `externalSource` to the product
to avoid collisions between products in the same organization.

The organization API key identifies the organization boundary. Never accept an
organization id, external mapping identity, or OpenGeni workspace id directly
from an unauthenticated browser request.

The `externalId` identifies the product boundary; it does not create an
OpenGeni human or membership. Provision lazily on first use, from the product's
user/tenant lifecycle, through a bounded backfill, or a combination. Every path
should call the same idempotent reconciler.

`getAccessContext()` / `GET /v1/access/me` intentionally returns the
organization account grant without enumerating every organization workspace in
`workspaceGrants`. Use `listWorkspaces()` / `GET /v1/workspaces` for the complete
organization-workspace inventory; an empty `workspaceGrants` array does not mean
the organization has no workspaces.

### 3. Create sessions inside the mapped workspace

Once the backend has resolved the authorized workspace id, ordinary operational
routes remain workspace-scoped:

- create a session with
  `POST /v1/workspaces/:workspaceId/sessions` / `createSession`;
- replay events with
  `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events`;
- stream events with
  `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events/stream`;
- send messages and control events through the documented workspace-scoped
  session methods; and
- upload files through `POST /v1/workspaces/:workspaceId/files/uploads` before
  attaching them to a session.

Use a stable session `idempotencyKey` when a product request may be retried. If
the product must persist its cross-reference before the initial turn starts,
also preallocate `requestedSessionId` and store it with that same logical
operation.

## Skills are external product data

Ordinary OpenGeni sessions include `builtin:opengeni-client` for product
integration and `builtin:opengeni-help` for general product questions. Both are
readable with `skill_read` without a sandbox, installation, Pack, or repository
attachment. The client guide helps discover/connect required resources and adapt
implementation, verification and handoff to the product. Only descriptors enter
the initial prompt; the agent reads relevant guidance on demand.

`.agents/skills/opengeni-client` is the single authored source, also usable by
coding agents in a cloned repository. `bun run sync:client-skill` copies it exactly
to the runtime's bundled assets; `bun run check:client-skill` and the unit suite
check for drift. These assets ship with runtime packages and production process
bundles, so managed, self-hosted and local deployments use the same guide without
fetching GitHub at runtime. Edit the canonical source, not the generated copy.
The old `opengeni-product-integration` Pack is not needed or restored.

Control OpenGeni's bundled guidance separately from your product Skills with
`CreateSessionRequest.bundledSkillIds`. Omit it for the default bundles; pass
`[]` for none, or explicit IDs such as `"builtin:opengeni-documents"`. Selection
only narrows each bundle's normal inclusion conditions and grants no tool
permissions. Child sessions inherit the choice and may only narrow it.
Scheduled-task `agentConfig` and automation `sessionTemplate` accept the same
field. Keep the same effective choice when retrying keyed session creation.

This does not disable workspace-authored/installed Skills or your inline
`skills`. Those keep their own ownership and sharing rules. The eager
`skill_read` tool remains available even with no bundled guidance. Bundle
selection does not wait for lazy tool discovery or sandbox startup.

For an embedded support bot, put `bundledSkillIds: []` in the raw create request
or `create: { bundledSkillIds: [] }` in the chat facade's resolved options. Select
only the product's own inline Skills and intended tools, and use a workspace
whose shared Skills match that product. For example, a documents-capable bot
can select only `builtin:opengeni-documents`. Removing bundled guides does not
remove mandatory runtime rules or independently authorized Skill/tool surfaces.

The external backend owns its reusable Skills. Store and version them with the
product's integration code or in the product's own Skill store, then pass the
selected Skill definitions inline in `CreateSessionRequest.skills` for each
product-created session.

```ts
const selectedSkills = await productSkillStore.resolveForSession({
  tenantId: productTenant.id,
  agentType: "support-agent",
});

const session = await client.createSession(workspace.id, {
  initialMessage: userMessage,
  idempotencyKey: productRequest.id,
  skills: selectedSkills.map((skill) => ({
    files: skill.files.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  })),
});
```

Every inline Skill must include a top-level `SKILL.md` with valid YAML
frontmatter containing `name` and `description`. Those values are the source of
the context index metadata; do not maintain a separate short description.
Submit `files` alone. Legacy `name` and `description` fields are optional
consistency assertions and, when supplied, must exactly match the frontmatter.
Additional reference files remain relative to that Skill directory. Skill
content is session configuration, not a secret store.

There is no organization-wide Skill registry or Skill inheritance for this
integration contract. Installing or selecting a Skill in the external product
does not make it ambiently available to all organization workspaces or later
sessions. The external backend remains the source of truth and passes the exact
selected Skills inline per product-created session.

Do not confuse inline session Skills with workspace `agentInstructions`,
session `instructions`, instruction policies, preference descriptors,
or MCP tools. Those have separate authority and lifecycle contracts.

## Product context and tools

Use each prompt surface for its actual lifetime:

| Information | Contract | Lifetime |
| --- | --- | --- |
| Stable OpenGeni workspace persona | workspace `agentInstructions` | Every session in that workspace |
| One agent/session role refinement | session `instructions` | One session |
| Selected inline capabilities or procedures | session `skills` | Fixed onto one session |
| Current product route/selection snapshot | `modelContext` | One accepted user message |
| Visible user request | `initialMessage` or later message text | Durable conversation |

`modelContext` and Skill content are not secrets. Full audit or session readers
may return them. If the agent needs current product state or must mutate product
records, expose a tenant-scoped tool surface instead of copying the product's
database into OpenGeni or embedding long-lived credentials in a prompt.

### Existing APIs without MCP

A customer that has suitable APIs does not need to build an MCP server first.
OpenGeni can deterministically compile a focused OpenAPI 3.0/3.1 document or a
GraphQL endpoint into the same model-visible tool shape through the API
Integration lifecycle:

1. Host the API description and provider endpoint where the OpenGeni control
   plane can reach them under the deployment network policy.
2. Create a workspace Connection when authentication is required.
3. Call `previewApiIntegration` with the source and Connection.
4. Apply the customer's policy to the compiled operations, safety metadata,
   warnings, and approval modes.
5. Call `installApiIntegration` with the exact preview revision and digest,
   stable instance key, Connection, and selected operations.
6. Persist the returned non-secret instance/server identifiers and select that
   server in sessions.

Preview/install is deterministic backend control-plane work, not an agent
re-reading and approving the same documentation for every workspace. It can be
automated for many workspaces. Definitions, Connections, and installations are
workspace-scoped, so a per-user/per-chat workspace design needs a versioned
reconciler; do not preview or reinstall on every message.

The SDK cannot turn arbitrary in-process customer backend functions into
remote tools. Existing functions must be exposed through an authorized network
API described by OpenAPI/GraphQL, or through MCP. A narrow agent-facing API
description may reference existing endpoints and omit irrelevant or dangerous
operations.

An installed API Integration and a remote MCP server remain distinct
control-plane resources even though both become model-callable tools at
runtime. Their installation identifiers, failure surfaces, and credential
lifecycle should not be described as interchangeable.

API-key Connections may carry validated header, query, or cookie placement;
exact supported auth behavior comes from the live preview and installed SDK.
Rotate an ordinary API-key Connection with `updateConnection` and its expected
version. OAuth Connections use the supported reconnect flow. Installed API
Integrations continue to refer to the stable Connection ID.

A session-specific remote MCP server may instead be supplied in
`createSession.mcpServers` with a URL, allowed tools, approval policy, and
write-only credential headers or a non-secret `connectionRef`. Credential
headers are encrypted at rest and omitted from session/event responses. A later
accepted message can carry the supported MCP credential update for rotation.

OpenGeni credential brokerage is not zero knowledge: the trusted control plane
can decrypt a stored credential to construct the authorized provider request.
The model and sandbox receive the tool schema and bounded result, not the
credential itself. The customer API must still enforce tenant/user scope on
every call and must not trust a model-supplied tenant id.

### Model and runtime behavior

Use `settings.sessionDefaults` for a workspace's default model and reasoning,
and `model` / `reasoningEffort` on session or message requests for deliberate
overrides. A session or scheduled task created without `model` gets the
server-resolved default: the saved workspace default, then a usable connected
subscription, then the configured credits model while the organization holds
OpenGeni credits, then the deployment default. `GET
/v1/workspaces/:workspaceId/model-catalog` reports it as `defaultSelection`. Workspace model access policy is the hard allowlist. Model ids and
availability are live deployment facts; do not hard-code a remembered catalog.

OpenGeni credits are held at the organization account. All of that
organization's workspaces using the OpenGeni-credits model path draw from the
same account balance; creating one workspace per user or chat does not create
separate wallets. Connected subscriptions and workspace-owned provider
credentials can use their separately reported external billing path. Retain
workspace and product-boundary identifiers in usage reporting when the customer
needs per-user or per-tenant attribution over the shared balance.

Customer-facing runtime behavior belongs in customer-owned configuration:

- workspace `agentInstructions` for stable behavior shared by that workspace;
- session `instructions` for one agent role or conversation;
- Skills for conditional procedures and tool-use guidance;
- `modelContext` for current dashboard/route/filter state; and
- explicit first-party and external tool selections for capability.

Inline Skills are sent once at `createSession` and stored with that session;
they are not retransmitted on each turn. Existing sessions retain the exact
selected content. Version the customer runtime profile and apply updates to new
sessions, with an explicit migration decision if old sessions must change. Do
not attach implementation guidance about integrating OpenGeni to the end-user
runtime agent.

## Browser and React integration

For organization-wide server-enforced Connect acquisition choices, use the
[organization integration policy](organization-integration-policy.md). Its
catalog exposes named stable keys, and its revisioned update API is administered
with the backend's organization key rather than a browser-only filter.

Use `SessionConversation` behind `createSessionProxyHandler` (see
[Default integration](#default-integration-the-full-conversation)). On
sign-out or user/tenant changes, clear private UI state and abort old requests
before restoring another conversation. Backend authorization remains mandatory
regardless of UI state.

Deviate only for a stated reason. A materially different interaction model can
use `@opengeni/react/session` headless hooks and projections, or compose
`MessageTimeline` and `ChatComposer`; their client contracts are structural,
and the packaged proxy serves the conversation subset of them. A non-React frontend
(Svelte/SvelteKit, Vue, mobile) builds framework-native components against
authenticated product backend routes that use the TypeScript SDK or the public
HTTP contract. Products that expose agent compute add the workbench. Styling is
not a reason to deviate: brand the scoped compiled CSS with `--og-*` tokens.
In a custom route, `proxySessionEventStream` re-streams SSE with the SDK's
reconnect, replay-by-sequence, gap backfill, and deduplication. Unknown
additive event types must not crash the product UI.

The runnable [Northstar support example](../examples/northstar-support) is the
default path end to end: explicit external-member onboarding, server-side
session creation with an explicit tool selection and stable idempotency key,
`createSessionProxyHandler`, `<OpenGeniProvider>` + `<SessionConversation>`,
and an authenticated product MCP server. It uses one preselected workspace and
a fixed demo operator; use the organization-key `ensureWorkspace` flow above
and your own authentication for production tenants.

The product controls whether it renders final answers only, assistant progress,
selected tool calls, or a full operational timeline. Presentation filtering
does not remove the corresponding durable events from authorized OpenGeni
history. A minimal UI must still surface actionable approvals, human-input
requests, failures, cancellation, reconnect state, and credit/policy denials.

## Failures and next steps

| Failure | Meaning | Next step |
| --- | --- | --- |
| Organization-key copy failed | Clipboard access is unavailable; the create dialog still contains the only full token view | Select the full token manually, store it in the server-side secret manager, then close the dialog |
| `401` | The key is missing, malformed, expired, or revoked | Load the intended server-side secret, verify against `/v1/access/me`, or complete key rotation |
| `403` | The credential does not hold the requested organization/workspace authority, or the target is Personal | Resolve the persisted organization-workspace mapping; never retry against a Personal/default workspace |
| `409` from `ensureWorkspace` | The external source/id pair is already owned by another organization or resolves to a non-product workspace | Verify the stable product namespace and tenant ID instead of treating the response as replay success |
| API-key creation limit denial | The managed plan's active-key cap was reached | Rotate by revoking an unused key or change the plan; do not delete tenant mappings |
| SDK response validation/version mismatch | The installed SDK and server are not compatible or the client hard-coded a stale shape | Read `/v1/config/client`, inspect installed SDK types, and align supported major versions before retrying |

An ambiguous network result is not itself a provisioning failure. Retry
`ensureWorkspace` with the exact same external source/id pair; a successful
replay returns the original workspace with `created: false` and preserves its
settings.

Connection creation accepts an `operationId`. After an ambiguous response,
`getConnectionCreationResult(workspaceId, operationId)` recovers that initiating
actor's committed, secret-free connection metadata. Use the same `asUser` identity;
an organization administrator does not inherit another actor's creation receipt.
The lookup does not refresh, reconnect, or restore a revoked connection. A `404`
is not proof that an earlier request is no longer in flight. Exact creation
retries still require the original payload; changed credentials with the same
operation ID are rejected instead of overwriting accepted credentials.

Personal connections use the authenticated initiating user's authority, whether
created interactively or provisioned through `asUser`. No conversation-use grant
or shared-output acknowledgment is required. `initialUseContexts` is rejected as
obsolete. Account choices narrow the owner's accounts without granting access;
sharing a conversation does not share its participants' credentials. Creation
replay never restores a revoked connection.

## Delivery checklist

Before calling a product integration complete, verify:

1. The organization API key exists only in the product backend's secret store.
2. Every product user request resolves an authorized product tenant before an
   OpenGeni workspace or session id is used.
3. The chosen product sharing boundary maps to the expected distinct or shared
   `kind: "shared"` workspaces; Personal workspaces are rejected rather than
   used as a fallback.
4. Workspace provisioning retries call `ensureWorkspace` with the same stable
   external mapping identity.
5. Session creation retries reuse one stable `idempotencyKey`.
6. The effective first-party and external tool policy is explicit and contains
   only capabilities the customer-facing agent needs.
7. Cross-user, cross-tenant, and manipulated workspace/session-id tests fail
   closed at both the product and provider-data boundaries.
8. The external backend loads and passes the selected inline Skills for every
   product-created session; no organization-wide registry or inheritance is
   assumed.
9. SSE reconnect resumes by sequence, backfills gaps, and does not duplicate
   product-side effects.
10. File upload succeeds from every intended browser origin, including signed
   storage PUT CORS and upload completion.
11. Product API/MCP tools independently enforce the same tenant/user boundary
   as the product API and support credential rotation.
12. The integration checks `/v1/config/client`, uses installed SDK types, and
    pins a compatible SDK/server major version instead of hard-coding volatile
    model, tool, or compute catalogs.

For typed method details continue with the [SDK README](../packages/sdk/README.md).
For credential distinctions see [Credential taxonomy](credentials.md). For the
underlying organization authority model see
[Organization tenancy](organization-tenancy.md). The optional workbench is
documented separately in [Embedding the workbench](embedding-workbench.md);
advanced in-process router/core embedding is a different architecture covered
by [Embedding](embedding.md).
