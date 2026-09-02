<!-- docs-refs: record -->

> **Point-in-time design record.** Written against `main` at `9e21a09c` on
> September 1, 2026 and resolved on September 2, 2026. Code wins where the
> implementation later differs.

# Workspace HTML Sites

## Purpose

OpenGeni should let an agent build a normal interactive web application, publish
it as a Workspace HTML artifact, and let that application use OpenGeni's typed
frontend SDK, React components, and tool system.

This is not a second application platform. The intended product is a normal
web application embedded in the existing OpenGeni application.

## Settled product model

### The Site is a normal Bun web application

The authoring agent writes an ordinary Bun, TypeScript, and React project. Bun
owns development serving and the final browser bundle. OpenGeni does not need a
special Site build service, bespoke build command, user-facing Site CLI, or
separate deployment format.

The Site-building Skill should teach the agent to:

1. create an ordinary Bun + React application;
2. run it from the sandbox with Bun's normal development workflow;
3. open the sandbox-local URL with OpenGeni's existing Codemode browser tools;
4. inspect, interact with, screenshot, and improve the application;
5. use Bun's normal HTML build to produce one self-contained HTML file; and
6. publish that file with the existing Workspace Artifact tools.

The exact Bun command is authoring guidance in the Skill, not an OpenGeni
runtime abstraction.

### Existing Workspace HTML artifacts remain the publish format

OpenGeni already stores immutable, versioned HTML artifact content in object
storage and renders exact HTML in an opaque-origin sandboxed iframe. Sites
should build on that existing artifact and renderer instead of introducing a
second host, wildcard domain, container deployment, or Site-specific storage
model.

Artifact HTML is publisher-controlled active content. The opaque origin blocks
parent DOM, cookie, and storage access, but the current renderer deliberately
allows scripts, external resources, forms, popups, and outbound network
requests. Opening an artifact therefore must not disclose an OpenGeni credential
or silently grant API or tool authority. Authenticated Site capabilities require
an additional explicit trust and capability boundary described below.

The finished runtime is one self-contained HTML document. Each immutable
version retains its complete traversal-free source bundle and exact requested
tool identities beside that HTML, so `Edit with Geni` can restore the ordinary
Bun project without changing the runtime format.

### The agent should use the typed OpenGeni SDK

The Site-building Skill should prefer OpenGeni's typed SDK over handwritten
REST calls. Typed methods, request contracts, event streaming, reconnect,
replay, and error handling are easier for an agent to use correctly than raw
URLs and ad hoc response types.

The `browser` in `@opengeni/sdk/browser` means **browser-compatible package
entrypoint**. It does not mean OpenGeni Browser/Computer automation and does not
imply that the Site is controlling a browser. Its purpose is to keep Node-only,
operator-only, or otherwise inappropriate package surfaces out of the browser
bundle.

The Site runtime exposes one workspace-bound typed tool client without giving
publisher-controlled code an API URL, workspace id, cookie, or bearer:

```ts
import { createOpenGeniSiteClient } from "@opengeni/sdk/site";

const client = createOpenGeniSiteClient();

const issues = await client.tools.linear.issues_list({ state: "Todo" });
```

The host transfers exactly one `MessagePort` after verifying that the connect
message came from the rendered iframe's exact `contentWindow`. The same lazy
`client.tools` proxy is available to ordinary SDK/browser consumers through a
workspace-bound HTTP adapter.

### The agent should use OpenGeni's styled React UI by default

When a Site contains an OpenGeni agent experience, the Skill should default to
the packaged OpenGeni React components rather than asking the agent to rebuild a
chat UI from raw hooks.

The default composition should use the existing provider, timeline, composer,
queue, session status/chrome, approval, and human-input surfaces, together with
the packaged compiled CSS. Raw hooks and custom React remain available when the
Site needs a genuinely different interaction, but they are the customization
path rather than the default.

Conceptually:

```tsx
import "@opengeni/react/compiled.css";
import {
  ChatComposer,
  MessageTimeline,
  OpenGeniProvider,
  QueueSurface,
  SessionStatus,
  useComposer,
  useSessionEvents,
  useTurnQueue,
} from "@opengeni/react";

function AgentSurface({ sessionId }: { sessionId: string }) {
  const events = useSessionEvents(sessionId);
  const queue = useTurnQueue(sessionId);
  const composer = useComposer(sessionId, {
    effectiveControl: queue.effectiveControl,
  });

  return (
    <div className="flex h-full flex-col">
      {events.sessionStatus ? <SessionStatus status={events.sessionStatus} /> : null}
      <MessageTimeline
        items={events.timeline}
        status={events.sessionStatus}
        hasOlder={events.hasOlder}
        loadingOlder={events.loadingOlder}
        onLoadOlder={events.loadOlder}
        className="min-h-0 flex-1"
      />
      <QueueSurface queue={queue} composer={composer} />
      <ChatComposer composer={composer} effectiveControl={queue.effectiveControl} />
    </div>
  );
}

<OpenGeniProvider client={client} workspaceId={runtime.workspaceId}>
  <AgentSurface sessionId={sessionId} />
</OpenGeniProvider>;
```

The Skill should teach the agent to compose these existing surfaces into a
polished application, then customize with design tokens, component slots, and
headless hooks only where the product needs it.

### React application code must be able to call tools directly

It is not sufficient for only an agent session started by the Site to use
tools. The React application itself must be able to make typed calls such as:

```ts
const issues = await client.tools.linear.issues_list({ state: "Todo" });
```

Tool calls should use the same canonical tool definitions, input/output
schemas, identities, authorization, connection resolution, approval policy,
and execution implementations as model and Codemode calls. A Site-specific
tool registry or per-provider API is not acceptable.

### Codemode is one adapter over a more general tool core

Current code places several generic concepts under Codemode-oriented names.
The underlying concepts are not inherently Codemode-specific:

- opaque `{serverId, toolName}` identity;
- tool metadata and input/output JSON Schemas;
- collision-safe programmatic paths;
- schema-to-TypeScript declaration generation;
- input/output validation;
- authorization and approval classification; and
- invocation of one canonical executor.

The intended architecture is:

```text
generic tool definition/catalog/execution core
├── model tool adapter
├── Codemode attempt adapter
└── authenticated SDK/browser adapter
```

Codemode should retain only what is genuinely attempt-specific: the exact
attempt scope and bearer, frozen attempt catalog, durable Codemode operation
journal, active-attempt fencing, sandbox delivery, and attempt event
projection.

The detailed package boundary is intentionally not settled in this record. It
must be derived from the current runtime and contracts rather than created by
renaming files prematurely.

### Authenticated runtime communication stays in the parent

The final design uses the parent-mediated boundary. Opening a Site transfers no
credential and no non-secret routing context into the iframe. The parent owns
the authenticated SDK client, projects only the exact tool identities retained
by the immutable current Site version, and rejects every call outside that set.

The iframe creates one `MessageChannel`, sends the transfer request to its
parent, and then communicates only over the transferred port. The host accepts
the channel only when `event.source` is the exact iframe window and exactly one
port is present. Reload, stop, navigation, cancellation, and unmount close the
port and abort outstanding requests.

The parent resolves every call through the current human's live workspace tool
gateway. That gateway rebuilds the enabled first-party and integration catalog,
resolves personal/workspace connection authority through the existing broker,
validates the catalog digest and input, and invokes the same executor as model
and Codemode calls. An approval-required entry opens the stock parent-owned
confirmation dialog; only the resulting authenticated current-human HTTP call
carries the server-issued one-shot approval capability. Site code cannot approve
itself.

This avoids version-scoped bearer issuance entirely. Membership, permission,
connection, logout, and catalog changes are observed by the parent's ordinary
live authority path, while the immutable version's requested-tool set remains a
second, narrower allowlist. A newly published version may change that retained
allowlist, but never inherits a credential because no artifact-readable
credential exists.

## Things not to build

- A separate Site host or wildcard Site domain.
- A Site-specific AI API such as `site.ai.start` or `site.ai.send`.
- A second session/event model.
- A Site-specific tool registry or provider wrappers.
- A bespoke Site build service or required OpenGeni build command.
- A user-facing Site deployment CLI.
- A second React component system for agent sessions.
- A general-purpose authenticated `fetch` bridge. The parent exposes only the
  bounded typed tool catalog/call protocol required by `@opengeni/sdk/site`.

## Existing surfaces to reuse

The current architecture investigation should begin with these shipped seams:

- Workspace HTML artifact storage and versioning:
  `apps/api/src/routes/workspace-artifacts.ts` and the matching SDK artifact
  client methods.
- Opaque-origin HTML rendering:
  `packages/react/src/components/artifacts/published-html-artifact-frame.tsx`.
- Browser-compatible typed client:
  `packages/sdk/src/browser.ts` and `packages/sdk/src/client.ts`.
- React provider, session hooks, and styled components:
  `packages/react/src/provider.tsx`, `packages/react/src/session.ts`,
  `packages/react/src/session-ui.ts`, and the root package exports.
- Generic tool contracts currently expressed as attempt catalogs:
  `packages/contracts/src/tool-catalog.ts`.
- Catalog construction, validation, client namespace generation, and
  declarations currently housed in `packages/codemode`.
- MCP discovery, connection resolution, and executor construction:
  `packages/runtime/src/index.ts` and worker tool preparation.
- Existing authenticated first-party MCP route:
  `apps/api/src/mcp/`.
- Access-grant and delegated-token resolution:
  `packages/core/src/access/` and the managed browser-auth seam.

## Implementation assessment at design time

Most of the required product already exists on `main`. This should be an
extraction and an additional public adapter, not a replacement tool platform.

### Already present

- `OpenGeniClient` is already a framework-independent WHATWG `fetch` client
  used from the browser application. It supports static or per-request headers,
  typed session methods, SSE, reconnect, replay, and the rest of the public API.
  The browser subpath currently exports it under the name
  `OpenGeniBrowserClient`; it does not yet expose `accessToken` or
  `client.tools` with the desired names.
- `@opengeni/react` already provides the provider, styled session surfaces,
  approvals, human input, queue, timeline, composer, status, and compiled CSS
  that a Site should compose by default.
- Workspace HTML artifacts already provide immutable content-addressed blobs,
  versioning, rollback, and exact `srcDoc` rendering in an opaque-origin iframe.
  The current HTML limit is 4 MiB of UTF-8. Scripts and network requests work,
  so opaque-origin isolation is not credential containment; the current artifact
  runtime contract correctly gives artifact code no OpenGeni credentials.
- Runtime MCP preparation already discovers configured capability and API
  integration servers, resolves credentials, freezes tool definitions, applies
  allowlists, and creates `PrefixedMcpServer` instances.
- `PrefixedMcpServer.executeCatalogTool` already invokes the real MCP tool,
  projects tool results and connector attachments, reports auth-needed and
  outcome-uncertain states, and supplies the operation id to connector paths.
- The code under `@opengeni/codemode` already contains most of the reusable
  catalog machinery: collision-safe namespace allocation, catalog digests,
  JSON Schema validation, a lazy JavaScript namespace, and JSON-Schema-to-
  TypeScript declaration generation.
- Codemode already has a durable operation journal with explicit completed,
  failed, cancelled, and outcome-unknown states. It proves the required
  side-effect safety model, although its current records and fencing are tied to
  one agent attempt.
- The API already permits cross-origin bearer requests with `Authorization`
  through public CORS. It also has a standard authenticated MCP-over-HTTP route,
  but that route currently registers OpenGeni's first-party tools rather than
  the complete set of configured external integrations.

### Implemented additions

1. Extract or introduce generic tool definition, catalog, namespace, type
   generation, validation, and execution contracts below the current
   attempt/Codemode names. Attempt scope and lifecycle fencing stay in the
   Codemode adapter.
2. Add an augmentable generated-tools interface and lazy `client.tools`
   namespace to the browser-safe SDK. The namespace should resolve a friendly
   path to an opaque canonical `{serverId, toolName}` identity; the path is never
   authority.
3. Add one authenticated backend surface that lists and calls the same prepared
   tools OpenGeni already gives an agent. It must assemble configured external
   integrations as well as first-party tools and call the existing executor,
   not duplicate provider implementations.
4. Add an explicit artifact trust and capability grant plus browser-usable
   runtime authentication or parent mediation. The server must positively link
   grant creation and refresh to the live managed-human login, bind the grant to
   the exact artifact version and approved API/tool allowlist, and revoke it on
   trust, login, membership, permission, or connection changes. A plain
   delegated bearer that merely claims the human's subject id is insufficient:
   current access code deliberately refuses delegated bearers the canonical
   managed-human stamp and personal-connection authority. The host-owned MCP
   authority path is also a different concern: it lets an embedding host supply
   connector authority; it does not establish viewer consent for publisher-
   controlled code or safely expose the human's authority inside the iframe.
5. Define direct-human approval and durable operation semantics for UI tool
   calls. Retries of mutating calls need the same no-duplicate and
   outcome-unknown guarantees as Codemode without pretending that the call
   belongs to an agent attempt.

No new Linear, Slack, GitHub, provider credential, MCP transport, artifact host,
or React session implementation is required.

## Final SDK and request flow

### During Site authoring

1. The normal Site-authoring session inherits the workspace's enabled tools and
   obtains its exact attempt catalog through Codemode.
2. `ogtool declarations` writes a project-local declaration that augments
   `OpenGeniGeneratedTools`.
3. TypeScript then understands exact calls such as
   `client.tools.linear.issues_list(...)`; the runtime namespace remains a lazy
   proxy so the published SDK does not need to statically know every installed
   integration.
4. The agent uses normal Bun development and browser validation, then publishes
   the resulting self-contained HTML, retained source bundle, and exact
   requested canonical identities together.

Generated types improve authoring but do not grant access. The server remains
authoritative if a viewer lacks a required permission or connection, or if the
catalog changed after the Site was built.

### When the Site opens

1. The iframe opens one `MessageChannel` to its exact parent and receives no
   token, API URL, workspace id, cookie, or DOM authority.
2. The parent loads the live workspace catalog and projects only identities
   retained by the current immutable Site version. Requested but disabled tools
   remain unavailable.
3. A call through `client.tools` sends an operation id, the projected catalog
   digest, canonical identity, and arguments over the transferred port.
4. The parent rejects identities outside the immutable requested set and sends
   the call through the authenticated workspace HTTP adapter.
5. Approval-required entries stop at a stock parent-owned confirmation dialog.
   The parent obtains a server-issued one-shot capability bound to the exact
   operation; MCP and Site code cannot silently provide it.
6. The API rebuilds the current-human gateway from live enabled first-party and
   integration servers, validates digest/input/authorization, resolves current
   connections, and calls the same executor closures as model and Codemode.
7. Reload, stop, navigation, cancellation, logout, or unmount closes the port
   and aborts pending work. Catalog or authority drift fails closed and is
   surfaced to the Site as a typed bridge/tool error.

## Resolved technical decisions

- Generic catalog, digest, schema validation, declarations, canonical identity,
  and execution live in `@opengeni/tool-gateway`.
- Runtime preparation is the shared provider assembly seam. Model tools,
  Codemode, current-human MCP, and HTTP/SDK adapters do not rediscover provider
  implementations independently.
- `@opengeni/sdk` owns the augmentable lazy `client.tools` namespace;
  `@opengeni/sdk/site` supplies the iframe transport over one `MessagePort`.
- Browser hosts use `/v1/workspaces/:id/tools/catalog`, `/calls`, and
  `/declarations`. External MCP clients use the aggregate
  `/v1/workspaces/:id/mcp` route and standard MCP OAuth.
- Site authority is parent-mediated and limited twice: the immutable version's
  retained requested identities and the viewer's live workspace gateway.
- Existing `requireApproval` metadata remains the only human-approval policy.
  The parent confirmation dialog and server check are adapters over that policy,
  not a new consent framework.
- Codemode keeps its exact-attempt durable operation journal and recovery
  semantics. Direct current-human calls carry caller-generated operation ids;
  provider-specific idempotency/outcome handling remains in the canonical
  executor rather than a second Site journal.
- Each immutable version retains the complete bounded source bundle beside its
  single-HTML runtime. Archive/restore changes publication status without
  deleting versions or source.
