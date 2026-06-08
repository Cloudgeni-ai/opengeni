---
name: opengeni-client
description: Use when integrating a customer product, coding agent, generic automation agent, CLI, SDK, or backend service with the OpenGeni API. Covers managed API-key auth, configured/self-host bearer auth, workspace discovery, workspace-scoped sessions, SSE/event replay, files, documents/search, schedules, GitHub repository resources, billing/limits handling, safe retries, and keeping client guidance aligned with the live OpenGeni service rather than stale docs.
---

# OpenGeni Client

Use this skill to help a customer-side agent or product consume OpenGeni as an API service. It is for client integration, not for editing OpenGeni internals.

Code and live service behavior are the source of truth. Prefer `/v1/config/client`, `/v1/access/me`, contracts/OpenAPI when available, and live HTTP probes over memorized route lists. If the OpenGeni repo is available and exactness matters, inspect `packages/contracts/src/index.ts`, `apps/api/src/routes/`, and `apps/web/src/api.ts`.

## Core Model

- Managed SaaS browser users sign up with email/password, then create OpenGeni product API keys.
- Product API keys and configured/delegated tokens use `Authorization: Bearer <token>`.
- The optional deployment shared key uses `x-opengeni-access-key` and is only an operator/edge boundary.
- Workspace-scoped routes are canonical: `/v1/workspaces/:workspaceId/...`.
- Old unscoped operational routes are intentionally removed, not soft-deprecated.
- Resource ids never authorize by themselves; use the URL workspace plus credential grant.
- Sessions and scheduled tasks are the current run primitives. Do not assume a first-class agent-definition API exists until the live service exposes one.

## Integration Workflow

1. Determine the API base URL and credential type.
2. Fetch `/v1/config/client` to learn auth mode, model options, MCP providers, and upload capability.
3. Call `/v1/access/me`; use `defaultWorkspaceId` or list/create workspaces if permissions allow.
4. Create sessions under `/v1/workspaces/:workspaceId/sessions`.
5. Stream events from `/v1/workspaces/:workspaceId/sessions/:sessionId/events/stream` and replay from the event list after reconnects.
6. Upload files through the workspace file upload flow before attaching file resources.
7. Select MCP tools by configured id, such as OpenGeni, Files, or Document Search.
8. Use workspace GitHub repository listings before attaching private GitHub App repositories.
9. For recurring work, create scheduled tasks under the workspace and inspect run history.
10. Treat 401/403/404/402/429 as product signals: re-authenticate, switch workspace, stop on missing permissions, top up credits, or back off.

Read `references/api-workflows.md` for request shapes, retry guidance, and common client patterns.

## Guardrails

- Never put raw OpenGeni API keys, deployment shared keys, Stripe secrets, GitHub App secrets, cookies, or customer data into generated skills, docs, examples, or logs.
- Keep client examples generic and parameterized: `OPENGENI_API_BASE_URL`, `OPENGENI_API_KEY`, and `OPENGENI_WORKSPACE_ID`.
- Do not tell customer agents to call Temporal, NATS, Postgres, the worker, or the sandbox directly.
- Do not claim RLS, billing, GitHub, model, or sandbox behavior unless the deployed service or current source proves it.
- When behavior is ambiguous, write a small HTTP probe or inspect live responses instead of guessing.
