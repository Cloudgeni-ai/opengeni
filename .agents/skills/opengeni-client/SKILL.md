---
name: opengeni-client
audience: integration-agent
description: >-
  Use when an external product, coding agent, CLI, backend, or automation uses a
  standalone OpenGeni deployment through @opengeni/sdk or @opengeni/react.
  Covers choosing between a stock-UI handoff, a headless product integration,
  embedded React session surfaces, or the optional workbench; tenant-safe proxy
  boundaries; workspace/session instructions and per-message context; events, uploads, tools,
  realtime, compute targets, and schedules. Not for editing OpenGeni internals
  or mounting the OpenGeni runtime in the customer's process.
---

# OpenGeni Client

Use this skill when a customer's product and OpenGeni remain separate systems.
That is the normal integration shape: the product owns its users and business
UI, while a standalone OpenGeni deployment owns agent sessions and execution.

Do not interpret "embed" as "move OpenGeni into the product process." Advanced
in-process router/core embedding is a separate infrastructure choice. Route that
work to the repo-maintainer `opengeni` skill and `docs/embedding.md`.

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

## Work Adaptively

- Inspect the customer's repository, authentication, tenancy, data routes,
  frontend conventions, installed packages, tests, CI, and deployment guidance
  before asking questions or choosing an integration shape.
- Ask only for consequential product choices or external authority that cannot
  be inferred. Do not ask the customer to restate facts the system proves.
- Use a reversible, clearly stated default when an unresolved choice is
  low-risk. Resolve privacy, tenant authority, data writes, cost exposure, and
  ambiguous external mutations before crossing those boundaries.
- Match the requested delivery autonomy. Repository or cloud access is
  technical capability, not permission to push, deploy, merge, or change
  production.
- This Skill guides an implementation agent. Never copy it into the runtime
  Skills of the customer-facing agent.

## Fastest Path: `@opengeni/sdk/chat`

When using `user`, first provision that user's approved workspace membership
through the explicit onboarding flow in `references/external-users-and-connect.md`.
The facade uses `asUser()` and never grants or restores membership on a chat
request. An existing tenant is not proof that this user belongs to it. For shared
conversations use the same OpenGeni session ID; identity changes authority, not
the conversation address. Use `chatBySessionId` to reopen historical sessions
whose IDs were derived with the old user-namespaced helper.

Start here when the product already has a chat, or wants one, and OpenGeni
should sit behind it. Install, keep the organization API key on the server, and
put one handler behind the chat endpoint:

```bash
bun add @opengeni/sdk
```

```ts
import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

const og = new OpenGeni({
  apiKey: process.env.OPENGENI_API_KEY!,
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
});

export const POST = createChatHandler(og, {
  // Your auth hook. Tenant and user come from the authenticated request, never the body.
  resolve: async (request) => {
    const me = await authenticate(request);
    return me ? { tenant: me.accountId, user: me.userId } : new Response("Unauthorized", { status: 401 });
  },
  // format: "vercel" keeps an existing useChat client; "openai-chat" / "openai-responses"
  // keep an OpenAI-shaped client. The default streams native chunks for custom clients.
});

// Server-side use without an endpoint:
const chat = await og.chat({ tenant: "acme", user: "u_42", conversation: "c_9" });
const reply = await chat.send("hello"); // reply.text; chat.stream(...) yields chunks
```

Browser: use a custom or compatible frontend for the backend chat handler.
For native OpenGeni React UI, install `@opengeni/react` and use
`SessionConversation` or compose `MessageTimeline` and `ChatComposer` with
the normal SDK and authenticated session routes. Reset private UI state and cancel old
requests when the authenticated user or tenant changes. Every customer gets one workspace (`tenant`), every
conversation one deterministic session, and each session picks its own
isolation. Conversation IDs are independent of the acting user; ordinary API
authorization decides who can use the same shared conversation. Without a `user`,
`resolve` must return the `conversation` itself. The Vercel and OpenAI adapters
send only the latest user message and import earlier messages once as context
on the first message; afterwards OpenGeni owns the history.

| Scenario | `agentAccess` | `memory` |
| --- | --- | --- |
| Support desk: agent confined to its chat tree | `"session"` (default) | `false` (default) |
| Agents restricted to their canonical user's chats | `"user"` with `asUser()` | `"user"` |
| A team collaborating across chats | `"workspace"` | `"workspace"` |
| Any of the above without Memory tools | any | `false` |

`agentAccess` is enforced in the server-side session-authorization seam for
agents as outbound task scope: own tree, same canonical user, or workspace.
A narrow target remains reachable by an authorized broad coordinator; target
private visibility and normal permissions still apply. `asUser()` establishes
canonical authority, not a second end-user label. Graduate to `og.client`
(`OpenGeniClient`) on the same `chat.sessionId` when the product needs files,
tools, approval policies, forks, or realtime voice. The
`examples/chat-quickstart` directory provides a backend-only server example.

## Choose The Integration Shape First

Pick the smallest surface that satisfies the product:

1. **Stock OpenGeni handoff** — link or deep-link into the OpenGeni web app.
   The product keeps no agent UI.
2. **Headless product integration (default)** — the product backend uses
   `@opengeni/sdk`; the product renders its own UI and exposes tenant-scoped,
   same-origin routes to its browser or mobile client.
3. **React session integration** — compose `@opengeni/react/session` hooks and
   pure projections into the product's UI. Add styled subpaths only for the
   surfaces the product wants.
4. **OpenGeni-rendered React experience** — mount the packaged composer,
   timeline, realtime, or session chrome and import
   `@opengeni/react/compiled.css` once. No Tailwind setup or source scan is
   required. Override `--og-*` tokens only when branding is wanted.
5. **Workbench integration** — mount the optional Changes/Files/Terminal/Desktop
   workspace when the product genuinely exposes agent compute. It has optional
   heavy peers and is not required for ordinary chat/session integration.

Read `references/product-integration-shapes.md` before designing the boundary.
Read `references/api-workflows.md` for session, upload, retry, repository,
machine, and schedule patterns.

For deeper implementation decisions, read selectively:

- [Discovery and autonomy](references/discovery-and-autonomy.md)
- [Isolation and authorization](references/isolation-and-authorization.md)
- [Product shapes and UI](references/product-shapes-and-ui.md)
- [Data tools and credentials](references/data-tools-and-credentials.md)
- [Integration configuration and verification](references/runtime-profile-and-verification.md)
- [Implementation checklist](references/implementation-overview.md)
- [External users and embedded connection setup](references/external-users-and-connect.md)

This tree is the canonical developer guide for both repository installation and
the generated OpenGeni Product Integration Pack. It does not define a runtime
profile API, schedule Skill fields, or a new registry. Any references to an
integration's "runtime profile" mean configuration owned by the customer's code,
not a new OpenGeni resource. The Pack remains inactive until explicitly selected
for a coding session.

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
- Use `@opengeni/sdk` instead of reconstructing event streaming, upload signing,
  retries, or wire types by hand.
- Use `proxySessionEventStream` for a same-origin browser SSE route. Structural
  React client types let a host implement only the methods its mounted hooks use.
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

Use one organization API key for the external backend. Organization key
administration is exposed through `listOrganizationApiKeys`,
`createOrganizationApiKey`, and `deleteOrganizationApiKey`, corresponding to
the organization-scoped `/v1/organizations/:organizationId/api-keys` routes.
The create response shows the token once; store it only in the product's secret
manager.

For each chosen product sharing boundary, call `ensureWorkspace` /
`PUT /v1/workspaces/external` with a stable external mapping identity and persist
the returned `result.workspace.id`; `result.created` distinguishes the first
insert from an idempotent replay. Call it an **organization workspace** in
customer guidance; its exact wire kind is `"shared"`. Personal workspaces are
excluded and must never be selected through a default-workspace fallback.

Choose the workspace from who shares documents, workspace instructions,
Connections, and integrations: normally one workspace per customer. Chat
human visibility is controlled by `visibility`, not by `agentAccess` or Memory.
Use `asUser(externalId)` for the authenticated product user. The server derives
the canonical user; never supply an `endUser` label as authority. Separately,
`agentAccess: "session" | "user" | "workspace"` controls cross-session agent
reach. `memoryScope: "workspace" | "user" | "off"` controls Memory tools, not
transcript visibility. User Memory belongs to the verified user of the active
turn, including when different users collaborate in one shared session. Use
existing task notes for temporary session-tree coordination; there is no active
session Memory scope. Use a separate workspace when groups need different
Connections, integrations, or instructions.

Unscoped organization-key-created top-level sessions are workspace-visible.
For product-user ownership, use the server-side `asUser(externalId)` client and
explicit workspace membership described in `references/external-users-and-connect.md`;
verified external owners can create private sessions when the organization enables
that feature. Private sessions do not make workspace Files or Sites private.
Managed-human Only-me sessions are not a backend impersonation mechanism. A live
agent with cross-session tools can reach unrelated sessions only when its
outbound `agentAccess` scope and ordinary resource authorization allow it.
The target's `agentAccess` never restricts inbound access; private-session
ownership and ordinary permissions still apply.
Removing tools is not a substitute for private human visibility.

The external backend owns product Skills. Store and version them outside
OpenGeni, then pass the selected definitions inline in
`CreateSessionRequest.skills` for each product-created session. There is no
organization-wide Skill registry or Skill inheritance in this integration
contract.

Use `CreateSessionRequest.bundledSkillIds` to narrow OpenGeni's bundled guidance
independently: omitted means defaults, `[]` means none, and explicit IDs such as
`builtin:opengeni-documents` allow only those whose normal inclusion rules hold.
Children inherit and can only narrow; scheduled-task `agentConfig` and automation
`sessionTemplate` accept the same field. This does not hide workspace or inline
Skills, grant tools, or disable eager `skill_read`. Keep the selection stable on
keyed-create retries. Never try to control it through arbitrary session metadata.

Pack installation `manifestSnapshot` is historical JSON, not a current admission
contract. Preserve it alongside `manifestDigest`; do not normalize its Skill
labels or replay old headerless Skills as new session input. New inputs require
valid `SKILL.md` frontmatter, which owns the name and description.

## Prompt And Context Contract

Use each prompt surface for its exact authority and lifetime:

- Workspace `agentInstructions`: stable workspace-wide system persona and behavior.
- Session `instructions`: durable system-level agent refinement for one session.
- `modelContext`: ordinary model-visible content attached to one exact user
  message as a separate history part; standard timeline rendering omits it.
- `initialMessage` and later message text: the visible part of that user message.

`modelContext` is not secret, private, or privileged; full event/audit reads may
return it. Do not hide business facts in a snapshot when the agent should inspect
them with an authorized product MCP tool. Prefer concise message context plus
canonical tool access. Changing `modelContext` must not change the persistent
agent instruction prefix.

## Client Workflow

1. Resolve the API base URL and load the server-held organization API key.
2. Resolve the authenticated product tenant, call `ensureWorkspace` with its
   stable external identity, and persist or verify the opaque workspace mapping.
3. Read client config and access context without falling back to a Personal
   workspace.
4. Load the exact Skills selected by the external product and pass them inline.
5. Create a session with a stable idempotency key; optionally preallocate its ID
   when the product must persist a link before the first turn can run.
6. Attach only canonical resources and an explicit minimal tool selection the
   user may use. Omitting tool selections inherits workspace/deployment
   defaults, including first-party workspace and cross-session capabilities.
7. Stream/replay session events through the SDK; tolerate unknown additive event
   types.
8. Send visible text separately from `modelContext`.
9. Use the SDK upload helper; it owns begin, signed storage PUT, and completion.
10. Surface approvals, human-input requests, queue state, errors, credit limits,
   and reconnect state as product state rather than generic chat text.
11. Add realtime, Connected Machines, schedules, or the workbench only when the
   product use case needs them.

## Guardrails

- Workspace-scoped routes are canonical; resource IDs never authorize by
  themselves.
- Organization workspaces have wire `kind: "shared"`; Personal workspaces are
  outside the external product mapping.
- Use one workspace per customer and private/shared visibility for human
  access. Memory settings and prompt instructions do not create a tenant boundary.
  `agentAccess` optionally restricts agent reach further; tool removal is
  defense in depth, not a replacement for authorization.
- Use separate workspaces only when groups must not share documents,
  Connections, integrations, or workspace instructions.
- Do not invent an organization-wide Skill registry or rely on Skill
  inheritance. The external backend passes selected Skills inline per session.
- The SDK cannot accept arbitrary customer backend functions as remote tools.
  Expose an existing API through a reviewed OpenAPI/GraphQL Integration or an
  MCP server.
- OpenGeni's credential broker encrypts secrets and keeps them out of model
  context, but the trusted control plane can decrypt them for the authorized
  provider request. Do not describe it as zero knowledge.
- Do not call Temporal, NATS, Postgres, workers, sandbox providers, object
  storage APIs, or MCP transports as substitutes for the public SDK/API.
- Do not claim auth, model, tool, billing, CORS, storage, or compute behavior
  until the live deployment or current source proves it.
- Keep examples generic and parameterized. Skills may name non-secret origins
  and conventions, but credentials come from a secret manager or environment.
- Generate a customer-specific skill only for stable facts their coding agents
  repeatedly need. Keep it beside their integration code, point it at the SDK,
  include a config/access smoke probe, and never paste secrets into it.
  Start from `references/customer-skill-template.md` when the OpenGeni skill
  package is available.
