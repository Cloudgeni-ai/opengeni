---
name: opengeni-client
audience: integration-agent
description: >-
  Integrate OpenGeni into an external product, website, backend, CLI, or
  automation. Defaults to embedding the full React conversation behind the
  packaged SDK session proxy. Use for discovery, connecting repositories and
  resources, SDK/API and React choices, implementation, verification, and
  handoff against a managed, self-hosted, or local OpenGeni deployment. Not for
  changing OpenGeni internals or mounting its runtime inside the customer's
  process.
---

# OpenGeni Client

Use this skill when a customer's product and OpenGeni remain separate systems.
That is the normal integration shape: the product owns its users and business
UI, while a standalone OpenGeni deployment owns agent sessions and execution.

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

Without repository access, start at https://docs.opengeni.ai/llms.txt and fetch
the relevant Markdown pages. Before replacing an AI provider, answering a cost
question, or reporting a setup blocker, read
[Compatibility and troubleshooting](references/compatibility-and-troubleshooting.md).

## Work Adaptively

This same guide is bundled as `builtin:opengeni-client` in ordinary OpenGeni
sessions and lives in `.agents/skills/opengeni-client` for external coding agents.
No Pack, installation, repository clone, or sandbox is needed to read the bundled
copy. It is guidance, not authority to access a repository, secret, or deployment.
Embedded products may narrow bundled guidance with `bundledSkillIds`.

- Inspect the customer's repository, authentication, tenancy, data routes,
  frontend conventions, installed packages, tests, CI, and deployment guidance
  before asking questions or choosing an integration shape.
- If the target repository or resources are missing, first inspect available
  authorized resources and connection/setup tools. Help the user connect or
  attach the specific missing source; explain the next action in product terms.
  Continue useful discovery without requesting broad credentials or pretending
  missing access is configured. Read
  [Discovery and autonomy](references/discovery-and-autonomy.md) for that workflow.
- Ask only for consequential product choices or external authority that cannot
  be inferred. Offer a recommended setup and use the existing structured question
  UI, when available, for the few unresolved choices about chat sharing, learning
  across chats, or data access. Skip choices already settled; do not impose an
  onboarding questionnaire. See [Discovery and autonomy](references/discovery-and-autonomy.md).
- Use a reversible, clearly stated default when an unresolved choice is
  low-risk. Resolve privacy, tenant authority, data writes, cost exposure, and
  ambiguous external mutations before crossing those boundaries.
- Match the requested delivery autonomy. Repository or cloud access is
  technical capability, not permission to push, deploy, merge, or change
  production.
- This Skill guides an implementation agent. Never copy it into the runtime
  Skills of the customer-facing agent.

## Default: the full conversation behind a packaged proxy

Default to OpenGeni's complete conversation experience: `@opengeni/react`'s
`SessionConversation` plus `@opengeni/react/compiled.css` (brand it with
`--og-*` tokens), backed by the normal session SDK through
`createSessionProxyHandler`, a tenant/user-scoped same-origin proxy on the
product server. It already provides streaming, replay, queue, steer, approvals,
human input, attachments, and pause/resume. Deviate only when the product needs
a materially different interaction model, a non-React frontend, or compute
surfaces, and record why.

```ts
// Server only: the organization API key never reaches the browser.
import { OpenGeniClient, createSessionProxyHandler } from "@opengeni/sdk";

const og = new OpenGeniClient({ baseUrl: OPENGENI_URL, apiKey: OPENGENI_API_KEY });
const source = "acme-app"; // stable external-identity namespace

// 1. Onboarding, once per tenant and admitted user (persist workspace.id and operationId).
const { workspace } = await og.ensureWorkspace({
  accountId: OPENGENI_ORGANIZATION_ID, externalSource: source,
  externalId: tenant.id, name: tenant.name,
});
await og.addExternalWorkspaceMember(workspace.id, {
  identity: { externalId: user.id, source },
  permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read"],
  operationId,
});

// 2. The server creates sessions: explicit tools, stable idempotency key.
const session = await og.asUser(user.id, { source }).createSession(workspace.id, {
  initialMessage: `Help me with ticket ${ticket.id}`,
  idempotencyKey: `ticket:${ticket.id}:${user.id}`,
  skills: productSkills, // product-owned, inline
  tools: [{ kind: "mcp", id: "acme" }], // explicit minimal selection
  firstPartyMcpTools: [],
});

// 3. Mount at /api/opengeni/* (Next.js route handler, Hono, Bun.serve, workers).
export const handler = createSessionProxyHandler(og, {
  resolve: async (request) => {
    const me = await authenticate(request); // the product's own session check
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

The proxy calls `resolve` per request, acts only through `asUser`, pins the
workspace, and serves only provider/conversation routes. Browser creation needs
a server `createSession` hook returning the full request. Never replace the
proxy with a raw passthrough of arbitrary paths under the organization key.
Reset UI state when the user or tenant changes.

## Deliberate deviations

Choose one only for its stated reason; read
[Product shapes and UI](references/product-shapes-and-ui.md) first.

- **Headless React hooks** (`@opengeni/react/session`): the product needs a
  materially different interaction model but still wants canonical event,
  queue, composer, approval, and human-input behavior.
- **SDK only**: a non-React frontend (Svelte, Vue, native mobile), a CLI, or
  backend automation. Keep the SDK on a product backend route.
- **Workbench**: the product genuinely exposes agent compute (changes, files,
  terminal, desktop). It has optional heavy peers.
- **Chat facade fallback** (`@opengeni/sdk/chat`): the product already has a
  chat UI speaking Vercel `useChat` or an OpenAI-shaped protocol, or a
  server-side bot needs `og.chat(...).send()`. It is a text-only projection:
  tool outputs are dropped, with no files, artifacts, images, goals, queue, or
  steer UI, and reopening restores only text. See
  [Chat facade fallback](references/chat-facade-fallback.md).
- **In-process embedding** of the OpenGeni runtime is infrastructure work; see
  the repo-maintainer `opengeni` skill and `docs/embedding.md`.

Verify delivery with representative product questions, checking useful answers
and actual tool execution, not just connectivity: see
[Integration configuration and verification](references/runtime-profile-and-verification.md).
Read selectively: [Product integration shapes](references/product-integration-shapes.md),
[API workflows](references/api-workflows.md),
[Isolation and authorization](references/isolation-and-authorization.md),
[Data tools and credentials](references/data-tools-and-credentials.md), and
[External users and embedded connection setup](references/external-users-and-connect.md).

This tree is the canonical developer guide for product integration. It does not
define a runtime profile API, schedule Skill fields, or a new registry; an
integration's "runtime profile" is configuration owned by the customer's code.

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
- Use `createSessionProxyHandler` for the React conversation, or
  `proxySessionEventStream` inside a custom same-origin SSE route.
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
Connections, and integrations: normally one per customer, and a separate one
when groups need different Connections, integrations, or instructions. Use
`asUser(externalId)` for the authenticated product user; the server derives the
canonical user, so never supply an `endUser` label as authority. Human
visibility is `visibility` (verified external owners can create private sessions
when the organization enables it; private sessions do not make workspace Files
or Sites private). `agentAccess: "session" | "user" | "workspace"` separately
limits outbound agent reach; the target's `agentAccess` never restricts inbound
access, and removing tools is not a substitute for private visibility.
Compatibility `memoryScope: "workspace" | "user" | "off"` selects Knowledge
authoring scope, not transcript visibility; Off leaves authorized retrieval
available, and personal Knowledge belongs to the verified user of the active
turn. Use task notes for temporary session-tree coordination; there is no
active session Memory scope. Unscoped organization-key-created top-level
sessions are workspace-visible, and managed-human Only-me sessions are not a
backend impersonation mechanism. See `references/external-users-and-connect.md`.

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

New Skill inputs require valid `SKILL.md` frontmatter, which owns the name and
description. Do not replay old headerless Skills as new session input.

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

1. Load the server-held organization API key; resolve the authenticated product
   tenant, call `ensureWorkspace`, and persist the opaque workspace mapping.
2. Read client config and access context without a Personal-workspace fallback.
3. Create sessions with the product-selected inline Skills, a stable idempotency
   key (optionally a preallocated ID), canonical resources, and an explicit
   minimal tool selection. Omitted tool selections inherit workspace/deployment
   defaults, including first-party workspace and cross-session capabilities.
4. Serve the browser through the packaged proxy, or stream/replay through the
   SDK in a custom route; tolerate unknown additive event types.
5. Send visible text separately from `modelContext`; upload through the SDK
   helper, which owns begin, signed storage PUT, and completion.
6. Surface approvals, human-input requests, queue state, errors, credit limits,
   and reconnect state as product state rather than generic chat text.
7. Add realtime, Connected Machines, schedules, or the workbench only when the
   product use case needs them.

## Guardrails

- Workspace-scoped routes are canonical; resource IDs never authorize by
  themselves.
- Organization workspaces have wire `kind: "shared"`; Personal workspaces are
  outside the external product mapping.
- Use one workspace per customer and private/shared visibility for human
  access. Knowledge settings and prompt instructions do not create a tenant boundary.
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
