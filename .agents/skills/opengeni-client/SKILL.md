---
name: opengeni-client
audience: integration-agent
description: >-
  Use when an external product, coding agent, CLI, backend, or automation uses a
  standalone OpenGeni deployment through @opengeni/sdk or @opengeni/react.
  Covers choosing between a stock-UI handoff, a headless product integration,
  embedded React session surfaces, or the optional workbench; tenant-safe proxy
  boundaries; workspace/session/turn instructions; events, uploads, tools,
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

## Default Trust Boundary

- Keep OpenGeni API keys and operator credentials on the product server.
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

## Prompt And Context Contract

Keep visible user text separate from system-level agent context:

- Workspace `agentInstructions`: stable workspace-wide persona and behavior.
- Session `instructions`: durable agent-type refinement for one session.
- Turn `turnInstructions`: one exact submit-time context snapshot, such as the
  current product route, selected entity, or viewport state.
- `initialMessage` and later message text: user-visible timeline content.

Do not hide business facts in a prompt when the agent should inspect them with
an authorized product MCP tool. Prefer concise turn context plus canonical tool
access. Never put secrets in any instruction scope.

## Client Workflow

1. Resolve API base URL, credential mode, and product user-to-workspace mapping.
2. Read client config and access context.
3. Create a session with a stable idempotency key; optionally preallocate its ID
   when the product must persist a link before the first turn can run.
4. Attach only canonical resources, skills, and tool selections the user may use.
5. Stream/replay session events through the SDK; tolerate unknown additive event
   types.
6. Send visible text separately from `turnInstructions`.
7. Use the SDK upload helper; it owns begin, signed storage PUT, and completion.
8. Surface approvals, human-input requests, queue state, errors, credit limits,
   and reconnect state as product state rather than generic chat text.
9. Add realtime, Connected Machines, schedules, or the workbench only when the
   product use case needs them.

## Guardrails

- Workspace-scoped routes are canonical; resource IDs never authorize by
  themselves.
- Do not call Temporal, NATS, Postgres, workers, sandbox providers, object
  storage APIs, or MCP transports as substitutes for the public SDK/API.
- Do not claim auth, model, tool, billing, CORS, storage, or compute behavior
  until the live deployment or current source proves it.
- Keep examples generic and parameterized. Skills may name non-secret origins
  and conventions, but credentials come from a secret manager or environment.
- Generate a customer-specific skill only for stable facts their coding agents
  repeatedly need. Keep it beside their integration code, point it at the SDK,
  include a config/access smoke probe, and never paste secrets into it.
