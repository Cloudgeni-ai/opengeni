<!-- docs-refs: record -->

> **Point-in-time design record.** Written against `main` at `9e21a09c` on
> September 1, 2026. Code wins where the implementation later differs.

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

The finished artifact is one self-contained HTML document. Source retention for
future agent editing is useful, but is a separate authoring concern from the
runtime format.

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

The desired Site authoring experience is one typed client with the runtime's
OpenGeni API, workspace context, and tools:

```ts
import { OpenGeniClient } from "@opengeni/sdk/browser";

const client = new OpenGeniClient({
  baseUrl: runtime.apiBaseUrl,
  accessToken: () => runtime.accessToken,
});

const session = await client.createSession(runtime.workspaceId, request);
const issues = await client.tools.linear.issues_list({ state: "Todo" });
```

This example records the desired API shape, not a claim that current `main`
already exports these exact constructor names or `client.tools`.

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

### Runtime communication should be ordinary authenticated HTTP

The Site should talk to the OpenGeni backend over ordinary HTTP/SSE using an
authenticated token. A parent-page `fetch` RPC bridge is not the default
architecture. The iframe cannot use the parent page's cookies directly, so the
host must provide browser-usable runtime authentication and workspace context.

The exact token/session mechanism remains open pending a full authority review.
Whatever is selected must:

- represent the actual current human and exact workspace;
- work with the existing typed SDK;
- renew without interrupting a long-open Site;
- observe logout, membership, permission, and connection changes;
- preserve personal as well as workspace-owned connection behavior;
- authorize every API and tool call on the server;
- avoid shipping a standing shared API key; and
- produce clear reauthentication or access-loss behavior instead of scattered
  tool failures.

The implementation should prefer existing access-grant and browser-auth
machinery. A new server-backed runtime-session model, a stateless delegated
token, or a parent-mediated request path are candidate mechanisms, not settled
product decisions.

## Things not to build

- A separate Site host or wildcard Site domain.
- A Site-specific AI API such as `site.ai.start` or `site.ai.send`.
- A second session/event model.
- A Site-specific tool registry or provider wrappers.
- A bespoke Site build service or required OpenGeni build command.
- A user-facing Site deployment CLI.
- A second React component system for agent sessions.
- A custom `fetch` transport unless the final authentication design proves it
  necessary.

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

## Current implementation assessment

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
  The current HTML limit is 4 MiB of UTF-8.
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

### Actual additions required

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
4. Add browser-usable runtime authentication that the server can positively
   link to the actual live managed-human login. A plain delegated bearer that
   merely claims the human's subject id is insufficient: current access code
   deliberately refuses delegated bearers the canonical managed-human stamp and
   personal-connection authority. The host-owned MCP authority path is also a
   different concern: it lets an embedding host supply connector authority; it
   does not authenticate the human running code inside the iframe.
5. Define direct-human approval and durable operation semantics for UI tool
   calls. Retries of mutating calls need the same no-duplicate and
   outcome-unknown guarantees as Codemode without pretending that the call
   belongs to an agent attempt.

No new Linear, Slack, GitHub, provider credential, MCP transport, artifact host,
or React session implementation is required.

## Likely SDK and request flow

The exact package names are open, but the behavioral flow should remain simple.

### During Site authoring

1. The authoring environment obtains the tool catalog selected for the Site.
2. The generic declaration generator writes a project-local declaration that
   augments an SDK interface such as `OpenGeniGeneratedTools`.
3. TypeScript then understands exact calls such as
   `client.tools.linear.issues_list(...)`; the runtime namespace remains a lazy
   proxy so the published SDK does not need to statically know every installed
   integration.
4. The agent uses normal Bun development and build commands and publishes the
   resulting self-contained HTML.

Generated types improve authoring but do not grant access. The server remains
authoritative if a viewer lacks a required permission or connection, or if the
catalog changed after the Site was built.

### When the Site opens

1. The OpenGeni host gives the iframe its API base URL, workspace id, and a
   short-lived runtime token. This can be a one-time bootstrap handoff; it does
   not require forwarding every `fetch` call through the parent page.
2. `OpenGeniClient` reads the current token through a callback so renewal does
   not require rebuilding the client.
3. A call through `client.tools` sends a normal authenticated HTTP request with
   an operation id, canonical tool identity, arguments, and any catalog version
   needed to detect stale code.
4. The API resolves the token to server-owned current-human evidence, checks
   the exact live workspace authority, and resolves that viewer's current
   connection authority. It must not trust a client-supplied subject claim.
5. The generic tool host obtains the allowed descriptor from the same runtime
   preparation path used for agents, validates the input, applies approval and
   operation policy, and invokes the existing `PrefixedMcpServer` executor.
6. The executor performs the provider call and returns the existing structured
   result, attachment, auth-needed, or outcome-unknown projection. The generic
   host validates the successful structured output and the SDK returns the
   typed value.

The managed session-set implementation already contains useful live actor,
refresh, epoch, and revocation machinery. It may be the right authority behind
the runtime token, but the iframe-facing bearer and its positive server-owned
provenance are not present today. That is the main security design task; it
should not be hidden inside a custom SDK transport.

## Open technical questions

1. Which exact generic tool types and functions should move below Codemode, and
   which should remain attempt-specific?
2. Can the existing SDK client gain `client.tools` without introducing a second
   client, transport, or package-level authority model?
3. Should browser tool invocation use an existing MCP HTTP route, a generic
   typed call route, or an SDK adapter over one of those existing protocols?
4. How is the runtime tool catalog selected and typed when different viewers
   have different connections or grants?
5. Which current connection-authority paths can safely recognize the embedded
   application as the actual current human rather than an impersonating bearer?
6. What token renewal and revocation behavior already exists and can be reused?
7. How should approval-required direct UI tool calls enter the existing human
   approval lifecycle?
8. Which operation-id and outcome-unknown contracts should be shared with
   Codemode so browser-side retries cannot duplicate side effects?
9. How should the source project be retained for future `Edit with Geni`
   iterations without changing the single-HTML runtime contract?

These questions should be answered from current code before an implementation
plan or package split is finalized.
