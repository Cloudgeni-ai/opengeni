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

For each product tenant, call `ensureWorkspace` /
`PUT /v1/workspaces/external` with a stable external mapping identity and persist
the returned `result.workspace.id`; `result.created` distinguishes the first
insert from an idempotent replay. Call it an **organization workspace** in
customer guidance; its exact wire kind is `"shared"`. Personal workspaces are
excluded and must never be selected through a default-workspace fallback.

The external backend owns product Skills. Store and version them outside
OpenGeni, then pass the selected definitions inline in
`CreateSessionRequest.skills` for each product-created session. There is no
organization-wide Skill registry or Skill inheritance in this integration
contract.

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
6. Attach only canonical resources and tool selections the user may use.
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
- Do not invent an organization-wide Skill registry or rely on Skill
  inheritance. The external backend passes selected Skills inline per session.
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
