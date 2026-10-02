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

// 2. The server creates sessions: the agent, its tools, a stable idempotency key.
const session = await og.asUser(user.id, { source }).createSession(workspace.id, {
  initialMessage: `Help me with ticket ${ticket.id}`,
  idempotencyKey: `ticket:${ticket.id}:${user.id}`,
  agent: {
    identity: "You are Acme's support assistant. Friendly and brief.",
    capabilities: "none", // Acme's tools, asking questions, reading Skills
  },
  skills: productSkills,
  tools: [{ kind: "mcp", id: "acme" }],
  sandboxBackend: "none", // pure chat/tool agent: no sandbox to start
});

// 3. Mount at /api/opengeni/* (Next.js route handler, Hono, Bun.serve, workers).
export const handler = createSessionProxyHandler(og, {
  chats: "private", // the default; "shared" or "isolated"
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
// session-ui has no optional peers; the root also exports the workbench.
import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });
<OpenGeniProvider client={client} workspaceId={workspaceId}>
  <OpenGeniChat /> {/* chat list + conversation; or <SessionConversation sessionId={session.id} /> */}
</OpenGeniProvider>;
```

Mount the handler with a framework adapter: `createSessionProxyRoute` from
`@opengeni/sdk/next` (App Router catch-all route), `toNodeMiddleware` from
`@opengeni/sdk/express`, or `toHonoHandler` from `@opengeni/sdk/hono`.
`OpenGeniChat` lists the chats the resolved user created (`sessionList:
"mine"`, the proxy default) and starts new ones through the `createSession`
hook.

The proxy calls `resolve` on every request and acts only through
`asUser(user, { source })`; there is no fallback to the key's service
authority. It rejects any workspace other than the resolved one and serves only
the native routes `OpenGeniProvider` and the conversation use: client config;
workspace read, model catalog, live control stream, and workspace Resume;
session read and rename, event list and SSE (with `Last-Event-ID` resume),
send, steer, approval and human-input responses, queue, composer draft,
pause/resume, (unless `files: false`) attachment upload and download URLs, and
(only with explicit `sandboxFiles: true`) session sandbox file reads for `sandbox:` links.
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

The handler is JavaScript. A Django, Rails, Go, PHP, or Java backend implements
the same allowlist in its own framework instead of running a Node sidecar: see
[Proxy from any backend](../docs-site/integrate/proxy-from-any-backend.mdx)
for the routes, headers, stripped fields, security rules, and a Django example.

The permissions above cover the conversation; drop `files:*` without
attachments. Membership is granted only by explicit onboarding: the proxy and
`asUser` never grant or restore it, and without it the API answers 403. Pass an
`operationId` you store first to make onboarding retries safe; see
[external membership operations](external-membership-operations.md). To change
a member's permissions later, call `updateExternalWorkspaceMember` with a new
`operationId` instead of removing and re-adding them. To map tenants lazily, pass the `OpenGeni` facade from `@opengeni/sdk/chat` instead of
a client and return `{ tenant, user }` from `resolve`.

### Configure the agent

Every session takes one `agent` object: `capabilities`, `identity`,
`instructions` and `renderer`. Sessions, the proxy's `createSession` hook, the
chat facade, scheduled tasks (`agentConfig.agent`), workspace defaults
(`settings.sessionAgentDefaults`) and a running session
(`updateSessionAgent`, from its next turn) all use the same object, and every
session reports the result as `session.agent` and `session.effectiveTools`.

`capabilities` starts from `"all"` (everything the workspace offers) or
`"none"` (the session's own tools plus asking questions and reading Skills)
and switches single capabilities: `{ from: "none", webSearch: true }`.

| Capability | Lets the agent |
| --- | --- |
| `humanInput` | pause and ask the person for a decision or missing detail |
| `webSearch` | search the public web |
| `media` | generate images and videos |
| `goals` | work toward a goal across many turns |
| `subagents` | start, message and follow other sessions; list models |
| `skills` | `"read"` installed Skills, or `"manage"` them too |
| `artifacts` | publish files, documents and Sites |
| `browser` | use a browser or desktop computer |
| `schedules` | create and manage scheduled tasks |
| `knowledge` | search and save workspace Knowledge, task notes and instructions |
| `workspaceFiles` | read files uploaded to the workspace |
| `workspaceConnectors` | use the workspace's connected apps and integrations |
| `workspaceAdmin` | manage variable sets, projects, rigs, machines and connector setup |

Tools the session attaches itself (its `mcpServers` and named `tools`), sandbox
tools and runtime mechanics are not capabilities and are never toggled. A
capability the deployment does not offer is reported off in `agent.unavailable`;
requesting it returns 422 `agent_capability_unavailable`. Child sessions may
only narrow their parent (`agent_config_widening`), and a goal needs `goals`.

`identity` replaces only how OpenGeni introduces the agent. `instructions` is
the session `instructions` field. The prompt order is identity, OpenGeni's
working style, organization identity, workspace instructions, session
instructions; instructions take priority over OpenGeni's default working style,
never over its safety rules or how it runs tools. `renderer` is `"opengeni"`
for OpenGeni's React components (`sandbox:`/`artifact:` links and inline
visuals) or `"markdown"` for any other UI; the chat facade defaults to
`"markdown"`.

`agent` is admitted when the deployment sets
`OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED` (the client config reports
`agentConfig.enabled`); otherwise it is 422 `agent_config_not_enabled` and the
older fields (`firstPartyMcpTools`, `tools`, `instructions`) remain the way to
narrow an agent. Sessions created before agent settings keep `agent: null` and
their exact tools and prompt. See [Agent configuration](design/agent-configuration.md)
for the design and enforcement details.

### Choose who shares chats

Every session lives in the customer's workspace, so all of them share that
customer's documents, workspace instructions, Connections and integrations.
`chats` on the proxy and the chat facade decides who sees and shares the
conversations themselves:

| `chats` | Who sees the chat | Agent reach | Knowledge written to | Workspace |
| --- | --- | --- | --- | --- |
| `"private"` (default) | only the user | its own session tree | the user's personal Knowledge | the tenant's |
| `"shared"` | the workspace | the workspace | the workspace | the tenant's |
| `"isolated"` | only the user | its own session tree | the user's personal Knowledge | one per tenant user |

`chats` sets the create fields `visibility`, `agentAccess` and `memoryScope`;
explicit values in the `createSession` hook still win, and the API authorizes
each one. Private chats need the organization's private-session setting;
without it the SDK throws `OpenGeniSetupError`, which names who can enable it
(an organization owner or admin, in the API, SDK or web app). `"isolated"`
needs the `OpenGeni` facade as the proxy target and a `resolve` that returns
`{ tenant, user }`; it provisions a separate workspace and that user's
membership through `og.workspaceIdFor({ tenant, user }, { isolation: "user" })`
(standalone: `createWorkspaceIdResolver` from `@opengeni/sdk/tenant-workspaces`).

Isolated users receive workspace read, session create/read/control (including
Send), file upload/read, and `mcp_servers:attach` for the host's per-session
servers, never admin permissions by default. `memberPermissions` in the facade
constructor or resolver options replaces this initial permission list; it does
not change existing or revoked memberships. The organization key remains a
permission ceiling. Supply MCP URLs and credentials only in the server's
`createSession` hook, not browser input.
Existing users need an explicit `updateExternalWorkspaceMember` to gain newly
added permissions. A conflicting or cancelled onboarding operation returns only
the workspace address; it never restores access, and `asUser` still checks the
live membership on each request.

`agentAccess` is enforced for agents in the single session-authorization seam:
a session's own tree is always reachable, and peers are reachable when the
caller's task scope and ordinary target authorization allow it. Personal
Knowledge belongs to the verified user of the active turn, not an arbitrary
product label. Use task notes for temporary conversation-tree coordination.
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
same explicit onboarding is required for `user`. With a `user`, `chats`
defaults to `"private"` (personal Knowledge on; `memory: false` turns authoring
off); without one, omitted `chats` keeps workspace visibility, session-only
reach and Knowledge off. `og.chat(...)` and `resolve` also take `agent`, and the
facade's renderer defaults to `"markdown"`. The
adapters send only the latest user message. Earlier messages from the app are
imported only when the session is first created, as context on its first
message; after that OpenGeni owns the history, and messages the app shows but
never sends are not added. Reopen
legacy user-namespaced conversations with `chatBySessionId`. `og.client`,
`chat.workspaceId`, and `chat.sessionId` address the same session through the
full client, so `SessionConversation` can take over without a migration. The
runnable [chat quickstart example](../examples/chat-quickstart) is one backend
server file.

## Migrating from embedded OpenGeni

Use `@opengeni/sdk/session-history-import` for a backend migration from an
in-process runtime to a standalone deployment. It creates read-only historical
archives, not model-facing history or live sessions. Check the installed SDK and
target service support this contract before running the migration.

Create requires `sessions:create`; appending requires `sessions:control` and the
same authenticated importer. Grant both for a complete migration. With `asUser`,
the user's permissions apply, not the organization key's permissions.

Preserve the original external tenant and user mappings. Call `ensureWorkspace`
with the same stable external source/tenant ID, explicitly onboard admitted users
with `addExternalWorkspaceMember`, and persist the resulting workspace ID.
Imports do not grant membership or create external workspace mappings. Never
fall back to a Personal/default workspace or invent new identities to clear an
authorization failure.

Preserve title, original session/event timestamps, creator and visibility. Use
the organization-key client through `.asUser(originalExternalUserId, { source })`
for the verified external creator/owner. Without `asUser`, an organization key
creates only an ownerless workspace-shared archive. `user_private` requires the
verified owning user and the existing private-session organization enablement;
do not silently turn private source history into shared history. Keep source IDs
and any additional metadata not accepted by v1 in a host-owned migration ledger.

Before freezing event requests, re-upload retained files through the destination
workspace's existing `uploadFile` / begin-upload-complete APIs. Persist an
old-to-new file/reference map and replace payload references. Source file IDs,
signed URLs, storage and sandbox paths are not transferable authority.

The focused functions take `client` first and use its normal `requestJson`
transport:

| Function | Remaining arguments |
| --- | --- |
| `importArchivedSession` | `workspaceId, ImportArchivedSessionRequest` |
| `appendArchivedSessionEvents` | `workspaceId, importId, AppendArchivedSessionEventsRequest` |
| `importExternalWorkspaceArchivedSession` | `source, externalId, ImportArchivedSessionRequest` |
| `appendExternalWorkspaceArchivedSessionEvents` | `source, externalId, importId, AppendArchivedSessionEventsRequest` |

Create sends `{ importId, title, createdAt, visibility?, events? }`; omitted
events default to `[]`. Each event is `{ type, createdAt, turnId?, payload }`,
with a finite supported historical event type, ISO timestamp, optional UUID/null
turn correlation and a JSON-object payload. Append sends
`{ batchId, offset, events }` with a non-empty batch and zero-based event offset.
Import IDs, batch IDs and titles are at most 200 characters; each request is at
most 100 events / 1 MiB serialized UTF-8 JSON and each event at most 256 KiB.

Source timestamps support at most millisecond precision; normalize finer dates
explicitly and keep their originals in the ledger. Negative-zero JSON is rejected.

Create returns `{ session, importId, created, nextOffset }`; append returns
`{ sessionId, importId, nextOffset, replayed }`. Store the source-session to
destination-session mapping and each exact request before sending it. After an
uncertain response, retry the same actor, workspace/mapping, IDs, offset and
events. Repeated exact creates replay with `created: false`; repeated exact
append batches replay with `replayed: true`, without duplicate events. New
batches use the acknowledged `nextOffset`. Changed key reuse or an out-of-order
new offset conflicts with `409`; reconcile the ledger instead of bypassing the
conflict with new keys. The SDK performs no automatic mutation retries.

Routes are `POST /v1/workspaces/:workspaceId/session-imports` and
`POST /v1/workspaces/:workspaceId/session-imports/:importId/events`; external
mapping forms substitute `/v1/workspaces/external/:source/:externalId` for the
workspace prefix. Import functions are not root exports or eager client methods
and are not exposed by `createSessionProxyHandler` to browsers.

Completed messages, tool calls/results and goals are optional historical facts.
No event executes a tool, restores a pending approval/question, creates an active
goal, seeds `session_history_items`, starts a workflow or enqueues a model turn.
Use native payload shapes for rendering; prefer completed messages rather than
fabricating streaming activity. `session.importedArchive` is
`{ importId, importedAt, readOnly: true }`, independent of ordinary personal
archive/restore preferences. Leave `SessionConversation` unchanged behind the
existing proxy; open the returned session ID in a view-only conversation with no
Send or Steer. Continuing an imported archive is unsupported in v1; new work
needs a separate new session, not silent history injection.

The coding-agent walkthrough lives in
[the client Skill's migration reference](../.agents/skills/opengeni-client/references/session-history-import.md).
The public walkthrough is in
[`docs-site/guides/integrate-your-product.mdx`](../docs-site/guides/integrate-your-product.mdx#migrating-from-embedded-opengeni).

## Boundary and ownership

For included-usage plans, per-seat equal splits, administrator sliders, custom
shares, top-ups, and monthly team budgets, see
[Usage allowances](usage-allowances.md). Allowance amounts are integer USD
micros and govern actual OpenGeni credit debits; they are soft post-call
ceilings, not reservations or organization-credit purchases. Keep budget
configuration/grants in organization-authorized backend flows and use the
session proxy's own-usage route for a browser meter.

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
| Organization API key with an explicit policy | A backend needs individually selected permissions across all or selected shared workspaces | Personal workspaces or treating a preset label as a grant |
| Organization API key with legacy `access: "read"` | A reporting backend needs shared-workspace inventory, sessions, events, and files | Creating sessions, controlling turns, or minting keys |
| Workspace API key | One backend or automation is deliberately constrained to a single organization workspace | Multi-workspace provisioning or organization administration |
| Delegated token | A host acts with short-lived, explicit user/workspace authority | A standing multi-tenant backend credential |
| Deployment access key | An operator needs a coarse configured/self-hosted deployment perimeter | Tenant identity, account selection, or workspace authorization |

An organization API key is the default for the product shape on this page. A
full-access organization key with all-shared-workspace scope is all the integration needs: it creates
workspaces, adds external members, and creates and controls sessions as those
users (`asUser`). Its `/v1/access/me` `accountGrants` (`account:read`,
`workspace:create`, `api_keys:manage`) and empty `workspaceGrants` do not list
that workspace authority. Check `credential.policy`, `credential.workspaceScope`,
and `credential.effectiveWorkspacePermissions`; the legacy `credential.access`
label alone does not establish an explicit policy's grants. On a deployment that
omits `credential`, make the idempotent call (`ensureWorkspace`) rather than
concluding the key is too weak.
Choosing it does not remove the product backend's obligation to authenticate
its own users and resolve their allowed tenant before every proxy call.

Organization-key inventory and operational requests honor the key's live
shared-workspace scope and exact permissions. To read authorized transcripts
without touching each workspace, call
`listOrganizationSessions(organizationId, { limit, cursor, scopeSubjectId?, status? })`
or iterate `iterateOrganizationSessions`; the route is
`GET /v1/organizations/:organizationId/sessions`, every row carries its
`workspaceId`, and events are then read through the ordinary workspace routes.
Personal workspaces and managed-human **Only me** sessions are never included.
For the legacy sessions-and-files-only tier, use
`createOrganizationApiKey(organizationId, { name, access: "read" })`.
An explicit `read_only` preset is broader: it includes every canonical
read/list/view/search permission, including plaintext-secret reads.

## Canonical provisioning flow

### 1. Create and store an organization API key

Organization API-key administration uses the organization control plane:

| Operation | SDK method | Route |
| --- | --- | --- |
| List keys | `listOrganizationApiKeys` | `GET /v1/organizations/:organizationId/api-keys` |
| Read key metadata and policy | `getOrganizationApiKey` | `GET /v1/organizations/:organizationId/api-keys/:apiKeyId` |
| Create a key | `createOrganizationApiKey` | `POST /v1/organizations/:organizationId/api-keys` |
| Edit key metadata or policy | `updateOrganizationApiKey` | `PATCH /v1/organizations/:organizationId/api-keys/:apiKeyId` |
| Revoke a key | `deleteOrganizationApiKey` | `DELETE /v1/organizations/:organizationId/api-keys/:apiKeyId` |

Creation returns `{ apiKey, token }`, with the token shown once. Detail and PATCH
return the raw `ApiKey`, not a wrapper, and never return the token. List returns
`{ apiKeys }` over HTTP; the SDK unwraps it to `ApiKey[]`.
Store the token in the product's secret
manager and persist only non-secret key metadata in ordinary application data.
Rotate by creating the replacement, switching backend traffic, and then
revoking the old key. Do not use the legacy workspace-scoped API-key routes for
a new multi-workspace product integration.

Upgrades that introduce explicit organization-key provenance revoke ambiguous
historical null-workspace keys. If an integration predates the organization
API-key control plane, create a new organization key through the route above,
replace the stored backend secret, and discard the legacy token.

Full organization keys can provision shared workspaces, external members, and
sessions through `asUser`. Their effective workspace permissions include
`sessions:create` and `members:manage`; user requests additionally require the
user's live membership and intersect it with the key's permissions.
Read-only keys cannot provision workspaces or members, create sessions, or mint
keys. For legacy keys, workspace admin implies ordinary workspace operations
but not the literal `secrets:read` permission. For explicit policies, every
permission is selected individually: `workspace:admin` is not a wildcard.
Neither form reaches Personal workspaces directly or
bypasses session visibility. `api_keys:manage` also permits issuing narrower
workspace keys when an integration component should be constrained to one tenant
workspace. Those
child keys cannot receive account, member, workspace-creation, billing, or
plaintext-secret permissions that the workspace grant does not literally hold.

#### Explicit organization-key policies

`OrganizationAccessPolicy` has three required fields:

```ts
type OrganizationAccessPolicy = {
  preset: "read_only" | "full" | "custom";
  permissions: Permission[];
  workspaceScope:
    | { kind: "all" }
    | { kind: "selected"; workspaceIds: string[] };
};
```

| Preset | Permission selection |
| --- | --- |
| `read_only` | Every canonical permission ending in `:read`, `:list`, `:view`, or `:search`, including `secrets:read` and `variable-sets:read` |
| `full` | Every canonical, non-deprecated `Permission`, including explicit administration and plaintext-secret permissions |
| `custom` | Exactly the permissions chosen, including an empty list; no implicit permissions or workspace scopes |

The supplied preset is only a label: it never adds grants. For example,
`preset: "full"` with only `permissions: ["sessions:read"]` grants only
`sessions:read` and is returned as `custom`, not full access. The contracts
helpers in `packages/contracts/src/organization-access.ts` are canonical:
`organizationAccessPresetPermissions` builds preset permission lists;
`normalizeOrganizationAccessPolicy` maps deprecated aliases to canonical names,
deduplicates and orders permissions, and recomputes the preset from the actual
set. The SDK has handwritten wire mirrors and sends the supplied list unchanged;
it does not import contracts at runtime or expand labels.

`{ kind: "all" }` includes all current and future shared workspaces in the
organization. `{ kind: "selected", workspaceIds }` requires 1..500 unique UUIDs
for existing shared workspaces in that same organization; cross-organization,
missing, and Personal IDs are rejected. Personal workspaces are excluded from
both scopes, regardless of preset. Workspace and organization-session lists
filter to the live scope; a selected scope never silently falls back to all.

Create a narrowly scoped reporting key from an authorized administrative backend:

```ts
import type { OrganizationAccessPolicy } from "@opengeni/sdk";

const policy: OrganizationAccessPolicy = {
  preset: "custom",
  permissions: ["workspace:read", "sessions:read", "files:read"],
  workspaceScope: { kind: "selected", workspaceIds: [authorizedWorkspaceId] },
};
const { apiKey, token } = await adminClient.createOrganizationApiKey(organizationId, {
  name: "Tenant reporting",
  policy,
});
await secretManager.store(token); // creation is the only token-returning response

const current = await adminClient.getOrganizationApiKey(organizationId, apiKey.id);
const updated = await adminClient.updateOrganizationApiKey(organizationId, current.id, {
  description: null, // clear it; omit the field to leave it unchanged
  policy: { ...policy, permissions: ["workspace:read", "sessions:read"] },
});
```

PATCH accepts `name?`, `description?: string | null`, and `policy?`, and requires
at least one change. A policy replaces the complete prior policy; it is not a
permission append or a merge of workspace IDs. Permission or scope narrowing
takes effect on the next request with the same token. Metadata-only edits
preserve legacy stored permissions and their historical `workspace:admin`
wildcard. Supplying `policy` transitions that key to `permissionMode: "explicit"`:
every `Permission`, including `workspace:admin`, must then be chosen individually
and grants no unselected permission. No token rotation is needed for an edit.

Legacy creation remains additive: omit `policy` and retain `access: "full"`,
`access: "read"`, `access: "developer_setup"`, or the top-level
`preset: "developer_setup"` alias. Omitting both policy and legacy selectors
retains full legacy semantics, not the new explicit full preset. Do not combine
an explicit policy with a legacy access tier or setup preset. `ApiKey` adds
optional `policy`, `workspaceScope`, and `permissionMode: "legacy" | "explicit"`;
`AccessGrant` adds optional `permissionMode`. Older servers may omit these fields.

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
authorized organization-workspace inventory; an empty `workspaceGrants` array does not mean
the organization has no workspaces.

Direct organization and workspace API-key requests also return optional
`credential` metadata, separate from the unchanged `accountGrants` and
`workspaceGrants`. It contains `kind` (`organization_api_key` or
`workspace_api_key`), organization-only legacy `access` (`full`, `read`, or
`developer_setup`), `accountId`, `workspaceId`, `effectiveWorkspacePermissions`,
and a plain-language `note`. Organization keys also expose optional `policy`
and `workspaceScope`. Their null `workspaceId` identifies an organization key,
not an all-workspaces grant: consult its all/selected shared-workspace scope.
Personal workspaces are always excluded; a workspace key names its one workspace.
`credential.effectiveWorkspacePermissions` expands `workspace:admin` only for
legacy keys, preserves exact explicit-policy grants, excludes account-only permissions, and includes
`secrets:read` only when explicitly granted. Full organization keys include
`sessions:create` and `members:manage`, so the backend can provision workspaces,
external members, and `asUser` sessions. User requests still require live
membership; this metadata bypasses neither session visibility nor
literal secrets authority. It is omitted for `asUser`/external-actor requests,
humans, delegated tokens, and other caller contexts. Older servers may omit
`credential`; do not infer missing authority from an absent field.

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

## Automated work

For product jobs, bots, and webhooks, keep the organization or workspace API key
on the backend and use `client.asService(name, context?)`. It returns a new
client of the same class without changing the original. Attribution is not
permission: the API still checks the key's authority, and service work cannot
impersonate a human or borrow their Personal workspace, personal Connections,
Knowledge, or Variable Sets. Do not use a synthetic `asUser` identity for a job.

The helper sends `x-opengeni-service-initiator` (a name matching
`^[a-z0-9][a-z0-9:._-]{0,63}$`) and, when supplied,
`x-opengeni-service-context` (a flat JSON object with string, finite-number, or
boolean values, at most 2 KiB of serialized header bytes). Context is non-secret
attribution, not credentials or a permissions request. `asService` and
`asUser` / `asLinkedUser` are mutually exclusive; start each lane from the
unscoped client. Reapplying `asService` replaces its name and context.
The server rejects mixed user/service headers with 422. OpenGeni-owned
provenance fields such as `via` and `label` are reserved context keys.
Session create, Send, and Steer freeze this service principal with no initiating
human; a scheduled task created in this lane freezes it for its occurrences.

For a private repository owned by the product, configure a
[workspace credential provider](workspace-integrations.md#credential-provider)
once during provisioning, then select the repository in the job:

```ts
const { secret } = await client.putWorkspaceCredentialProvider(workspace.id, {
  url: "https://product.example/opengeni/credentials",
});
await productSecrets.storeCredentialProviderSecret(workspace.id, secret);

const job = client.asService("acme:reports", { jobId: jobRecord.id });
const session = await job.createSession(workspace.id, {
  initialMessage: "Read the repository and summarize the latest report changes.",
  idempotencyKey: `reports:${jobRecord.id}`,
  resources: [{
    kind: "repository",
    uri: "https://gitlab.com/acme/reports.git",
    ref: "main",
    provider: "gitlab",
    access: "read",
  }],
  skills: productSkills,
  tools: [],
  firstPartyMcpTools: [],
  bundledSkillIds: [],
});
```

The product endpoint verifies the signed request and independently authorizes
its exact workspace/session scope before returning short-lived `git` credentials
for `gitlab.com` and an `expiresAt`. It must not treat the service name or context
as authorization. Keep tokens out of the repository URI and prompt. Use managed
compute for cloning; a Connected Machine owns its existing checkout and Git
authentication, so OpenGeni does not clone repositories or inject Git tokens there.

## Skills are external product data

Ordinary OpenGeni sessions include `builtin:opengeni-client` for product
integration and `builtin:opengeni-help` for general product questions. Both are
readable with `skill_read` without a sandbox, installation, Pack, or repository
attachment. The client guide helps discover/connect required resources and adapt
implementation, verification and handoff to the product. Only descriptors enter
the initial prompt; the agent reads relevant guidance on demand.

`.agents/skills/opengeni-client` is the single authored source, also usable by
coding agents in a cloned repository. `bun run sync:client-skill` copies it exactly
to the runtime's bundled assets and renders the public docs mirror
`docs-site/reference/opengeni-client-skill.mdx`; `bun run check:client-skill` and
the unit suite check both for drift. These assets ship with runtime packages and production process
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

`builtin:opengeni-schedules` provides schedule-creation guidance when
`scheduled_tasks_create` is configured. Like other bundles, it can be excluded
by an explicit selection and does not grant tool permissions.

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

1. Host the provider endpoint where the OpenGeni control plane can reach it
   under the deployment network policy. The API description can be hosted too,
   or sent inline as `source: { kind: "openapi_document", sourceKey, document,
   baseUrl? }` (JSON/YAML text up to 8 MiB; `sourceKey` is the stable
   installation identity; server URLs must be absolute or `baseUrl` given; the
   preview echoes only `documentSha256`; resend the document on install).
   Inlining removes only the need to host the description: calls still obey
   the network policy, so a product on localhost or a private network needs a
   public tunnel unless the operator enables private targets.
2. Create a workspace Connection when authentication is required.
3. Call `previewApiIntegration` with the source and Connection.
4. Apply the customer's policy to the compiled operations, safety metadata,
   warnings, and approval modes.
5. Call `installApiIntegration` with the exact preview revision and digest,
   stable instance key, Connection, and selected operations. Operations the
   preview marks `approvalMode: "ask"` pause for human approval on every call;
   for unattended or scheduled work, list the ones policy permits in
   `autoApprovedTools` (`capabilities:manage`; curated definitions may keep specific operations human-approved;
   re-checked against organization integration policy; declarative, so an
   update that omits it restores approval). Connector Block, session approval
   policy, and action policies still apply.
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
The credential bundle is `{ headers: { "<Header-Name>": "<value>" } }` or
`{ placements: [{ carrier, name, value, prefix? }] }` (SDK type
`ApiKeyConnectionCredential`); create and update reject any other `api_key`
shape with 422, and `previewApiIntegration` warns when the selected Connection
does not place its credential at the description's declared carrier and name.
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

### Credentials, completion events, and the sandbox image

A standalone product does not need an in-process host port to give the agent
short-lived cloud or Git credentials, to learn when a turn finishes, to know
which turn called its MCP server, or to choose the sandbox image. Configure a
workspace credential provider, workspace webhooks, and an allowlisted
`defaultSandboxImage`, and read `_meta.opengeni` on MCP calls. See
[`docs/workspace-integrations.md`](workspace-integrations.md) for the protocol,
signature scheme, and SDK helpers.

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

### Links, files, artifacts, and Sites in replies

Agents link the objects they produce directly in chat Markdown. None of these
is a URL the host's browser can navigate: `artifact:` and `sandbox:` are
application schemes, and the `/workspaces/...` forms are OpenGeni console
routes, which resolve against the product's own origin and 404 there.

| Agent writes | Target | `SessionConversation` default |
| --- | --- | --- |
| `[Report](artifact:<file uuid>)` | Retained workspace file (exports, published files) | Downloads through a short-lived URL (proxy `files`) |
| `[Code](sandbox:src/app.ts:12)` | File in the session's working directory | Unavailable unless the proxy explicitly enables `sandboxFiles: true` |
| `[Weekly report](/workspaces/<ws>/artifacts/editable/<id>)` | Live editable document, workbook, or presentation (`artifactReference` from the artifact tools) | Opens in the host viewer with `onOpenArtifact`; otherwise unavailable |
| `[Dashboard](/workspaces/<ws>/artifacts/<uuid>)` or an `opengeni-site` fence | Saved Site / published HTML | Fence renders the inline Site preview; links open with `onOpenArtifact` |

With `SessionConversation` (or `OpenGeniChat`) behind the proxy, retained-file
downloads work by default. Sandbox-path reads are off by default: enable
`sandboxFiles: true` deliberately. The proxy forces workspace-only reads,
including on Connected Machines: relative paths and absolute paths inside the
selected working directory are accepted; traversal, outside absolute paths,
and symlink components are refused. Reads are capped at 25 MiB in actual bytes.
Providers without the required no-symlink descriptor support fail closed.
This strict mode currently requires a POSIX runtime with Python and
descriptor-relative opens; Windows Connected Machine sandbox-path downloads
are unavailable.
The proxy reports this capability in client config, so disabled sandbox links
render unavailable rather than offering a download that fails.

#### Inline previews and the artifact viewer

The conversation renders assistant `opengeni-site` and `opengeni-html` fences
as the same inline preview the OpenGeni console shows (fixed height, reload,
full screen, version picker, "Open Site"). To open editable artifacts and
Sites, mount `SessionArtifactViewer` from `@opengeni/react/artifacts` in any
sized container (for example the product's main area beside an assistant
panel, or a full-screen sheet on phones) and let the conversation open it:

```tsx
import { SessionArtifactViewer } from "@opengeni/react/artifacts";
import { editableArtifactKernelRuntime as document } from "@opengeni/artifact-kernel-wasm-document";
import { editableArtifactKernelRuntime as spreadsheet } from "@opengeni/artifact-kernel-wasm-spreadsheet";
import { editableArtifactKernelRuntime as presentation } from "@opengeni/artifact-kernel-wasm-presentation";
import workerUrl from "@opengeni/sdk/editable-artifacts/worker?worker&url"; // Vite

const [artifact, setArtifact] = useState<OpenGeniViewerTarget | null>(null);
<SessionConversation sessionId={sessionId} onOpenArtifact={setArtifact} />;
{artifact ? (
  <SessionArtifactViewer
    sessionId={sessionId}
    target={artifact}
    onClose={() => setArtifact(null)}
    editableRuntimes={{ document, spreadsheet, presentation, workerUrl }}
  />
) : null}
```

The viewer owns its header (kind, title, optional Back, Close) and fills its
container; the host owns placement and closes it when the session changes.
Documents, spreadsheets, and presentations open in the first-party editor;
users with the `artifacts:publish` grant can edit, everyone else reads. Sites
render in the sandboxed frame without workspace tool access.

Every built-in string in the viewer and inline previews (header, kind
subtitles, loading and error states, Site toolbar, counts) is English by
default and overridable: pass `labels` (a partial `ArtifactLabels`) to
`SessionArtifactViewer` or `ChatInteractiveBlock`, or wrap a subtree in
`ArtifactLabelsProvider`. Unspecified keys keep the defaults, and count and
version labels are functions so the host applies its own plural rules.

Both read through the proxy only when it opts in with `artifacts: true`:

```ts
createSessionProxyHandler(og, { resolve, authorizeMutation, artifacts: true });
```

Every artifact request names its session in `x-opengeni-session-id` (the
viewer and conversation send it); the proxy runs `authorizeSession`, then
performs an exact authorized association lookup for that session on every
request (no cached authorization or bounded list scan): the artifact read and
editor live ticket, and Site detail and HTML (served as a sandboxed download,
never as a page on the product origin). Writes, exports, version changes, and
Site tool calls are not proxied. The editor's live socket is ticket-authenticated
and connects to the OpenGeni API directly (`artifacts.editableLiveUrl`
overrides the derived URL). Tickets minted through the proxy bind the source
session, whose authority the API also revalidates while connected.
Sockets bound this way have a 15-second lease from ticket issuance and reconnect
through the proxy, so its product-level `authorizeSession` also checks renewal.
The deadline runs independently of authorization; source authority is checked
again inside the mutation commit transaction after kernel computation.
Unbound console tickets keep their existing socket lifecycle. Client
config resolves fresh effective workspace permissions (including external
users and organization-key ceilings) and advertises the user's browser cache
partition; permission changes produce a new authorization epoch. A host with
its own proxy adds the same capability to
its `/v1/config/client` response with `artifactViewerCapability({ client:
og.asUser(user, { source }), workspaceId, source })` from `@opengeni/sdk`, and
forwards the same artifact routes under its own authorization.

When an older API lacks the effective-grant endpoint, the proxy omits artifact
capability from config but still boots the conversation. Artifact requests fail
closed; a subsequent config read can discover upgraded API support.

The server-only helpers for exact association, effective grant and streaming
HTML reads live on `@opengeni/sdk/session-proxy`, not the browser client.
The proxy streams Site HTML with backpressure and cancellation and caps actual
bytes at `SESSION_PROXY_SITE_HTML_MAX_BYTES` (25 MiB). An oversized stream fails
with `SessionProxySiteHtmlTooLargeError` (`site_html_too_large`); once response
headers have been sent, the body errors instead of replacing the HTTP status.
The OpenGeni console's direct HTML delivery is unchanged. Temporary viewer
config failures show Retry; absence of the capability remains unavailable.

For any other routing, `resolveLink` returns `{ href }` for a host page or
`{ open }` for an action, and `null` to keep the default; `viewerLinkResolver`
builds the same "open in host viewer" action for a custom `MessageTimeline`.
`MessageTimeline` has no defaults (compose `sessionLinkResolver({ client,
workspaceId, sessionId })` for downloads and pass `renderInteractiveBlock`),
and its resolver also applies to `Markdown` rendered by a custom
`renderMessageText`. `OpenGeniLinkProvider` sets a resolver for a whole
subtree. An unresolved target renders as text marked unavailable, never as a
broken link, and the Site tool row hides its Open action.

A non-React frontend applies the same rule with `parseOpenGeniLink(href)` from
`@opengeni/sdk`, which classifies an agent href into `file`, `sandbox-file`,
`editable-artifact`, or `site` (or `null` for an ordinary link). Download a file
with `createFileDownloadUrl(workspaceId, fileId, { sessionId })` and a sandbox
file with `fsRead(workspaceId, sessionId, { path, encoding: "base64" })`.

Editable artifacts are live collaborative objects, not files. The artifact
export tool advertises the formats the deployment serves in its description;
the stock deployment serves spreadsheet XLSX only. Custom exporters supply
their own supported formats; the exact profile and options are preflighted
before any snapshot or version pin. Unsupported requests are refused with
`unsupported_format` and configured-format guidance. Agents are told
to share the live artifact link instead of promising a PDF or DOCX, so a host
that needs file delivery of documents should plan on the artifact page rather
than an export.

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
