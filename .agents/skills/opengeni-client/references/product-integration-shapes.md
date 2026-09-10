# Product Integration Shapes

This reference helps a customer-side agent decide how a product should use a
standalone OpenGeni deployment. It is intentionally architecture-level. Verify
exact methods and props against the installed `@opengeni/sdk` and
`@opengeni/react` versions.

When the OpenGeni repository is available, read `docs/product-integration.md`
first. It is the canonical contract for organization API keys, organization
workspaces, Personal-workspace exclusion, and external Skill ownership.

## The Common Architecture

```text
customer browser / mobile app
            |
            | customer session, same-origin product API
            v
customer backend / tenant boundary
  - stores one organization API key
  - maps the chosen product sharing boundary -> organization workspace
  - stores/version-controls product Skills
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

The external product is the runtime Skill source of truth. There is no
organization-wide Skill registry or Skill inheritance in the product
integration contract; selected Skills are sent inline for each product-created
session.

## Choose The Isolation Unit

One workspace per product tenant is correct only when that tenant may share
workspace-scoped agent authority and resources. Default to:

| Sharing requirement | Workspace mapping |
| --- | --- |
| Tenant/team chats may collaborate | Per tenant/team |
| Chats are private between end users | Per end user |
| Every chat is a hard boundary, including within one user | Per chat |
| Data is shared but chats are private | Per user/chat, with equivalent scoped data access |

A live agent with the relevant first-party session tools can reach unrelated
sessions in the same workspace. Turning workspace Memory off does not change
that. Removing all unnecessary cross-session and workspace-wide tools is useful
defense in depth for an explicitly softer design, but a hard requirement needs
separate workspaces.

An organization API key creates workspace-visible top-level sessions. It does
not impersonate the customer's end user as an OpenGeni managed human and cannot
use Only-me visibility as a substitute for the mapping above.

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
- Maps that principal to one allowed OpenGeni organization workspace and
  allowed sessions. Personal workspaces are excluded.
- Holds the organization API key or delegated credentials.
- Calls `ensureWorkspace` with the product tenant's stable external identity and
  stores `result.workspace.id`; `result.created` distinguishes create from
  idempotent replay.
- Loads product-owned Skills and passes the selected definitions inline in
  `CreateSessionRequest.skills` for each product-created session.
- Sends explicit minimal `tools` and `firstPartyMcpTools` selections. Omission
  inherits workspace/deployment defaults; an explicit empty array suppresses
  that category.
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
- Never receives an organization API key just because it renders an agent.

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
| Current route/selection/viewport snapshot | `modelContext` | one accepted message | No in the standard timeline; yes in full audit data |
| What the user said | message text / `initialMessage` | durable conversation | Yes |

Use `requestedSessionId` plus a stable `idempotencyKey` when the product must
persist its own link before the first OpenGeni turn can run. The ID is
correlation, not authorization.

`modelContext` is ordinary user-role model content, not a system instruction or secret. It is a snapshot, not a substitute for tools. If the agent needs
current product state or must mutate product data, expose a tenant-scoped
OpenAPI/GraphQL Integration or MCP server. Keep tool outputs machine-useful;
the product may render a separate, more concise user-facing projection.

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

## Delivery Autonomy

Infer the delivery workflow from the user's request, repository guidance, CI,
and environment documentation. Implement and test when asked to implement, but
do not treat available repository or cloud credentials as authorization to
push, open a pull request, merge, deploy, or mutate production. Perform a named
external step when it was authorized clearly. Otherwise finish the safe work
and ask at the actual boundary, naming the target and impact, or provide the
customer-owned runbook when they retain deployment authority.

## Delivery Checklist

Before calling an integration complete, verify:

1. Credentials never reach browser bundles, logs, prompts, or generated skills.
2. The selected tenant/user/chat sharing boundary maps to distinct or shared
   workspaces exactly as intended.
3. Product authorization is checked before every workspace/session proxy call.
4. The effective first-party and external tool allowlists contain only required
   capabilities.
5. Session creation retries reuse one idempotency key.
6. SSE reconnect resumes by sequence and does not duplicate timeline effects.
7. Unknown additive event types do not crash the client.
8. File upload works from every intended browser origin, including signed PUT
   CORS and completion.
9. Prompt scopes are used correctly; visible text is not carrying hidden policy.
10. API/MCP tools enforce the same tenant/user boundary as the product API.
11. Narrow and wide layouts work without host CSS reaching into SDK internals.
12. The integration pins compatible SDK/server major versions and checks the
    live client config rather than hard-coding volatile catalogs.
