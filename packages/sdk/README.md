# @opengeni/sdk

Framework-agnostic TypeScript SDK for the Opengeni public API: a typed client,
session lifecycle, and the streaming core — SSE event streaming with automatic
reconnect, resume-by-sequence, gap backfill, and duplicate suppression — plus
helpers for proxying the stream through your own API.

For the complete product boundary—organization API keys, organization
workspaces, Personal-workspace exclusion, tenant mapping, and external Skill
ownership—start with the canonical
[product integration guide](../../docs/product-integration.md).

Runtime dependencies are the published `@opengeni/contracts` wire schemas (which
bring Zod) and `@opengeni/connect`; nothing else. It needs only WHATWG `fetch`
and streams, so it runs in Node 18+, Bun, Deno, browsers, and edge runtimes.
The package is ESM-only (no `require` entry): use `import`, or `await import()`
from CommonJS.

Always pass `baseUrl` (for example `process.env.OPENGENI_API_BASE_URL`): the
chat facade defaults to production `https://app.opengeni.ai`, so omitting it
against a staging or self-hosted deployment silently talks to production.

Browser clients may call the public API from any origin with an explicitly safe
bearer design, but an organization API key belongs on the product server.
Browser cookies are accepted cross-origin only from operator-configured trusted
origins; arbitrary embedding origins never receive credentialed CORS responses.

## Allowance lifecycle recovery

`getWorkspaceAllowance(workspaceId)` still returns nullable configuration.
Use `getWorkspaceAllowanceState(workspaceId)` when you also need the lifecycle
version: `{ version: 0, config: null }` means never configured, while a positive
version with null configuration means cleared. Recreation uses that exact
version as `expectedVersion`.

`clearWorkspaceAllowance(workspaceId, { expectedVersion, operationId })` returns
`{ version }`. The optional operation ID makes a lost response recoverable:
reuse the same actor, operation ID and exact request. Replay rechecks current
authority and returns 409 after any later allowance lifecycle change. On 409,
read the current state and decide whether a new operation is intended; never
guess a CAS version. The SDK does not automatically retry mutations.

The same reads and administration are free functions on the
`@opengeni/sdk/usage-allowances` subpath for browser code that only has the
narrow `OpenGeniBrowserClient` (`getMyUsage(client, workspaceId)`,
`getAllUsage`, `setMemberAllowance`, ...); they call the same routes as the root methods.

State reads require the same budget-read authority as configuration reads.
Full usage additionally requires target workspace access; organization budget
authority alone does not expose the member roster. Agents cannot read or
change allowances.

## Embed the conversation (default)

Embedding Opengeni is one backend route plus one component, and you only speak
in your own ids. The browser renders `@opengeni/react`'s `OpenGeniChat` (or
`SessionConversation`); your server mounts `createSessionProxyHandler`, a
same-origin proxy that acts as your authenticated user:

```ts
// lib/opengeni.ts (server only: the organization API key never reaches the browser)
import { Opengeni } from "@opengeni/sdk/chat";

export const og = new Opengeni({ apiKey: process.env.OPENGENI_API_KEY! });
```

```ts
// app/api/opengeni/[...path]/route.ts (any web-standard host works; see the adapters below)
import { createSessionProxyRoute } from "@opengeni/sdk/next";
import { og } from "@/lib/opengeni";

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE } = createSessionProxyRoute(og, {
  resolve: async (request) => {
    const me = await authenticate(request); // your existing session check
    if (!me) return new Response("Unauthorized", { status: 401 });
    return { user: me.id, tenant: me.orgId }; // or { user: me.id }
  },
  createSession: (input) => input, // let the browser start chats
});
```

```tsx
// app/assistant/assistant.tsx (browser): no provider, client, or workspace id.
"use client";
import { OpenGeniChat } from "@opengeni/react";
import "@opengeni/react/compiled.css";

export function Assistant() {
  return <OpenGeniChat baseUrl="/api/opengeni" />; // chat list + conversation
}
```

`baseUrl` makes the component create the browser client for your mount and use
the workspace the proxy resolved for the signed-in user (reported in the
proxy's client config). One conversation alone is
`<SessionConversation baseUrl="/api/opengeni" sessionId={id} />`. The
`<OpenGeniProvider client={client} workspaceId={workspaceId}>` form keeps
working, for example for several components or the headless hooks.

What `resolve` returns decides the workspace:

- `{ user, tenant }`: one workspace per tenant; chats are private per user by
  default.
- `{ user }`: one workspace per user. It stays single-user: the SDK adds its
  owner once, and Opengeni never admits anyone else to it.
- `{ user, workspaceId }`: bring your own workspace id.

Workspaces are created on first use and cached per `Opengeni` instance.
`og.workspaceId({ tenant })` and `og.workspaceId({ user })` return the same ids
the proxy uses. There is no onboarding step: the first request a user makes
adds them to a tenant (or your own) workspace with conversation permissions
(workspace read, session create/read/control, file upload/read, and attaching
your per-session MCP servers; no admin). That needs an organization API key
with `members:manage` (full access includes it) plus those permissions.
Opengeni never changes an existing membership, so narrowing or widening one
with `updateExternalWorkspaceMember` sticks. A user you remove from a tenant
workspace is added again on their next request, because your product decides
who its users are; stop resolving a user you no longer admit. A removal from a
per-user workspace sticks. `organizationId` is optional:
the facade reads it once from the key. Keep `user` and `tenant`
host-authenticated, never from the request body or path.

The proxy and facade accept `chats`. `"private"` (the default with a user)
uses private visibility, session-only agent reach and personal Knowledge;
`"shared"` uses workspace visibility, agent reach and Knowledge, so a tenant's
users see each other's chats. Without a user and with `chats` omitted, the
facade keeps workspace visibility, session-only agent reach and Knowledge
authoring off. The API wire values are `visibility: "private" | "workspace"`;
stored visibility is `user_private | workspace_shared`. Explicit hook/create
fields override defaults. Keep MCP URLs and credentials in the server's
`createSession` hook; the browser cannot choose them through the proxy.

You can also pass a plain `OpenGeniClient` (organization key) instead of the
facade; then `resolve` must return `{ user, workspaceId }`. The explicit
membership APIs (`ensureWorkspace`, `addExternalWorkspaceMember`,
`updateExternalWorkspaceMember`, `cancelExternalWorkspaceMemberGrant`) keep
working for products that manage access themselves. Legacy
`chats: "isolated"` with `{ tenant, user }` still provisions a separate
workspace per user and tenant. Per-user workspaces add their owner with a
stable onboarding key, so a retry never restores a revoked grant;
`memberPermissions` replaces that owner's permissions on first onboarding
only. The standalone resolver is on the server-only
`@opengeni/sdk/tenant-workspaces` subpath.

The facade also accepts `agent` (identity, capabilities, instructions, renderer)
and defaults its renderer to `"markdown"`. Current servers always admit agent
configuration. For older servers that still gate it, only an implicit renderer
retries once without `agent` on `422 agent_config_not_enabled`, and that refusal
is cached per facade instance. Explicit agent settings are never stripped: the
422 names `OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED` for that older server's
operator. The private default with a user now turns personal Knowledge
on; pass `memory: false` to keep authoring off.
Missing organization private-session enablement raises `OpenGeniSetupError`,
with owner/admin API, SDK and web-app instructions; the proxy preserves that
actionable error for browser clients.

Framework adapters are thin wrappers over the same web-standard handler (they
also accept `createChatHandler` or any `(Request) => Promise<Response>`):

```ts
// Next.js App Router: app/api/opengeni/[...path]/route.ts
import { createSessionProxyRoute } from "@opengeni/sdk/next";
export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE } = createSessionProxyRoute(og, { resolve });

// Express / Connect / node:http (mount before body parsers, or they are re-serialized)
import { toNodeMiddleware } from "@opengeni/sdk/express";
app.use("/api/opengeni", toNodeMiddleware(handler));

// Hono
import { toHonoHandler } from "@opengeni/sdk/hono";
app.all("/api/opengeni/*", toHonoHandler(handler));
```

The Next adapter passes the full URL, including any `basePath`; the Node
middleware rebuilds it from `originalUrl`, streams bodies and SSE, and aborts
the request when the client disconnects.

The chat list (`SessionList` / `OpenGeniChat`) uses `listSessionPage`. By
default (`sessionList: "mine"`) the proxy adds a creator filter for the
resolved user server-side, so each user sees only the chats they started;
`sessionList: "visible"` lists every chat Opengeni lets the user read in the
workspace, and `false` disables listing. Archive and restore go through
`updateSessionArchive` unless `archive: false`. That personal archive only hides
a chat from one member's list. The deployment's idle-session archive is separate:
it makes long-idle sessions read-only and is reported on `session.retention`.
Pass `keepLive: true` to `createSession`, or call
`updateSessionRetention(workspaceId, sessionId, { keepLive: true })`, to keep a
persistent agent's session out of it. A "New chat" in `OpenGeniChat`
sends `{ initialMessage, idempotencyKey }` plus any attached file `resources`
and, unless `modelSelection: false`, the user's explicit model choices, so it
needs the `createSession` hook. The hook sees them as input; the proxy adds the
files and applies those choices to the request the hook returns. Voice input
(`POST .../transcriptions`) is forwarded as the resolved user unless
`voiceInput: false`. The client config the proxy serves reports what it can do:
`sessionCreation` (a `createSession` hook exists), `archive`, and `artifacts`
(`false` unless `artifacts: true`). The stock UI hides "New chat" and
"Archive" when they are off, shows Site previews as unavailable without a
request, and shows the composer microphone only when `voiceInput.available`.

Composer uploads are refused for anonymous visitors: return `visitor: true`
from `resolve` for a user your product has not signed in (for example a
website visitor keyed by a cookie), and the proxy reports file uploads off and
refuses the upload routes unless `visitorUploads: true`. Agent-produced media
still loads under `files`.

Live voice (speech-to-speech) is forwarded the same way unless
`realtimeVoice: false`. The stock conversation shows its voice button only when
you opt in, with `realtimeVoice: true` here (reported in the client config) or
the component's `realtimeVoice` prop. The proxy forwards the workspace's voice model catalog and the call routes
under `.../sessions/{id}/realtime` (start, provider connect, heartbeat,
activate, transcript sync, end). Opengeni still checks the user's
`sessions:control` permission, binds the call to that user and browser, runs
spoken requests as steers of the same chat, and meters deployment-funded voice
against your credits. `authorizeSession` runs on every call route, and
`beforeForwardMessage` sees `delivery: "realtime"` when a call starts (refuse
it, or return `mcpCredentialUpdates`; the proxy also refreshes the `toolServer`
token) and before transcripts and spoken requests are saved (refuse them, or add
`modelContext`, which must be the same when a request is retried).

`listSessionPage` includes personal pinned details by default. A caller with a
separate `pinsOnly: true` read can pass `includePinned: false` on ordinary pages
to avoid repeatedly loading those details. Ordinary pages still exclude pinned
rows; `pinsOnly: true` and `includePinned: false` cannot be combined. Older API
versions may ignore `includePinned` and return the default pin projection.

For navigation lists, `listSessionSummaryPage` uses the same filters, ordering,
pin rules and cursors, returning `SessionListEntry` records. Entries include
display/rename titles, creator, lifecycle, personal state, hierarchy counts and
the model and reasoning effort shown with a row; prompts and the rest of the
execution configuration remain on `getSession`. Older APIs return
full pages that the SDK projects locally. Unknown filters/cursors still fail
explicitly rather than returning an unfiltered result.

Every request calls `resolve`, then runs through `asUser(user, { source })`
(there is no service-authority fallback) against exactly the resolved
workspace. Only the native routes `OpenGeniProvider` and the conversation use
are served: client config; workspace read, model catalog, live control stream,
and workspace Resume; session read/rename, events (list and SSE with
`Last-Event-ID` resume), send/steer/approval/human-input, queue, composer
draft, pause/resume, and the session goal (read; pause/resume, forwarding only
`{ status: "paused" | "active" }`; and clear, the proxy's only `DELETE`); and, unless `files: false`, attachment upload and download
URLs plus the media the session produced (generated images and video,
published files, and browser or computer screenshots). Workspace-level
artifact reads (`artifacts/:id/content` with `Range`, `artifacts/:id/playback-source`)
must name their session in `x-opengeni-session-id`; the proxy runs
`authorizeSession` and forwards only an artifact Opengeni proves that session
produced. Every other route or method is a 404 (cancel and workspace Pause are
refused); unknown query parameters on served reads pass through. Browser session creation is disabled
unless you supply `createSession`; the browser may then send only
`initialMessage` and `idempotencyKey`, and your hook returns the full request
(tools, MCP servers, Skills, instructions, model policy). Message bodies are
capped by `maxBodyBytes` (1 MiB), cannot rotate MCP credentials or attach
anything but files, and `modelSelection: false` strips per-message model
choices. `authorizeSession(sessionId, context)` adds a product-level session
check on top of Opengeni's own membership and visibility checks. Without
`authorizeMutation`, only cross-site (`Sec-Fetch-Site`) mutations are refused,
so cookie-authenticated hosts should pass their CSRF check.

### Your own tools, as the signed-in user

`toolServer` attaches your product's MCP endpoint to every session the
`createSession` hook creates, with a short-lived token for the user `resolve`
authenticated. The proxy refreshes it on every send, steer, submit, approval,
and human-input answer. Your endpoint, built with any MCP library, verifies it:

```ts
createSessionProxyHandler(og, {
  resolve,
  createSession,
  toolServer: {
    url: "https://app.example.com/api/mcp", // public HTTPS (tunnel locally)
    approvals: { ask: ["rename_post"] }, // the user approves each call first
  },
});

// In the MCP route (Web Request, or an Express/Node request):
import { ToolRequestError, verifyToolRequest } from "@opengeni/sdk/tool-auth";
const { user, tenant, workspaceId } = await verifyToolRequest(request); // or ToolRequestError (401)
```

Scope every tool to the verified `user` and `tenant`; never trust ids the model
sends; list write tools in `approvals.ask`. Tools act as the chat's creator, also
in shared chats. Members need `mcp_servers:attach`. Tokens are HS256 JWTs signed
with a key derived from `OPENGENI_API_KEY` (or the same `secret` on both sides),
bound to the full tool URL by `aud` (set `OPENGENI_TOOL_SERVER_URL` to configure
both sides at once), and valid for `ttlSeconds` (default 24 hours). Non-Node
verifiers use the hex key from `deriveToolTokenKey()`, never the organization key;
the format is documented in `src/tool-auth.ts`. See
`examples/tool-server` for a runnable Express version.

`beforeForwardMessage(message, context)` runs before every forwarded user
message (send, steer, composer submit, and a browser-started create) and may
return server-owned additions, or a `Response` to refuse the message:

```ts
createSessionProxyHandler(og, {
  resolve,
  beforeForwardMessage: async ({ sessionId, delivery }, { user }) => ({
    // Model-visible, placed before any context the browser sent.
    modelContext: `Page ${currentPage(user)} · ${timeZone(user)} · ${today()}`,
    // Header-only rotation of MCP servers already attached to the session,
    // applied atomically as the message is accepted (ignored on create).
    mcpCredentialUpdates: [
      { id: "acme", headers: { Authorization: `Bearer ${await mintUserToken(user)}` } },
    ],
  }),
});
```

This is the per-user tool token pattern: create the session with
`mcpServers: [{ id: "acme", url, headers }]` (and `tools: [{ kind: "mcp", id:
"acme" }]`, which the acting user needs `mcp_servers:attach` to attach), then
hand the MCP server a fresh short-lived bearer on every message. The browser
still cannot send `mcpCredentialUpdates` itself. With `modelSelection: false`
the proxy reports `modelSelection: false` in the client config, and
`SessionConversation` hides its model picker.

Opengeni adds each user to the workspace on their first request (see
[External users](#external-users-asuser)), with `workspace:read`,
`sessions:create`, `sessions:read`, `sessions:control`, `files:upload`,
`files:read`, and `mcp_servers:attach`. Pass the facade from `@opengeni/sdk/chat`
instead of a client to resolve `{ tenant, user }` or `{ user }` to a workspace
created on first use.

## Quick start

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

const session = await client.createSession(workspaceId, {
  initialMessage: "Investigate the failing deploy on staging",
  resources: [{ kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" }],
  // Exact model-visible first-party surface; permissions remain independent.
  firstPartyMcpTools: ["set_session_title"],
});

for await (const event of client.streamEvents(workspaceId, session.id)) {
  if (event.type === "agent.message.delta") {
    process.stdout.write((event.payload as { text: string }).text);
  }
}
```

## Organization-backed product setup

A multi-tenant product should hold one organization API key on its backend and
idempotently map each product tenant to an Opengeni organization workspace. The
wire kind for an organization workspace is `"shared"`; Personal workspaces are
excluded.

```ts
const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

const organizationId = process.env.OPENGENI_ORGANIZATION_ID!;
const { workspace, created } = await client.ensureWorkspace({
  accountId: organizationId,
  externalSource: "acme-product",
  externalId: tenant.id,
  name: tenant.displayName,
});

if (workspace.kind !== "shared") {
  throw new Error("Product integrations require an organization workspace");
}
```

The response is `{ workspace, created }`. Replays return the original nested
workspace with `created: false`. For an organization key, `getAccessContext()`
does not enumerate every workspace grant; call `listWorkspaces()` for the
organization-workspace inventory allowed by the key's live scope.

Organization key administration uses `listOrganizationApiKeys`,
`getOrganizationApiKey`, `createOrganizationApiKey`, `updateOrganizationApiKey`,
and `deleteOrganizationApiKey`. GET detail and PATCH return the raw `ApiKey`;
creation returns `{ apiKey, token }`. The key token from a
create response is shown once and must be stored in the backend's secret
manager. `createOrganizationApiKey(organizationId, { name, access: "read" })`
mints a read-only master key: it inventories shared workspaces and reads their
sessions, events, and files, but cannot create sessions, send messages, or mint
keys. This legacy `access: "read"` tier is distinct from the broader explicit
`read_only` preset, which includes every read/list/view/search permission
except the secret-value reads `secrets:read` and `variable-sets:read`.

Create or edit with `policy: { preset, permissions, workspaceScope }` for exact
grants. `OrganizationAccessPreset` is `"read_only" | "full" | "custom"`;
the label never adds permissions and the server recomputes it from the selected
set. Explicit `full` selects every canonical non-deprecated permission; `custom`
has no implicit grants or scope. Even `workspace:admin` grants no wildcard under
an explicit policy. Scope is `{ kind: "all" }` (current and future shared
workspaces) or `{ kind: "selected", workspaceIds }` (up to 500 unique same-org
shared-workspace IDs; empty reaches none). Personal workspaces are always excluded.

`updateOrganizationApiKey(organizationId, apiKeyId, { name?, description?, policy? })`
requires at least one change; `description: null` clears it. Metadata-only edits
preserve legacy stored permissions and wildcard semantics. A policy edit replaces
the policy, transitions legacy keys to explicit semantics, and applies narrowing
on the next request without rotating the token. Omitting policy at creation
retains legacy `access`/`preset` inputs and the full legacy default.
See [the canonical policy guide](../../docs/product-integration.md#explicit-organization-key-policies).

Keys with session-read authority can call
`listOrganizationSessions(organizationId, { limit, cursor, scopeSubjectId, status })`
for one page of sessions across authorized shared workspaces (each row carries its
`workspaceId`; private sessions and Personal workspaces never appear), or
`iterateOrganizationSessions` to follow `nextCursor` to the end.

The external backend also owns its Skill catalog. Load the selected definitions
and pass them inline in `CreateSessionRequest.skills` for each product-created
session. There is no organization-wide Skill registry or Skill inheritance in
this integration contract. See the canonical guide for the complete route map,
security boundary, and delivery checklist.

Installed Skills can be workspace-managed or marked `session_selected`.
Session-selected guidance is exposed to no agent
until `createSession` names the reviewed immutable component in
`installedSkillIds`. Opengeni copies that exact artifact into the new session,
so omitting the field from customer-facing creates is a real contamination
boundary rather than a prompt convention.
The ordered selection is part of keyed-create identity: reusing an
`idempotencyKey` with a different selection returns a conflict instead of the
session configured by the earlier request.

For session lists, `deriveSessionDisplayTitle(session)` returns the durable
agent/user title when available. While the automatic title is still pending, it
shows the first short, sensitive-safe line of the opening prompt, skipping an
unsafe pasted URL or identifier when later safe text exists. If no safe line is
available, a short session reference keeps rows distinguishable. The display
automatically yields to the later `session.title_set` value.

Browser consoles that do not need operator-only surfaces can import
`OpenGeniBrowserClient` from `@opengeni/sdk/browser`. Document authority migration
and Default-collection backfill methods stay available on the backward-compatible
root and `@opengeni/sdk/core` clients, or through the focused
`@opengeni/sdk/document-authority` entry:

```ts
import { OpenGeniDocumentAuthorityClient } from "@opengeni/sdk/document-authority";

const operatorClient = new OpenGeniDocumentAuthorityClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});
```

## External users (`asUser`)

On a product backend, `client.asUser(externalId, { source? })` returns a separate
client that sends the external actor assertion with the organization key. IDs
are opaque and case-sensitive; the default source is `default`. Keep the key and
this client server-side. Each request requires the intersection of the key's
permissions and the user's workspace membership. API-key rotation does not
change the external identity.

Membership is automatic: when an `asUser` request reaches a shared workspace of
the key's own organization and the user has no membership there, Opengeni adds
one with conversation permissions (workspace read, session create/read/control,
file upload/read, `mcp_servers:attach`) and continues the request. This needs
the same authority as explicit onboarding: the key holds `members:manage` (or a
legacy `workspace:admin`) and every one of those permissions, with the
workspace in its scope; otherwise the request is a `403` as before. It never
applies to linked native identities, Personal workspaces, SDK per-user
workspaces (`opengeni-sdk:user-isolation:*` external source), other
organizations, requests that need a permission outside those defaults, or any
non-key caller, and it never changes an existing membership. The identity is
re-checked as active under the same lock, and the grant writes the same
receipt and lifecycle event as explicit onboarding, attributed to the key. A
user removed from a shared workspace is added again on their next request; a
suspended or offboarded identity stays refused.

Use the service client—not an `asUser` client—to call
`addExternalWorkspaceMember(workspaceId, { identity: { externalId, source? }, permissions })`
to choose permissions up front. It requires `members:manage`, cannot grant more
than the key permits, excludes Personal workspaces, and refuses to overwrite an
existing membership with different permissions (`409`, also when automatic
membership already created it); change an existing member's permissions with the keyed
`updateExternalWorkspaceMember(organizationId, workspaceId, organizationMembershipId,
{ operationId, permissions })`, which never tears down work. `asUser` calls never
reactivate disabled identities.

Service `removeWorkspaceMember` supports external members through the existing
fenced workspace teardown. Account-wide `updateExternalIdentityMembership(
organizationId, organizationMembershipId, { kind, expectedAuthorizationRevision,
operationId, reason? })` requires explicit `account:admin` and supports suspend,
reactivate, and offboard. The membership ID is returned by onboarding; its initial
authorization revision is 1. Retain the returned revision for subsequent changes.
Reactivation restores admission, not revoked memberships or work. Offboarding
follows existing retention policy and cannot be reactivated through this API.
Native-user targets and `asUser` calls are rejected by this service endpoint.

An `asUser` client can discover/access its own provisioned Personal workspace
under the key's permission ceiling. Core private session operations retain
organization readiness/settings and explicit sharing acknowledgments; service
clients gain no Personal-workspace fallback.

Optional native-account delegation uses `beginIdentityLink`, authenticated native
`previewIdentityLink`/`confirmIdentityLink`, and explicit server-side
`asLinkedUser(externalId, { source?, linkId, expectedLinkRevision })`. Confirmation
requires the actual native login plus the one-time host challenge; an organization
key cannot confirm for the native user. `listIdentityLinks(workspaceId, cursor?)`
returns only the effective participant's links in that organization (50 per page).
`revokeIdentityLink` requires the observed revision. Linking never changes ordinary
`asUser`, merges histories or transfers credentials. Link-dependent accepted work
retains revocation checks across schedules and children. Short-lived inline MCP
credentials remain supported, and durable renewal stays opt-in.

Connect accepts an optional `installationTarget: { instanceKey, displayName,
expectedInstanceVersion? }`. Keep the exact observed version for an existing named
account. Setup freezes the target through callback and operation review; omitting
it creates an independent named account instead of overwriting a default instance.

## Chat facade fallback (`@opengeni/sdk/chat`)

Use this only when your product already has its own chat UI speaking Vercel
`useChat` or an OpenAI-shaped protocol and you want a compatible drop-in
backend, or for server-side bots (`og.chat(...).send()`). It is a text-only
projection: tool outputs are dropped (the Vercel adapter emits no tool parts
by default, and only `output: { status }` with `toolParts: true`), there are no
files, attachments, artifacts, or images,
no goals/queue/steer UI, and reopening restores only a text snapshot. For
anything else, use [the default conversation embed](#embed-the-conversation-default).

One option object per conversation, one server handler for your endpoint.
Tenants map to organization workspaces, conversations map to deterministic
sessions, and the organization API key never leaves your server.

```ts
import { Opengeni, createChatHandler } from "@opengeni/sdk/chat";

const og = new Opengeni({
  baseUrl: process.env.OPENGENI_API_BASE_URL!, // omitted = production https://app.opengeni.ai
  apiKey: process.env.OPENGENI_API_KEY!, // the organization id is derived from the key
  source: "acme-app", // labels your product's tenants and users (default "app")
});

const chat = await og.chat({
  tenant: "acme", // one workspace per customer, created on first use; omit for one per user
  user: "u_42", // authenticated product user; added to the workspace on first use
  conversation: "c_9", // stable conversation id, independent of the acting user
  agentAccess: "session", // "session" (default) | "user" | "workspace"
  memory: "user", // "user" | "workspace" | false; session-only agent reach defaults to false
  create: { sandboxBackend: "none" }, // raw create-request passthrough for a pure chat
});

const reply = await chat.send("hello"); // creates the session on the first send
console.log(reply.text); // or String(reply); the answer, without progress commentary

// Per message: model policy and model-visible page context (not shown in the transcript).
await chat.send("Why did revenue dip?", {
  model: "gpt-5.5",
  reasoningEffort: "low",
  modelContext: "Viewing dashboard 42, range 2026-09-01..2026-09-28",
});

for await (const chunk of chat.stream("and then?")) {
  if (chunk.type === "text") process.stdout.write(chunk.text);
  if (chunk.type === "pending") await chat.respond({ requestId: chunk.pending.requestId, decision: "approve" });
}

// Your endpoint. `resolve` is your auth hook: identity comes from the request
// you authenticated, never from the body. The handler reads the client's
// conversation id itself (x-opengeni-conversation header, or the wire format's
// own field) and authorizes as `user`; return `conversation` from resolve only
// when the host names it, which is required when there is no `user`.
export const handler = createChatHandler(og, {
  resolve: async (request) => {
    const session = await getSessionFromCookie(request);
    if (!session) return new Response("Unauthorized", { status: 401 });
    return { tenant: session.accountId, user: session.userId };
  },
  // format: "vercel" | "openai-chat" | "openai-responses" (default "native");
  // a request may override it with the x-opengeni-chat-format header.
});
export const GET = handler; // conversation history, for restoring the chat on reload
export const POST = handler; // send a message, or answer a pending request at .../respond
```

Conversation IDs do not change with the acting user. Authorized collaborators
can use the same session; private visibility prevents access by other users.
Use `chatBySessionId` for existing and legacy user-namespaced conversations.
A user is added to the workspace on their first request (see
[External users](#external-users-asuser)). Without a `user`, the host must name the conversation
from `resolve`. The Vercel and OpenAI adapters send only the latest user
message; the earlier messages in that request are imported once, as context on
the first message of a conversation, after which Opengeni owns the history.

Pick the isolation per session with `agentAccess` (which other sessions the
agent may reach) and `memory` (what it remembers), all inside one workspace that
shares the customer's documents, instructions, and integrations:

| Scenario                                          | `agentAccess` | `memory`      |
| ------------------------------------------------- | ------------- | ------------- |
| Agent confined to its chat tree (support desk)    | `"session"`   | `false`       |
| One user's chats see each other, not other users' | `"user"`      | `"user"`      |
| Everything in the tenant shared                   | `"workspace"` | `"workspace"` |
| Shared agent access, no memory                    | any           | `false`       |

To keep an existing `useChat` route with its own request body, stream the chat
into your AI SDK response yourself. The Vercel format speaks the v1 UI message
stream used by AI SDK 5, 6, and 7 (tool approval requests need 6 or later):

```ts
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { uiMessageStreamParts } from "@opengeni/sdk/chat";

export async function POST(request: Request) {
  const { messages, dashboardId } = await request.json(); // your own body
  const me = await authenticate(request);
  const chat = await og.chat({ tenant: me.accountId, user: me.userId, conversation: me.chatId });
  const text = lastUserText(messages);
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const chunks = chat.stream(text, { modelContext: `Dashboard ${dashboardId}` });
      for await (const part of uiMessageStreamParts(chunks, { framing: false })) {
        writer.write(part as never);
      }
    },
  });
  return createUIMessageStreamResponse({ stream });
}
```

Opengeni's own tool activity is omitted by default because those tools are not
in your typed tool set; pass `toolParts: true` (or `createChatHandler(og, {
toolParts: true })`) to emit them as `dynamic`, provider-executed tool parts.
Pending approvals are always emitted as dynamic tool parts with a
`tool-approval-request`.

The chat handler is backend-only: connect a custom or compatible frontend to
its protocol. For the full React agent experience, use `SessionConversation`
with `OpenGeniClient` and authenticated session routes, not this simplified
chat protocol. The normal SDK preserves files, tools, approvals with policies,
forks, and realtime voice.

## Related-work discovery

`listAgentTopology` returns a bounded hierarchy page plus provider-neutral
`relatedWork` evidence. A text query searches durable semantic titles, active
goals, and typed work claims; it never searches the opening prompt. An exact
subject filter looks up one canonical typed identity:

```ts
const page = await client.listAgentTopology(workspaceId, {
  query: "permission scoped discovery",
  statuses: ["running", "requires_action"],
  activeOnly: true,
  recentHours: 72,
  claimLimit: 4,
});

for (const session of page.sessions) {
  if (!session.relatedWork.possibleOverlap) continue;
  console.log(session.title, session.relatedWork.match, session.relatedWork.claims);
}

const exact = await client.listAgentTopology(workspaceId, {
  subject: {
    namespace: "github",
    type: "pull_request",
    canonicalKey: "acme/app#42",
  },
});
```

The evidence is always advisory: `advisoryOnly` and `noAdditionalAccess` are
literal `true` fields, and receiving a row does not authorize detail, message,
or control operations. Preserve `nextCursor` with the exact same filters;
relevance cursors are filter- and activity-snapshot-bound. A topology response
may carry `humanAdvisoriesEnabled: false`, which lets a human-facing client hide
the advisory UI without changing stored evidence or API authority. See
[`docs/work-discovery.md`](../../docs/work-discovery.md) for ranking, bounds,
claim lifecycle, and rollout semantics.

## Full-history message search

`searchSessionMessages(workspaceId, { query, sessionId?, groupBy?, archiveStatus?, limit?,
cursor? }, { signal? })` searches durable user and **completed assistant** text,
including unloaded history. It returns every non-overlapping literal occurrence,
not tools, reasoning, model context, or delta-only assistant output.

Each match has a durable `eventId`/`sequence`, a UTF-16 `messageMatchOffset`, and
`snippet: { text, matchStart, matchEnd }` with original-text UTF-16 offsets.
Results include `nextCursor`, `hasMore`, cumulative `matchedMessageCount` and
`matchedOccurrenceCount`, `scannedMessages`, and `countIsExact`. Keep following
cursors even on empty pages while `hasMore` is true; counts are provisional until
exhaustion. Cancel superseded searches with the third argument's AbortSignal.
This is a live, authorized traversal rather than a frozen snapshot; restart to
refresh after concurrent history or visibility changes.

For workspace search, `groupBy: "session"` returns the first hit per matching
session and skips that session's remaining history, keeping prolific messages
from filling multiple picker pages. It cannot be combined with `sessionId`.
In grouped mode both matched counters count session representatives, not full
per-session message/occurrence totals; `scannedMessages` counts only visited
messages. Cursors bind the grouping mode. Omit it for every-occurrence Find.

The method and types are exported from the ordinary SDK and browser entry.
Use `listEventPage` around the hit's sequence for bounded context, and use the
returned search snippet when a large source message's ordinary projection does
not include the hit. Never download complete history to perform Find locally.
See [the API contract and bounds](../../docs/session-message-search.md).

## Session visibility and forks

For organizations with session-tenancy activation, a canonical managed-cookie
owner can change a fully quiescent session between private and workspace
visibility or create an independent same-workspace private or workspace-visible fork. API keys and
delegated/service bearers are intentionally not authority for these methods.
The browser client below intentionally omits `apiKey`; its same-origin request
carries the authenticated managed-session cookie.

```ts
const browserClient = new OpenGeniClient({ baseUrl: window.location.origin });
const current = await browserClient.getSession(workspaceId, sessionId);
if (!current.tenancy) throw new Error("Session tenancy is not activated");

await browserClient.updateSessionVisibility(workspaceId, sessionId, {
  visibility: "private",
  expectedAuthorityEpoch: current.tenancy.authorityEpoch,
  idempotencyKey: crypto.randomUUID(),
});

const fork = await browserClient.forkSession(workspaceId, sessionId, {
  idempotencyKey: crypto.randomUUID(),
  visibility: "workspace",
  // Required when private conversation content is copied into workspace scope.
  workspaceSharedAcknowledged: current.tenancy.visibility === "private",
});
```

Retain each idempotency key until the request has a known outcome. If a
transport failure reports `outcomeUnknown`, retry the same operation with the
same key. An authority-epoch conflict requires a fresh `getSession` and a new
user decision. A quiescence conflict identifies the stable blocker after live
turns, goals, realtime, schedules, workspace writers, retained processes, and
sandbox access have been settled. Forks copy exact same-workspace durable
conversation content but no live turn, goal, credential, Connection/delegation,
personal grant, Variable Set, Sandbox Environment, MCP server configuration, process, sandbox
identity, pin, or workflow. Destination visibility and acknowledgement are
idempotency-bound.

## Archived session history import (server only)

Use `@opengeni/sdk/session-history-import` to migrate historical conversations
into read-only archives. These functions take `client` first, use its ordinary
`requestJson` transport, and are not eager client methods or root helper exports:

Create requires `sessions:create`; append requires `sessions:control` and the same
authenticated importer. With `asUser`, the user's permissions apply rather than
the organization key's permissions.

```ts
import { OpenGeniClient } from "@opengeni/sdk";
import {
  importArchivedSession,
  appendArchivedSessionEvents,
} from "@opengeni/sdk/session-history-import";

const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});
// Existing tenant mapping; the original creator is admitted on first use.
const actor = og.asUser(originalExternalUserId, { source });
const imported = await importArchivedSession(actor, workspaceId, {
  importId: "embedded:thread-42", // Stable; persist the exact request before sending.
  title: "Original conversation",
  createdAt: "2025-04-01T09:30:00Z",
  visibility: "user_private",
});
const appended = await appendArchivedSessionEvents(actor, workspaceId, imported.importId, {
  batchId: "thread-42:batch-0001", // Stable; also persist this exact body first.
  offset: imported.nextOffset,
  events: [{
    type: "agent.message.completed",
    createdAt: "2025-04-01T09:31:00Z",
    payload: { text: "Historical answer", channel: "final" },
  }],
});
// Persist imported.session.id and appended.nextOffset in the migration ledger.
```

External mapping equivalents take `(client, source, externalId, ...)`:
`importExternalWorkspaceArchivedSession` and
`appendExternalWorkspaceArchivedSessionEvents`. These resolve an existing
mapping; neither import form creates a workspace or grants membership. A bare
organization key creates a shared, ownerless archive. Use `asUser` for the
verified creator/owner; private imports require existing private-session
enablement. Preserve source visibility rather than widening it on failure.

The subpath exports `ImportArchivedSessionRequest/Response`,
`AppendArchivedSessionEventsRequest/Response`, `ArchivedSessionImportEvent` and
`SessionImportedArchive` types. Requests accept at most 100 events / 1 MiB
serialized UTF-8 JSON and 256 KiB per event. IDs and titles are bounded to 200
characters. Import events default to `[]`; append batches must be non-empty.
Events carry `{ type, createdAt, turnId?, payload }`: a finite supported historical
type, ISO timestamp, optional UUID/null correlation and JSON-object payload.
Source timestamps support at most millisecond precision; normalize finer dates
explicitly and retain originals in the ledger. Negative-zero JSON is rejected.

Exact create replay returns `created: false`; exact append replay returns
`replayed: true`. `offset` is a zero-based imported-event count, not a timeline
sequence. Retain the exact actor, mapping, IDs, offset and bodies for uncertain
retries; new batches use the acknowledged `nextOffset`. Changed key reuse or
an out-of-order new offset returns 409. Helpers propagate `OpenGeniApiError`,
including `outcomeUnknown`, and do not automatically retry mutations.

Import is timeline-only: completed messages, calls/results and goals may be
historical facts, but no model-facing history, live goal, pending decision or
execution is restored. `session.importedArchive` has
`{ importId, importedAt, readOnly: true }`, independent of personal archive state.
Render through the unchanged `SessionConversation` and session proxy; never
offer Send or Steer. Continuing an imported archive is unsupported in v1.
The proxy does not expose import routes. Re-upload files through existing APIs
and replace references before import; preserve additional source metadata and
source/destination IDs in the host ledger. See
[Migrating from embedded Opengeni](../../docs/product-integration.md#migrating-from-embedded-opengeni).

## Connected accounts

Authenticated messages use the initiating user's eligible connected accounts.
Conversation visibility does not share account access. Queued work, retries and
child work retain the initiating user. No per-conversation connection grant is
required. Multiple eligible accounts require an explicit account choice:

```ts
const accounts = await browserClient.listOwnConnectionAccounts(workspaceId);
// When choosing among multiple accounts, use the exact eligible server/account pair.
const selection = { serverId: "mail", connectionId: accounts[0]!.id };
```

General personal-resource grants for documents, variable sets and other resource
kinds remain available through the root/core SDK. They do not authorize native
connected accounts.

## Workspace credentials, webhooks, and sandbox image

Configure these with an organization key or workspace admin session. Secrets are
returned once; store them when you create the resource. Protocol and payloads:
[`docs/workspace-integrations.md`](../../docs/workspace-integrations.md).

```ts
const { secret: providerSecret } = await client.putWorkspaceCredentialProvider(workspaceId, {
  url: "https://product.example/opengeni/credentials",
});
const { secret: webhookSecret } = await client.createWorkspaceWebhook(workspaceId, {
  url: "https://product.example/opengeni/events",
  eventTypes: ["turn.completed", "turn.failed"],
});

// In your HTTP handlers, verify the raw body before parsing it:
const { event } = await verifyWebhookEvent({ body: rawBody, headers, secret: webhookSecret });
const request = await verifyCredentialProviderRequest({
  body: rawBody,
  headers,
  secret: providerSecret,
});
```

To check an endpoint now, `testWorkspaceWebhook(client, workspaceId, webhookId)` sends a
signed `webhook.test` event (acknowledge it with any 2xx) and
`testWorkspaceCredentialProvider(client, workspaceId)` sends a request with
`purpose: "test"`; both come from `@opengeni/sdk/workspace-integrations` and return
what the endpoint answered, naming returned credentials but never their values.

`listWorkspaceSandboxImages` returns the deployment's allowlisted images; set one
with `updateWorkspaceSettings(workspaceId, { defaultSandboxImage })`.

## Personal schedules

A schedule created by an authenticated human or their active agent records that
human as its immutable owner. Only that owner or their verified agent may edit,
run, pause or delete it. Each occurrence resolves the owner's current accounts;
accepted retries retain their original identity and account selection.

```ts
const task = await client.createScheduledTask(workspaceId, {
  name: "Daily triage",
  schedule: { type: "calendar", hour: 8, minute: 0, timeZone: "Europe/Oslo" },
  runMode: "reusable_session",
  agentConfig: { prompt: "Triage the new support issues" },
  connectionAccounts: [selection],
});
```

Account selections narrow eligible accounts; they never transfer ownership.
Omitting `connectionAccounts` on update preserves the selection. Passing an
empty array clears explicit account choices without changing the schedule owner.
Service-owned schedules retain service execution and do not acquire a human's
personal accounts. Run history remains credential-free.

A schedule freezes its connectors, accounts and (when an agent created it)
Opengeni tools. For the owner, `listScheduledTasks` and `getScheduledTask`
include a read-only `policyDrift` naming what is out of date, and
`listScheduledTaskRuns` includes `accessFailures` for runs that could not use a
connector. `listScheduledTaskAccessAttention` lists schedules whose latest run
failed that way, and schedules that cannot start because a chosen account can no
longer be used (`unavailableAccounts`, with a null `runId`). A signed-in owner
re-freezes with their current access through
`refreshScheduledTaskAccess(workspaceId, taskId, { executionDigest, leaveOut })`,
where the optional `leaveOut` keeps named default connectors or Opengeni tools
off; API keys and agents cannot. See [`docs/scheduled-task-access.md`](../../docs/scheduled-task-access.md).

Deleting a task is externally idempotent and immediately removes it from live
lists and quota, but the server retains a tombstone plus run/session/turn audit
evidence until workspace/account retention cleanup. A stable `triggerId` is
still required when a caller wants manual-trigger retries to coalesce; ordinary
scheduled fires derive their producer identity from the Temporal fire workflow.

## Realtime browser controller (`@opengeni/sdk/realtime`)

The public realtime subpath owns the provider-neutral browser controller and
the existing Codex Live, WebRTC/V3, and AI Gateway transports. It selects the
transport from the catalog model without changing the backend API, durable
ledger, delegation, context, or recovery semantics:

```ts
import { OpenGeniClient } from "@opengeni/sdk";
import type { SessionRealtimeClientLike } from "@opengeni/sdk/realtime";

const client = new OpenGeniClient({ baseUrl: "/opengeni-api" });
const realtimeClient: SessionRealtimeClientLike = client;
const catalog = await realtimeClient.getWorkspaceRealtimeModelCatalog(workspaceId);
const model = catalog.models.find((candidate) => candidate.available)?.id;
if (!model) throw new Error("No realtime model is available");

// Lazy import keeps the base SDK entry safe for server and non-realtime hosts.
const { createSessionRealtimeController } = await import("@opengeni/sdk/realtime");
const controller = createSessionRealtimeController({
  client: realtimeClient,
  workspaceId,
  sessionId,
  model,
  remoteAudio,
});

const unsubscribe = controller.subscribe((snapshot) => {
  console.log(snapshot.status, snapshot.microphone, snapshot.diagnostic);
});
await controller.start();

// Later:
await controller.stop();
unsubscribe();
controller.close();
```

`SessionRealtimeClientLike` is the exact proxy-friendly backend surface:
catalog, begin, Codex/Gateway negotiation, activation, heartbeat, ledger sync,
and end. Existing `OpenGeniClient` methods remain the implementation. Current
Codex-named controller and transport exports remain available as compatibility
aliases, but new integrations should use the provider-neutral names.

Do not put API credentials in browser bundles. Browser hosts should either use
the deployment's normal browser authentication or expose these same methods
through a tenant-scoped, same-origin proxy. The SDK does not move persistence,
prompt construction, context processing, delegation, or provider credentials
out of `apps/api`, `apps/worker`, or `packages/db`.

## Editable artifact sync (`@opengeni/sdk/editable-artifacts`)

Editable-artifact storage, sync, and Worker clients live behind an isolated
subpath; importing the ordinary SDK never loads them. Browser hosts should
bundle the dedicated module-Worker entry and pass its URL plus the exact,
version-matched kernel assets to the client:

```ts
import { OpenGeniClient } from "@opengeni/sdk/artifacts";
import workerUrl from "@opengeni/sdk/editable-artifacts/worker?worker&url";
import {
  createBrowserEditableArtifactSession,
} from "@opengeni/sdk/editable-artifacts";

const client = new OpenGeniClient({ baseUrl: process.env.OPENGENI_API_BASE_URL! });
const artifact = await client.getEditableArtifact(workspaceId, artifactId, {
  replicaId,
});
const kernels = {
  spreadsheet: () => import("@opengeni/artifact-kernel-wasm-spreadsheet"),
  document: () => import("@opengeni/artifact-kernel-wasm-document"),
  presentation: () => import("@opengeni/artifact-kernel-wasm-presentation"),
} as const;
const { editableArtifactKernelRuntime } = await kernels[artifact.modality]();
const session = createBrowserEditableArtifactSession({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  workspaceId,
  artifact,
  storageAuthority,
  runtime: {
    workerUrl,
    ...editableArtifactKernelRuntime,
    applicationOrigin: window.location.origin,
  },
});
```

Each kernel package contains only one editor modality, carries a static typed
build/protocol/model/command identity, and is reproduced from smoke-tested Rust
outputs under separate raw and gzip budgets. The Worker verifies that identity
against executable WASM capabilities before accepting state. A self-hosted host
may instead serve the exact version-matched glue and WASM binary together.
Canonical OGASC commands, OGATX intents, OGACO commits, and OGAKQ/OGAKV
queries/projections pass directly through the kernel; there is no JavaScript
operation mapper.

The live transport mints a short-lived, one-use ticket over authenticated HTTP,
then sends that ticket inside the first binary OGALV WebSocket frame. API keys
and long-lived credentials are never placed in the WebSocket URL. Hosts may
inject both `fetch` and the WebSocket factory for authenticated proxies and
tests; negotiated frame and mutation limits are enforced before work is queued.

## Browser and computer interaction (`@opengeni/sdk/interaction`)

An interaction **resource** is a workspace-scoped, durable object with a stable
id and lifecycle, such as a `BrowserSession`, `ComputerSession`, browser
identity, network route, auth run, or pending human intervention. This use of
"resource" is unrelated to the file/repository `resources` attached to a chat
message. A **facade** is only the typed, resource-oriented SDK organization
shown below; it owns no state or authority of its own.

`OpenGeniClient.interaction` is the framework-free resource facade over the same
public BrowserSession, ComputerSession, identity, auth, network-route, and human
intervention APIs used by Opengeni itself. It adds no second state or execution
path: facade methods call the ordinary typed transport, and every mutation still
uses the canonical generation fences, operation receipt, permission check, and
placement controller.

```ts
const browser = await client.interaction.browsers.currentOrOpen({
  workspaceId,
  associationSessionId: session.id,
  initialUrl: "http://127.0.0.1:3000",
});

const { targets } = await browser.tabs.list();
const target = targets.find((candidate) => candidate.selected) ?? targets[0]!;
const page = await browser.observe(target.id);
const screenshot = await browser.screenshot(target.id, { fullPage: true });
// screenshot.data is bounded image bytes; mediaType and dimensions travel with it.

const receipt = await browser.act({
  operationId: crypto.randomUUID(),
  targetId: target.id,
  expectedTargetGeneration: target.targetGeneration,
  expectedDocumentGeneration: target.documentGeneration,
  expectedFrameId: page.frameId,
  action: { type: "click", locator: { kind: "role", role: "button", name: "Continue" } },
});

if (receipt.state === "outcome_unknown") {
  // Do not replay a mutation blindly. Re-observe, then inspect this exact receipt.
  console.log(await browser.receipt(receipt.operationId));
}
```

`browser.targetState(targetId)` reads generation fences without an accessibility
tree. `browser.readDom(targetId, request)` returns a bounded element or count
query using those fences; sensitive values are redacted.

The flat `client.openBrowserTargetWithInventory(workspaceId, browserSessionId,
{ url })` explicitly opens a tab and returns the owned tab inventory and its
generation fences without a page observation. The default
`client.openBrowserTarget(...)` and `browser.tabs.open(...)` still return page
observations. Older controllers can refuse the inventory method; do not retry an
uncertain creation through another tab-open method.

Browser identities are immutable version graphs: live browser state stays
private until `browser.publishRevision(...)` explicitly creates a new revision.
Protected auth fills resolve connection secrets only inside the broker/controller
path; normal SDK reads, observations, diagnostics, receipts, and logs never
return credential values. `client.openWorkspaceInteractionRevisionStream(...)`
is the low-volume latest-wins invalidation stream for keeping resource catalogs
fresh without attaching them to an inference/session event stream.

Use the flat `OpenGeniClient` interaction methods when implementing a proxy or
custom transport. Use `client.interaction` for application logic. Both are the
same API and authority boundary.

## Workspace artifacts

Workspace artifacts are generic, immutable HTML publications. The SDK does not
assign product types such as app, page, dashboard, or gallery. List pages are
bounded and expose both `truncated` and an opaque `nextCursor` so callers never
mistake a partial page for the complete workspace catalog.

Each Site version retains one self-contained executable HTML runtime, its
bounded editable source bundle, and the exact canonical tool identities it
requested. The web host renders that runtime in an opaque-origin sandboxed
iframe. Credentials, cookies, API URLs, workspace ids, and parent DOM authority
never enter the iframe; `@opengeni/sdk/site` uses a single parent-owned
`MessagePort` that exposes only the retained tool allowlist intersected with the
current viewer's live workspace catalog.

```ts
let cursor: string | undefined;
do {
  const page = await client.listWorkspaceArtifacts(workspaceId, {
    limit: 50,
    ...(cursor ? { cursor } : {}),
  });
  for (const artifact of page.artifacts) console.log(artifact.title);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

Creation and publication require a caller-supplied idempotency key. Reuse the
same key only to retry the same logical mutation. Agent-authored versions also
return the exact source session, turn, attempt, and execution generation that
published them. Version and event history are bounded; inspect
`versionsTruncated` and `eventsTruncated` on the detail response.

## Workspace tools

The browser-safe SDK exposes the same gateway catalog and executor used by
model MCP calls and Codemode. Generated declarations augment the lazy namespace
for exact installed-tool types; canonical `{ serverId, toolName }` identity and
the server-side catalog remain authoritative.

Known calls use `POST tools/invoke` directly, with no preceding workspace
catalog request. The API selects one exact authorized account/connector; a
selected MCP provider may still require its own `tools/list`. Symbolic paths
use the canonical registry projection and reject ambiguity before connecting.
Cold calls use the current definition. `$resolve({ identity })` returns one
entry and a `definitionDigest`; pass it as `expectedDefinitionDigest` to require
that complete public definition before execution. Digests never grant access.
Returned executed metadata preserves structured-output unwrapping without a
catalog load.

`$catalog()` and `$declarations()` remain explicit full discovery. For an older
API or Site host, set `toolGatewayMode: "catalog"` explicitly on the client;
there is no automatic downgrade or retry after an unknown invocation outcome.
The targeted SDK caches bounded per-target metadata, shares only resolution
loads, and retries at most once after a typed pre-execution
`tool_definition_stale`; explicit nonretryable or outcome-unknown flags veto
replay even when a transport labels an error stale. Explicit pins are not
silently dropped when malformed: only `undefined` means no explicit pin.
The same retry veto applies to retained v1/catalog mode and Site host adapters.
For saved Site bundles with code-only retry classifiers, the host's legacy call
projection wraps executed stale-named provider errors as
`site_tool_execution_failed`, retaining the complete original diagnostic at
`result.structuredContent.error.providerError`. Success outputs and ordinary
provider errors are unchanged; genuine known preexecution stale refresh remains
available. Stale-named transport errors without that proof use
`site_tool_call_failed` and retain the original code in their message.
Pins are not silently advanced. An approved call uses the server's executable-effect and
private-authority binding, not an implicit full-public-entry pin; supply
`expectedDefinitionDigest` when that additional precondition is wanted.
Changed executable effect or private authority requires reapproval. Operation IDs are correlation
keys, not general idempotency for unapproved calls.

```ts
const tools = client.tools.forWorkspace(workspaceId);
const documents = await tools.docs.search({ query: "launch plan" });
```

An approval-required call needs a server-issued capability. A trusted host
shows its approval UI first, then asks for one token bound to the current human,
workspace, operation id, exact tool identity, executable effect, Site context,
private authority and arguments. Targeted approvals use a distinct version-2 binding, never a v1
catalog digest.
An Ask-to-Allow policy transition can settle matching pending provenance with
or without the token, but never ignores a supplied invalid token or a consumed
operation. Public definition pins remain optional and may reject policy/prose
drift without consuming the pending approval.
The token expires after five minutes, is stored only as a hash, and is consumed
once by the matching call.

Connection-backed tools configured for both provider policy and one-shot human
approval are omitted from this HTTP catalog until their provider adapter can
preflight credential and resource authorization before consuming the token.

```ts
const operationId = crypto.randomUUID();
const identity = { serverId: "linear", toolName: "issues_update" };
const input = { issueId, state: "Done" };
const approval = await tools.$approveTarget(identity, input, { operationId });

await tools.$call(identity, input, {
  operationId,
  approvalToken: approval.approvalToken,
});
```

The retained `$approve()` method and explicit `toolGatewayMode: "catalog"` use
the legacy protocol described below. Tokens returned by `$approve()` on the
same facade retain that routing; externally retained legacy tokens must pass
`approvalBinding: "catalog"`. Never reinterpret a legacy token as a targeted
approval.

When a legacy call or approval request receives the typed
`409 details.code = "catalog_stale"` response, the SDK refreshes the catalog,
re-resolves the exact identity or generated namespace path, preserves the
operation id (generating it before the first attempt when omitted), and retries
once. A call that already carries an approval token cannot reuse that
single-use capability after the catalog digest changes; instead it throws
`OpenGeniToolReapprovalRequiredError` with the refreshed identity and digest so
the trusted host can show approval again for the same operation id.

Concurrent callers share one in-flight catalog request (`$catalog` and every
call path). Each caller's `signal` cancels only its own wait; the shared request
is cancelled only when every waiter has aborted, and a failed load is not
cached. Calls rejected as stale on the same digest share one refresh started
after the first such rejection while it remains the current catalog, and an
explicit `$catalog({ refresh: true })` always starts a new request.

A call's `catalogDigest` is checked against the exact catalog entry it invokes:
the API may accept an unchanged entry from a catalog digest whose unrelated
entries have since changed, and then echoes that digest in the response. A
changed, removed, or no-longer-authorized target entry still returns
`catalog_stale` before execution.

Reapproval is valid only before the original capability is consumed. Once a
call crosses that boundary, the server retains a hash-only tombstone for the
operation id and rejects another approval with
`409 details.code = "tool_gateway_operation_already_started"` and
`outcomeUnknown: true`. The host must reconcile the provider outcome; it must
not turn an ambiguous call into a second approved execution by minting a fresh
operation id automatically.

Do not request approval capabilities speculatively or expose them to Site iframe
code. The host projects only the active immutable version's requested identities,
supplies the Site context on direct calls, and the server revalidates the active
version and viewer's live authority. The requested set is a maximum allowlist,
not an authority grant; ordinary gateway approval still applies. Archived Sites
receive no tool bridge.

An upgraded host advertises targeted calls to modern Site clients. Existing
bundled Site clients retain their catalog/call protocol: the host obtains a
bounded manifest for only that saved version's requested identities and
translates calls using retained per-entry pins. They still make their initial
catalog request; republishing with the modern client removes it. Unknown or
evicted manifest digests fail before execution. Host-owned Site/version context
and approval tokens are stripped from iframe requests. Local previews instead
use their frozen attempt catalog and existing Codemode operation journal.

Omit `firstPartyMcpTools` for the complete Opengeni tool catalog. An explicit
`[]` exposes no broad first-party tools; attached resources and separately
selected `files`/`docs` MCP servers are unaffected.

## MCP tool output normalization

MCP transports and event stores can represent the same tool result as a direct
object, JSON text, a text content block, or nested `result`,
`structuredContent`, and `content` envelopes. Use the shared zero-dependency
normalizer when an embedding host needs one stable interpretation:

```ts
import { normalizeMcpOutput } from "@opengeni/sdk";

const normalized = normalizeMcpOutput(toolOutput);

normalized.value; // canonical machine-readable value
normalized.text; // presentation text
normalized.isError; // preserved across recognized nested envelopes
normalized.raw; // original evidence
```

Malformed text and unknown objects pass through without throwing. Envelope
recognition is deliberately conservative: an ordinary domain object is not
unwrapped merely because it has a field named `result`.

## Error handling

Non-2xx responses throw `OpenGeniApiError` with stable transport metadata:
`status`, optional `code`, `retryable`, optional `correlationId`,
`outcomeUnknown`, and a bounded structured `body`. The SDK sends a fresh bounded
correlation ID on each API request and includes the safe returned reference in
the display message.

```ts
import { OpenGeniApiError } from "@opengeni/sdk";

try {
  await client.sendMessage(workspaceId, sessionId, input);
} catch (error) {
  if (error instanceof OpenGeniApiError && error.outcomeUnknown) {
    // Reconcile durable state, then retry only with input.clientEventId unchanged.
  }
  throw error;
}
```

Error bodies are read only when they are JSON and no larger than 16 KiB; raw
gateway HTML/plain text and oversized bodies are discarded. A controlled typed
API rejection has `outcomeUnknown: false`. A raw `502`/`503`/`504` or an
unexpected successful non-JSON response to a mutation has `outcomeUnknown:
true` because the mutation might already have been accepted. Never turn that
condition into a new operation by changing its idempotency key.

## Streaming guarantees

`client.streamEvents(...)` (and the underlying `streamSessionEvents`) delivers
each session event **exactly once, in order**, anchored on the per-session
contiguous `sequence` number:

- Reconnects transparently on transient drops (network failures, 5xx, 429),
  resuming from the last seen sequence via `?after=`.
- Suppresses duplicates when server replay overlaps what was already seen.
- Backfills any gap observed on a live connection from the durable replay
  endpoint (`GET .../events?after=`) before yielding newer events.
- Ends gracefully when the provided `AbortSignal` aborts; throws on
  non-retryable failures (e.g. 401/403/404).

Use `client.listEventPage(...)` when monitoring another session. A call without
a cursor is safe by default: it returns a newest-first-selected (but
ascending-in-response) semantic tail, uses bounded `summary` payloads, and omits
raw message/reasoning/command/PTY deltas. The page returns exact
`coveredSequence`, `nextBefore`/`nextAfter`, byte, truncation, and projection
metadata. Filters can select canonical event types or the `control`, `terminal`,
`failure`, `checkpoint`, `tool_receipt`, and `provider_account` semantic classes;
`latest` is an exclusive typed lookup that returns the newest event in exactly
the requested class. It cannot be combined with any type or class include/exclude
filter, so an unrelated newer event cannot displace the requested result and an
exclusion cannot remove it.

For callback-loss recovery, `latest` selects authoritative current/legacy rows
by durable session `sequence` across distinct turns; explicit `late_rejected` and
`duplicate` callbacks never compete with current truth. `turnGeneration` remains
metadata and is interpreted only within its turn/retry scope. Use
`resultMode: "compact"` to receive one bounded result-bearing completion,
failure, checkpoint, or receipt without creating another model turn. The
`receipt` spelling aliases `tool_receipt`, and a missing event returns `null`.
The compact result includes exact source/generation/covered-sequence facts and
bounded text/output/result/failure/checkpoint/receipt values. Retained-output
storage and full-evidence retrieval are separate contracts from this event
projection.

```ts
const terminal = await client.listEventPage(workspaceId, sessionId, {
  latest: "terminal",
  payloadMode: "summary",
});

const recovered = await client.getLatestEventResult(workspaceId, sessionId, {
  latest: "terminal",
});

const older = await client.listEventPage(workspaceId, sessionId, {
  before: terminal.nextBefore ?? undefined,
  includeClasses: ["failure", "checkpoint"],
  payloadMode: "none",
});
```

Use explicit `mode: "forensic", payloadMode: "full"` with `after`/`before` for
exact retained audit replay. “Full” means the exact durable audit projection;
it cannot restore source bytes that the audit boundary never retained. REST/SDK
pages remain count- and byte-bounded, so continue with the returned cursor. The
convenience `client.listEvents(...)` returns only the page's event array. Pass
`compact: true` for forensic history windows that do not need individual delta
fragments; delta runs may be coalesced and expose `payload.coalescedUntil` as
the true last sequence for stream resume cursors.

```ts
const controller = new AbortController();
for await (const event of client.streamEvents(workspaceId, sessionId, {
  after: lastSeenSequence,
  signal: controller.signal,
  onStateChange: (state) => console.log("stream:", state),
})) {
  // ...
}
```

## Messages, the turn queue, and steering

Messages sent while a turn is running **queue by default** — visible,
editable, reorderable, and deletable until the worker claims them. Steering is
the explicit alternative: deliver now by interrupting the running turn.

```ts
// Queue (default): stacks behind the running turn.
await client.sendMessage(workspaceId, sessionId, {
  text: "Also check the nginx config",
  clientEventId: crypto.randomUUID(),
});

// Steer: send + promote to the queue front + interrupt the running turn.
await client.steerMessage(workspaceId, sessionId, {
  text: "Stop — prod is paging, look at that first",
  clientEventId: crypto.randomUUID(),
});

// Manage the server-authoritative queue while it waits.
const queue = await client.getQueue(workspaceId, sessionId);
const waiting = queue.items.at(-1)!;
await client.moveQueueItem(workspaceId, sessionId, waiting.id, {
  expectedQueueVersion: queue.version,
  beforeTurnId: queue.items[0]?.id ?? null,
  clientEventId: crypto.randomUUID(),
});
await client.editQueueItem(workspaceId, sessionId, waiting.id, {
  expectedTurnVersion: waiting.version,
  expectedDraftRevision: 0,
  replaceDraft: false,
  clientEventId: crypto.randomUUID(),
});

// Pause/Resume is recursive workstream control; it creates no queue row.
await client.pauseSession(workspaceId, sessionId, {
  reason: "hold this workstream",
  expectedControlEtag: queue.effectiveControl.controlEtag,
});
const paused = await client.getQueue(workspaceId, sessionId);
await client.resumeSession(workspaceId, sessionId, {
  expectedControlEtag: paused.effectiveControl.controlEtag,
});
// Cancel is irreversible: it drains and fences this session subtree.
await client.cancelSession(workspaceId, sessionId, {
  reason: "host record deleted",
  clientEventId: crypto.randomUUID(),
});
// approvalId is `approvals[].id` from the latest `session.requiresAction`
// event (type SessionApprovalRequest: { id, name, arguments }); it is the
// pending tool call id, not the event id.
await client.sendApprovalDecision(workspaceId, sessionId, { approvalId, decision: "approve" });
```

## Retry a failed session without changing its intent

Try again is separate from Pause/Resume and `sendMessage`. Retain the request
across an ambiguous transport response; never synthesize a continuation prompt:

```ts
const retryRequest = {
  clientEventId: crypto.randomUUID(),
  failureEventId, // the current durable turn.failed event id
  model: selectedModel,
  reasoningEffort: "high" as const,
  latencyMode: "standard" as const,
};
const retry = await client.retrySession(workspaceId, sessionId, retryRequest);
// { outcome: "accepted" | "replayed", turnId, failureEventId }
```

Requires `sessions:control` and session access. Recovery keeps the logical turn,
original question, frozen authority, and completed history/tool results; it
does not create a user message. Omitted policy fields retain the failed turn's
selection. The selected policy is revalidated for new admission. A duplicate
operation replays its receipt even after execution advances.

HTTP 409 codes distinguish `RETRY_STALE_FAILURE`, `RETRY_EXECUTION_UNRESOLVED`,
`RETRY_PAUSED`, `RETRY_UNSUPPORTED_FAILURE`, and `IDEMPOTENCY_KEY_REUSED`.
Unresolved tool outcomes cannot be blindly replayed. A deliberate Pause must
be resumed separately. Failure without a retained logical turn, a settled
scheduled occurrence, and idle credit exhaustion are not supported retry
boundaries. See [run lifecycle](../../docs/run-lifecycle.md).

## Session tool policy and native web search

For standalone credential maintenance, use the dedicated operation rather than
sending a message:

```ts
const request = {
  operationKey: crypto.randomUUID(),
  updates: [{
    id: "crm",
    expectedCredentialVersion: 1,
    expectedServerUrl: "https://tools.example.test/mcp",
    headers: { Authorization: `Bearer ${replacementToken}` },
  }],
};
const receipt = await client.rotateSessionMcpCredentials(workspaceId, sessionId, request);
```

Only exact existing inline servers without `connectionRef` are eligible. Both
session control and MCP attach permissions, live session authorization, expected
versions, and a quiescent credential-consumer boundary are required. This never
sends a message, starts work, retries a failed turn, or refreshes an active
client. Reconcile an ambiguous response with the same request/key; the SDK does
not retry mutations automatically. Exact authorized replay returns the original
receipt without a second write. Old receipt verification fails explicitly with
503 if the deployment encryption key has been replaced. See the full
[rotation contract](../../docs/session-mcp-servers.md#standalone-inline-credential-rotation).

Omitting `tools` when creating a top-level session selects the current
workspace-default capability policy, including the built-in `files` server.
Passing `tools`, including `[]`, is an intentional fixed narrowing and can
therefore disable file-download access for that session. Opengeni's own web UI
keeps `files` enabled as a hidden default, while API and embedded clients retain
exact control over the explicit list. Supported Responses providers attach
their native bounded web-search tool independently of this MCP policy.

Existing explicit sessions are not widened when a new default capability is
introduced. Opt one in explicitly with the current optimistic-concurrency
version; the audited change takes effect on its next attempt:

```ts
const session = await client.getSession(workspaceId, sessionId);
const updated = await client.updateSessionToolPolicy(workspaceId, sessionId, {
  mode: "workspace_default",
  expectedVersion: session.toolPolicyVersion,
});
```

To keep a fixed allow-list, replace both connected MCP servers and individual
Opengeni tools atomically:

```ts
await client.updateSessionToolPolicy(workspaceId, sessionId, {
  mode: "explicit",
  tools,
  firstPartyMcpTools,
  expectedVersion: session.toolPolicyVersion,
});
```

Follow-up Send and Steer requests inherit this session policy and cannot carry
a private one-turn tool override. `tool_search` discovers deferred MCP schemas;
it is not public web search.

## Goals

```ts
const goal = await client.getGoal(workspaceId, sessionId); // counters: autoContinuations, noProgressStreak
const maybeGoal = await client.findGoal(workspaceId, sessionId); // null for a goal-less session (no 404)
await client.pauseGoal(workspaceId, sessionId, { rationale: "manual review" });
await client.resumeGoal(workspaceId, sessionId); // resets counters, re-arms continuations

const revisions = await client.listGoalRevisions(workspaceId, sessionId); // legacy raw array
const page = await client.listGoalRevisionPage(workspaceId, sessionId, { limit: 25 });
await client.rejectGoalRevision(workspaceId, sessionId, proposalId, {
  expectedObjectiveRevision: goal.objectiveRevision,
  rationale: "Keep the existing objective",
});
await client.rollbackGoalRevision(workspaceId, sessionId, appliedRevisionId, {
  expectedObjectiveRevision: goal.objectiveRevision,
  rationale: "Restore the last known-good objective",
});
```

## Files

`uploadFile` wraps the three-step flow (begin → signed PUT → complete) in one
call; the lower-level steps are exported for resumable/custom flows.

Browser hosts need no storage credentials or per-application registration.
Opengeni authorizes the workspace request and returns a short-lived,
object-scoped signed URL; operators must configure the private object store to
allow CORS from `*` so any product embedding the SDK can use that URL.

```ts
const file = await client.uploadFile(workspaceId, {
  filename: "incident-notes.md",
  contentType: "text/markdown",
  data: notes, // string | Blob | ArrayBuffer | Uint8Array
});
const { url } = await client.createFileDownloadUrl(workspaceId, file.id);
```

Generated-image tool results use the same workspace file authority but expose a
closed `generated_image` receipt. Prefer a short-lived zero-copy browser URL;
use the bounded range method when the caller needs verified bytes:

```ts
const { url } = await client.createRetainedArtifactDownloadUrl(workspaceId, receipt.artifact);
const { bytes } = await client.downloadRetainedArtifact(workspaceId, receipt.artifact);
```

Both methods validate the receipt first. The byte path additionally verifies
the assembled SHA-256. See `docs/image-generation.md` in the repository.

## Connected Machines (bring-your-own-compute)

A session can run on an enrolled **Connected Machine** — a user's own computer —
instead of a platform-managed sandbox. Two `createSession` fields target one:

- **`targetSandboxId`** (uuid) — the machine to run on (a `MachineView.sandboxId`
  from `listMachines`). It seeds the session's active-sandbox pointer at
  creation, so the first turn lands on that machine.
- **`workingDir`** (host path) — the directory the agent runs under on that
  machine. **Only valid together with `targetSandboxId`** — `workingDir` alone is
  a **422**. Omit it and the session runs under the machine's default workspace
  root. Repos attached to a machine session are **not cloned** (the machine uses
  its own git auth).

```ts
const { machines } = await client.listMachines(workspaceId);
const box = machines.find((m) => m.kind === "selfhosted" && m.state === "online");

const session = await client.createSession(workspaceId, {
  initialMessage: "Run the test suite and fix what's red",
  targetSandboxId: box!.sandboxId, // seeds the active-sandbox pointer at create
  workingDir: "/home/me/projects/app", // requires targetSandboxId, else 422
});

// Re-point a running session's active sandbox (or "session"/"default" to swap
// back to its own managed box):
await client.swapActiveSandbox(workspaceId, session.id, { target: box!.sandboxId });
```

Discovery (`listMachines`, `machineMetricsSeries`), the active-sandbox swap, and
the enrollment methods (`mintEnrollToken`, `lookupDeviceEnrollment`,
`approveDeviceEnrollment`, `denyDeviceEnrollment`) are covered in the
[Connected Machines guide](../../docs/connected-machines.md).

For large agent hierarchies, use `listAgentTopology` instead of collecting full
session pages. It returns compact root, direct-child, or server-side search
pages with opaque cursors and server-authored descendant counts. Load a child
page only when its parent is expanded; `children.truncated` makes a lower-bound
aggregate explicit.

## Full API coverage

Every public endpoint group has typed methods:

| Group | Methods |
| --- | --- |
| Access + workspaces | `getAccessContext`, `listWorkspaces`, `createWorkspace`, `ensureWorkspace`, `getWorkspace`, `updateWorkspace` |
| Managed organizations | `createOrganization` for first-time compatibility; `createAdditionalOrganization` for an already-onboarded human; `listOrganizationMemberships`, `listOrganizationInvitations`, `acceptOrganizationInvitation` |
| Sessions + events | `createSession`, `listSessions`, `listSessionPage`, `listAgentTopology`, `getSession`, `getSessionLineage`, `updateSession`, `listEvents`, `sendEvent`, `sendMessage`, `steerMessage`, `pauseSession`, `resumeSession`, `cancelSession`, `sendApprovalDecision`, `streamEvents`, `openEventStream` |
| Machines (bring-your-own-compute) | `listMachines`, `machineMetricsSeries`, `swapActiveSandbox`, `mintEnrollToken`, `lookupDeviceEnrollment`, `approveDeviceEnrollment`, `denyDeviceEnrollment` |
| Turn queue | `getQueue`, `moveQueueItem`, `editQueueItem`, `steerQueueItem`, `deleteQueueItem` |
| Goal | `getGoal`, `findGoal`, `updateGoal`, `pauseGoal`, `resumeGoal`, `listGoalRevisions`, `listGoalRevisionPage`, `applyGoalRevision`, `rejectGoalRevision`, `rollbackGoalRevision` |
| Scheduled tasks | `createScheduledTask`, `listScheduledTasks`, `getScheduledTask`, `updateScheduledTask`, `pauseScheduledTask`, `resumeScheduledTask`, `triggerScheduledTask`, `deleteScheduledTask`, `listScheduledTaskRuns`, `refreshScheduledTaskAccess`, `listScheduledTaskAccessAttention` |
| Variable sets | `listVariableSets`, `createVariableSet`, `getVariableSet`, `updateVariableSet`, `deleteVariableSet`, `setVariableSetVariable`, `deleteVariableSetVariable`; generic reads are metadata-only, while dedicated permissioned exact-value reads are part of the held client train |
| Files | `uploadFile`, `beginFileUpload`, `completeFileUpload`, `getFile`, `createFileDownloadUrl` |
| Documents | `createDocumentBase`, `listDocumentBases`, `getDocumentBase`, `addDocument`, `listDocuments`, `reindexDocument`, `searchDocuments`, `searchKnowledge` (effective organization + workspace + immutable initiating-user personal scope) |
| Capabilities | `listCapabilities`, `createCapability`, `enableCapability`, `disableCapability`, `discoverMcpCapabilities` |
| Plugin packages | `previewPlugin`, `installPlugin`, `previewPluginUninstall`, `uninstallPlugin` |
| API Integrations | `listIntegrationDefinitions`, `listApiIntegrations`, `previewApiIntegration`, `startApiIntegrationOAuth`, `installApiIntegration`, `previewApiIntegrationUninstall`, `uninstallApiIntegration`, `listIntegrationFacets`, `configureIntegrationFacet`, `pauseIntegrationFacet`, `resumeIntegrationFacet`, `removeIntegrationFacet`, `browseGoogleDriveFacetSource`, `saveGoogleDriveFacetSource` |
| Remote Skills | `previewSkillImport`, `installSkill`, `previewSkillUninstall`, `uninstallSkill` |
| GitHub | `getGitHubApp`, `githubConnectUrl`, `listGitHubRepositories`, `syncGitHubRepositories`, `createGitHubAppManifest` |
| API keys | Workspace: `listApiKeys`, `createApiKey`, `deleteApiKey`; organization: `listOrganizationApiKeys`, `createOrganizationApiKey`, `deleteOrganizationApiKey` |
| Billing | `getBilling`, `getBillingUsage`, `getBillingEntitlements`, `createBillingCheckout`, `createBillingPortalSession` |

`listIntegrationDefinitions` returns safe Integration Definition metadata without any
deployment OAuth client credentials. API Integrations are multi-instance:
`installApiIntegration` may supply a
stable `instanceKey`, display name, and exact Connection. The returned
`serverId` is instance-specific, so two Gmail or Linear accounts can be
selected in one session without tool-name collision. Uninstall preview and
uninstall both require the exact `instanceKey` and instance version; neither
operation disconnects the underlying Connection.

Adapter-owned Integration facets are listed and mutated under the exact
`capabilityId` + `instanceKey` + `facetKey`. Generic primitive schemas use
`configureIntegrationFacet`; lifecycle changes and removal require the
binding's exact optimistic version plus a caller UUID idempotency key. Google
Drive's nested folder/Shared Drive source schema has dedicated
`browseGoogleDriveFacetSource` and `saveGoogleDriveFacetSource`
methods. They verify provider metadata through that instance's exact Connection
and persist only a versioned facet binding—never provider credentials, page
tokens, or selected-source configuration on the Connection.

### Protocol routes (deliberately not in the SDK)

Some endpoints are wire protocols for specific counterparts, not client
surface, and are intentionally absent from the SDK: machine-agent enrollment
device flow and NATS auth-callout, viewer/stream internals beyond minting,
OAuth/GitHub browser callbacks, Stripe webhooks, the MCP transports themselves
(`/v1/workspaces/:id/mcp`, `/mcp/docs` — speak MCP to those), and the install
script routes. If you find yourself calling one of these raw from a product,
reconsider — they can change with their counterpart, not with the SDK.

## Compatibility

Clients and servers are compatible within the same **major** version of this
SDK; evolution is additive within a major and both sides are tolerant readers.
Official server builds expose `serverVersion` on `/healthz` and
`/v1/config/client`. A route scheduled for removal answers with `Deprecation`
and `Sunset` headers at least 90 days (and a major) ahead; the client reports
each deprecated route once through the `onDeprecation` option (default: one
`console.warn` per route; `false` silences it). Full policy:
`docs/design/api-compatibility-policy.md`.

## Proxy through your own API

For the React conversation, use the packaged
[`createSessionProxyHandler`](#embed-the-conversation-default). For a custom
backend route, keep your organization API key on your server and re-emit the
stream to your own browser clients. The re-emitted wire format is identical to Opengeni's SSE
stream, so the browser side can consume it with this same SDK (or a plain
`EventSource`), including resume via `?after=` / `Last-Event-ID`:

```ts
// Your server (Hono, Next.js route handler, Bun.serve, workers, ...):
import { OpenGeniClient, proxySessionEventStream } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

export function GET(request: Request): Response {
  // authenticate *your* user, resolve their session id, then:
  return proxySessionEventStream(client, workspaceId, sessionId, {
    after: request, // honors ?after= and Last-Event-ID from the browser
    signal: request.signal, // browser disconnect tears down the upstream stream
  });
}
```

For custom layers, the pieces are exported individually:
`sessionEventsToSseStream`, `sessionEventsToSseResponse`, `formatSseEvent`,
`resumeSequenceFromRequest`, and `parseSseStream`.

## Types

The SDK ships hand-written mirrors of the public wire shapes (sessions, turns,
events, resource/tool refs) so it carries no runtime dependency on the server
packages. `test/contract-parity.test.ts` pins them to `@opengeni/contracts`,
so contract drift fails the repo gate instead of shipping. `SessionEvent.type`
is an open union: unknown event types from newer servers flow through instead
of breaking older SDK consumers.

Hosts, test doubles, and same-origin proxies must import
`OPENGENI_API_CONTRACT_REVISION` from `@opengeni/sdk` when constructing a client
configuration or contract header. Do not copy its string value: the revision is
an executable compatibility boundary, and `getClientConfig()` intentionally
fails closed when server and SDK revisions differ.

### Action review facts

`getToolActionReview(workspaceId, sessionId, approvalId)` returns version 1 facts
for an exact prepared connector action: title, selected account/count, material
effects, optional provider-sourced examples, bounded fields, reason, status and
available actions. Use `sendApprovalDecision` for the existing authenticated
human decision. Facts never grant execution authority.

`getToolReviewDetails(workspaceId, sessionId, approvalId, { actionDigest, path,
offset })` pages through the saved selection/values (25 rows per page). The
reference is tied to the original action digest and requires the same session
visibility permission; it never re-runs a search. Secret/write-only fields stay
hidden. A missing legacy snapshot may return 404; other authorization or transport
failures must not be interpreted as permission to execute. Responses are private
and non-cacheable. Review states distinguish waiting, execution, cancellation,
failure and uncertain outcome. Exact stored arguments are never client-editable.
