# Product Integration Shapes

This reference helps a customer-side agent decide how a product should use a
standalone OpenGeni deployment. It is intentionally architecture-level. Verify
exact methods and props against the installed `@opengeni/sdk` and
`@opengeni/react` versions.

## The Common Architecture

```text
customer browser / mobile app
            |
            | customer session, same-origin product API
            v
customer backend / tenant boundary
            |
            | @opengeni/sdk, server-held OpenGeni credential
            v
standalone OpenGeni API -> sessions, workers, tools, storage, compute
```

The customer does not need to embed OpenGeni's database, workers, router, event
bus, or sandbox runtime. "Embedded agent" usually means the product presents an
OpenGeni-backed agent in its own experience while OpenGeni remains a service.

This integration skill belongs to the customer's development agent. Runtime
skills selected in `CreateSessionRequest.skills` belong to the OpenGeni session
it creates. Keep those layers separate: integration knowledge should not be
copied into every runtime agent prompt, and runtime skills should not redefine
the product's trust boundary.

## Decision Matrix

| Need | Recommended surface | Product renders | OpenGeni package |
| --- | --- | --- | --- |
| Send users to the complete stock experience | Link/deep-link | Product entry point only | None |
| Custom UI in any framework, mobile, CLI, or automation | Headless SDK | Everything user-facing | `@opengeni/sdk` |
| Custom React UI using canonical session behavior | Headless React session hooks | Product timeline/composer/layout | `@opengeni/react/session` |
| Packaged OpenGeni chat/session controls | Styled React surfaces | Product shell and domain UI | `@opengeni/react/session-ui`, `/composer`, `/realtime` |
| Agent workspace with files, changes, terminal, or desktop | Workbench | Product shell plus chosen tabs | `@opengeni/react` |
| OpenGeni runtime inside the host process | Advanced in-process embedding | Host owns infrastructure seams | Repo-level packages; see `docs/embedding.md` |

Start with the headless SDK. Add React surfaces rather than designing a larger
boundary up front. The packages are composable; using one hook does not require
mounting the stock OpenGeni application.

## Server And Browser Responsibilities

### Product server

- Authenticates its own user and enforces its own tenant/business permissions.
- Maps that principal to one allowed OpenGeni workspace and allowed sessions.
- Holds OpenGeni API keys or delegated credentials.
- Calls `OpenGeniClient` and returns product-shaped responses.
- Re-streams session SSE with `proxySessionEventStream` when the browser needs a
  live timeline.
- Rejects caller-supplied workspace/session IDs that are not already authorized
  by the product relationship.

### Product browser

- Talks to the product's same-origin routes or the deployment's normal browser
  auth boundary.
- May use the SDK with a custom `fetch`/same-origin base URL.
- May mount React hooks/components against a structural proxy client.
- Never receives a privileged OpenGeni API key just because it renders an agent.

The browser may PUT file bytes directly to a short-lived signed object-storage
URL returned by the SDK flow. That URL is scoped upload authority, not the
OpenGeni API credential. The SDK omits ambient cookies and auth on the storage
request. The deployment must configure storage CORS for intended browser
origins when browser uploads are enabled.

## UI Composition

### Headless session semantics

Use `@opengeni/react/session` when the product owns every visual decision but
wants canonical event, queue, composer, goal, approval, human-input, and timeline
behavior. The exported client contracts are structural and intentionally
narrow. Implement the exact client refinement required by each mounted hook;
do not stub billing, workspace administration, machines, or workbench methods.

### Packaged visuals

Use the styled subpaths for only the features the product wants:

- `@opengeni/react/session-ui` for timeline/session chrome surfaces.
- `@opengeni/react/composer` for the standard composer or its controller and
  compound primitives.
- `@opengeni/react/realtime` for realtime session controls.
- `@opengeni/react/machines` for Connected Machine management.
- the root package for the optional workspace/workbench graph.

Import `@opengeni/react/compiled.css` once for the default styled experience.
It is package-compiled, scoped under `.og-root`, and does not require the host to
run Tailwind or scan package source. Theme and density are `--og-*` runtime
tokens. Tailwind v4 hosts may deliberately compile the additive `styles.css`
source bridge instead, but must use one styling path, not both.

Responsive behavior should be container-based inside sidebars, drawers, and
split panes. Prefer package density/responsive props over host CSS selectors
that reach into SDK internals.

## Context And Instructions

The product should send four different kinds of information through their
matching contracts:

| Information | Contract | Lifetime | Visible in timeline |
| --- | --- | --- | --- |
| Stable workspace persona | workspace `agentInstructions` | every session in workspace | No |
| Agent role/persona refinement | session `instructions` | one session | No, but session metadata is org-visible |
| Current route/selection/viewport snapshot | `turnInstructions` | one accepted turn | No |
| What the user said | message text / `initialMessage` | durable conversation | Yes |

Use `requestedSessionId` plus a stable `idempotencyKey` when the product must
persist its own link before the first OpenGeni turn can run. The ID is
correlation, not authorization.

Turn context is a snapshot, not a substitute for tools. If the agent needs
current product state or must mutate product data, expose a tenant-scoped MCP
server. Keep tool outputs machine-useful; the product may render a separate,
more concise user-facing projection.

## Ownership Of Product Data

Keep customer domain records in the customer product. Give the agent authorized
MCP tools to read or change them. Store only OpenGeni-native facts in OpenGeni:
sessions, events, selected resources/tools/skills, files used by sessions,
approvals, goals, schedules, and execution state.

Do not duplicate the customer's project/contact/document model into OpenGeni
only to make it available to the agent. Conversely, do not treat OpenGeni's
event stream as the customer's domain audit log. Each system remains canonical
for the state it owns.

## Files And Artifacts

- One-off user attachments use `OpenGeniClient.uploadFile`, then a file resource
  on session create or message send.
- Indexed reusable knowledge uses the document/knowledge APIs when enabled.
- Product-domain documents may stay in the product and be exposed through the
  product's MCP server when OpenGeni should not own a second copy.
- Agent-produced durable product records should be written through product MCP
  tools. Do not infer a generic write-back/artifact path that the live service
  does not expose.

## Realtime And Compute

Realtime is an optional session transport, not a second agent. Use the public
SDK/React realtime subpaths so negotiation, lifecycle, recovery, and durable
session context stay server-owned.

Managed Sandboxes and Connected Machines are compute choices for a session.
They do not change the product integration boundary. A customer product should
only expose machine selection/enrollment when its users need to run on their own
computers; ordinary embedded agents should use the deployment default.

## Delivery Checklist

Before calling an integration complete, verify:

1. Credentials never reach browser bundles, logs, prompts, or generated skills.
2. Product authorization is checked before every workspace/session proxy call.
3. Session creation retries reuse one idempotency key.
4. SSE reconnect resumes by sequence and does not duplicate timeline effects.
5. Unknown additive event types do not crash the client.
6. File upload works from every intended browser origin, including signed PUT
   CORS and completion.
7. Prompt scopes are used correctly; visible text is not carrying hidden policy.
8. MCP tools enforce the same tenant/user boundary as the product API.
9. Narrow and wide layouts work without host CSS reaching into SDK internals.
10. The integration pins compatible SDK/server major versions and checks the
    live client config rather than hard-coding volatile catalogs.
