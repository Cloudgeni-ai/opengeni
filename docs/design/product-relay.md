# Product relay

Status: implemented in `createSessionProxyHandler` (`packages/sdk/src/session-proxy.ts`).
Decision date: October 23, 2026.

## Problem

A product with its own sign-in embeds Opengeni for its users: the chat panel
on its pages, the full session app (`SessionApp`) in a page, desktop window or
Office add-in, and its own mobile and extension clients. The browser must not
hold an Opengeni credential, so a server route of the product
(`createSessionProxyHandler`) authenticates the user and calls Opengeni as that
user.

That route used to be an allowlist: about 30 conversation routes, each with its
own body rules, plus opt-in flags (`files`, `sandboxFiles`, `artifacts`,
`sites`, `voiceInput`, `realtimeVoice`, `archive`, `sessionList`, `office`)
and a `sessionApp` mode with its own list of permitted writes. Every client
surface that grew a feature hit a 404 in the proxy, every product rebuilt the
missing features on its own server, and the proxy duplicated authorization
Opengeni already enforces (which artifacts a session produced, which goal
fields a member may change). Two authorities meant two places to get wrong.

## Decision

The proxy is a relay. Opengeni's per-user permissions are the only authority
for what a user can do; the relay authenticates the user, pins the workspace,
and enforces only what the product owns on its server. What a user sees is the
UI's decision.

| Layer | Owner | Mechanism |
| --- | --- | --- |
| Identity | Product | `resolve(request)` returns the user (and tenant or workspace); every call runs through `asUser(user, { source })`, never the key's own authority. |
| Scope | Relay | One workspace per request. Inside `/v1/workspaces/{ws}` every route and method is forwarded; a path naming another workspace is a 403. Outside it only the bootstrap reads answer, scoped to `{ws}`: `GET /v1/workspaces`, `GET /v1/access/me` (the user's effective grant there), `GET /v1/config/client`. |
| Authority | Opengeni | An `asUser` request holds only the permissions both the organization key and the user's membership hold. Products narrow it with the key's permissions and workspace scope, and per member with `addExternalWorkspaceMember` / `updateExternalWorkspaceMember`. |
| Server-owned choices | Product | `createSession` (the chat's agent, tools, MCP servers, Skills, instructions and model policy; the relay then refuses the routes that would change them later), `beforeForwardMessage` (model context and MCP credentials per message), `toolServer`, `modelSelection`, `visitorUploads`, `chats` defaults. |
| Explicit closures | Product | `refuse(route, context)` keeps routes closed that Opengeni would allow; `authorizeSession` adds a product check for every chat a request names, by path or `x-opengeni-session-id`. |
| Presentation | Product UI | Component props (`newChat`, `listProps`, `attachments`, `voiceInput`, `realtimeVoice`, `modelPicker`, `renderInteractiveBlock`) and `SessionApp` presets and `features` choose surfaces and branding. Stock components also hide controls the user's grant does not allow. |

The same requests the Opengeni web app makes therefore work through the relay,
so any client built on `@opengeni/sdk` and `@opengeni/react` (web, desktop,
Office, mobile) works behind a product's sign-in without relay changes. New
Opengeni features reach embedded users when the permission model admits them,
not when the relay learns a route.

## Why not the alternatives

- **Keep the allowlist and add routes.** The list grows with every surface,
  re-implements checks the API already has, and still lags the clients.
- **A per-user browser credential.** The browser would talk to Opengeni
  directly and the product could no longer own chat setup or per-message
  context: the `createSession` and `beforeForwardMessage` hooks need a server
  in the path. It remains possible later for products that own nothing per
  chat.
- **Per-feature flags on the relay.** Flags mixed authority (can the user
  upload) with presentation (should the composer show an attach control) and
  had to be mirrored in client config. Authority now lives in permissions,
  presentation in props, and the few product-owned closures in `refuse`.

## Transport

- Paths: every decoded segment is forwarded re-encoded, so ids, keys and
  subject ids (`user:…`) work as in the SDK client. Empty, `.`, `..`,
  separator (`/`, `\`) and control-character segments are refused, and a chat
  id must be an opaque token before `authorizeSession` sees it.
- Methods: GET, HEAD, POST, PUT, PATCH, DELETE. Request bodies stream through;
  routes the relay rewrites (chat create, messages, composer draft, realtime
  begin and sync) are read up to `maxBodyBytes` and re-serialized.
- Request headers forwarded: `Accept`, `Content-Type`, `Range`,
  `Last-Event-ID`, conditional headers, `x-opengeni-session-id`,
  `x-opengeni-correlation-id` and the chunked-upload headers. Nothing else
  from the browser reaches Opengeni; the relay adds the key, the user's
  identity and its own API contract revision.
- Responses keep Opengeni's status, error envelope and content headers
  (`Content-Type`, `-Length`, `-Disposition`, `-Range`, `Accept-Ranges`,
  `ETag`, `Last-Modified`, `Retry-After`, `Cross-Origin-Resource-Policy`,
  `x-opengeni-*`). `Cache-Control: no-store` and `nosniff` are always set, and
  `Content-Security-Policy: sandbox` when Opengeni sends none, so user content
  never runs as a page on the product's origin.
- SSE streams get `: ping` heartbeats between events only.
- Mutations: without the product's `authorizeMutation`, the relay refuses
  `Sec-Fetch-Site: cross-site` and the content types a cross-site form can send
  (`text/plain`, `application/x-www-form-urlencoded`).
- Always refused: archived history import (`session-imports`), whose events
  Opengeni stores as genuine transcript on the caller's word, and browser MCP
  credential rotation (`mcp-credentials/rotate`,
  and `mcpCredentialUpdates` in message bodies). MCP credentials are the
  server's.
- Not relayed: WebSocket upgrades. The editor's and the Office workbook's live
  sockets authenticate with tickets minted through the relay and connect to
  Opengeni directly, or the host passes the upgrade through.

## Client config

The relay serves Opengeni's client config for the workspace and user, plus the
resolved `workspaceId` (so a browser given only the relay's base URL needs no
Opengeni ids), the server SDK's `apiContractRevision` (an Opengeni deploy never
makes the embedded page look stale), the artifact viewer capability (editor
live socket and the user's cache partition), file uploads off for anonymous
visitors unless `visitorUploads`, and `modelSelection` when the product sets
it. Task usage limits stay server-side. The capability flags older relays
reported (`sessionCreation`, `archive`, `realtimeVoice`, `sandboxFiles`) are
gone; stock components treat them as available and still honor them from
older relays.

## Consequences

Newly reachable for a resolved user, within their permissions: every workspace
route, including sandbox file reads (`files:read`), artifact and Site writes
(`artifacts:publish`), schedules, Knowledge, chat cancel, workspace pause and
resume, archive with Pause (`sessions:control`), and the browser's native chat
create when there is no `createSession` hook. Products that relied on the
relay's flags or its producing-session artifact check get the same effect from
narrower member permissions or `refuse` (the exported
`getSessionProxyArtifactAssociation` performs that check).

The permission set automatic membership grants (workspace read, session
create, read and control, file upload and read, MCP attachment) therefore
becomes the default product surface, and its review matters more than before.

## Follow-ups

- Inbox and notifications for external users: the inbox routes have no
  subject for an external actor today, so products build their own.
- Agent setup stored as Opengeni data (workspace agent profiles) instead of
  recomputed by `createSession` on every create.
- Role presets for product members, so a product picks a role instead of
  listing permissions.
