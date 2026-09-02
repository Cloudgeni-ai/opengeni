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
value. Personal workspaces are excluded from this integration model.

The built-in `opengeni-product-integration` Pack is guidance for the coding
session that builds this integration, not for the resulting product chatbot.
Its Skill is session-selected: installation alone does not add it to any agent.
Use **Start with Pack** in the web console, or create the implementation session
with the reviewed Skill component ID in `installedSkillIds`. Never include that
ID in customer-facing session creation.

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

Do not automatically equate one product tenant with one OpenGeni workspace.
Choose the workspace from the product's sharing rule:

| Product rule | Default OpenGeni mapping |
| --- | --- |
| Everyone in one product tenant may collaborate across chats | One workspace per tenant |
| Each end user's chats must be private from other end users | One workspace per end user |
| Every chat must be isolated, including from the same user's other chats | One workspace per chat |
| Several users access the same upstream data but their chats are private | Separate user/chat workspaces with equivalent appropriately scoped data access |

This is an agent-authority decision, not only a UI visibility decision. A live
agent attempt holding the relevant first-party session tools and permissions
may read, message, and control unrelated sessions in the same workspace.
Parent/child lineage is not the general access boundary. Turning
`memoryEnabled` off only disables workspace Memory retrieval/saving; it does not
isolate session history or remove cross-session tools.

An organization-key-created top-level session is `workspace_shared`. The
managed-human `user_private` / **Only me** capability requires the exact
supported managed-cookie human path and is not a service-backend privacy
mechanism. Creating an OpenGeni human per product user is not required for the
canonical backend integration.

When the product deliberately accepts a softer same-workspace boundary, an
explicit minimal `firstPartyMcpTools` selection can remove unnecessary
cross-session capabilities as defense in depth. It is not a hard tenant
boundary. Omitting `firstPartyMcpTools` inherits the deployment's non-connector
default catalog, and omitting `tools` inherits workspace MCP defaults; explicit
empty arrays suppress those respective selections. Recheck the live catalog
rather than assuming that removing only `sessions_list` and `session_get` is
complete.

Creating a workspace does not create a dedicated cluster or permanently
running sandbox. It adds control-plane state and may require per-workspace
settings, Connections, and Integration installations. Provisioning hundreds of
workspaces is therefore reasonable, but a per-chat design needs automated
reconciliation and cleanup rather than repeated manual setup.

## Choose the credential boundary

| Credential | Use it when | Do not use it for |
| --- | --- | --- |
| Organization API key | One server-side product integration provisions or manages many organization workspaces in one organization | Browser/mobile clients or Personal workspaces |
| Workspace API key | One backend or automation is deliberately constrained to a single organization workspace | Multi-workspace provisioning or organization administration |
| Delegated token | A host acts with short-lived, explicit user/workspace authority | A standing multi-tenant backend credential |
| Deployment access key | An operator needs a coarse configured/self-hosted deployment perimeter | Tenant identity, account selection, or workspace authorization |

An organization API key is the default for the product shape on this page.
Choosing it does not remove the product backend's obligation to authenticate
its own users and resolve their allowed tenant before every proxy call.

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
Personal workspaces belong to managed humans and are not product tenant
containers. Do not use `/v1/access/me`'s personal/default workspace as a
fallback for an external backend integration.

A server-side setup flow has this shape; use the request types exported by the
installed SDK as the exact schema authority:

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_ORGANIZATION_API_KEY!,
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
  memoryEnabled: true,
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

The external source/id pair is globally unique. Namespace `externalSource` to
the product and treat a `409` response as an identity already owned by another
organization, not as a successful replay.

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
    name: skill.name,
    description: skill.description,
    files: skill.files.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  })),
});
```

Every inline Skill must include a top-level `SKILL.md`; additional reference
files remain relative to that Skill directory. Skill content is session
configuration, not a secret store.

There is no organization-wide Skill registry or Skill inheritance for this
integration contract. Installing or selecting a Skill in the external product
does not make it ambiently available to all organization workspaces or later
sessions. The external backend remains the source of truth and passes the exact
selected Skills inline per product-created session.

Do not confuse inline session Skills with workspace `agentInstructions`,
session `instructions`, instruction policies, preference descriptors, Packs,
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
overrides. Workspace model access policy is the hard allowlist. Model ids and
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

Use `@opengeni/react/session` for headless session semantics, or the focused
styled subpaths when the product wants packaged OpenGeni visuals. The React
client contracts are structural: implement only the SDK methods required by
the mounted hooks and keep organization key administration and workspace
provisioning on the server.

For a browser timeline, proxy or re-stream the OpenGeni SSE connection through
an authenticated same-origin product route. `proxySessionEventStream` preserves
the SDK's reconnect, replay-by-sequence, gap backfill, and deduplication
behavior. Unknown additive event types must not crash the product UI.

The runnable [Northstar support example](../examples/northstar-support) shows a
server-held credential, a tenant-safe API/SSE proxy, authenticated product MCP,
and React composition. It uses a preselected workspace for demo setup; use the
organization-key and `ensureWorkspace` flow above for production tenant
provisioning.

Before replacing chat UI in a React host, compare packaged styled surfaces,
headless hooks/projections with customer-native components, and a fully custom
SDK UI. The styled package can be branded through its scoped compiled CSS and
`--og-*` tokens. For Svelte/SvelteKit, Vue, mobile, or other non-React hosts,
build framework-native components against authenticated product backend routes;
the backend may use the TypeScript SDK where compatible or the public HTTP
contract otherwise.

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
