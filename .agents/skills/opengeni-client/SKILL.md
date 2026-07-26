---
name: opengeni-client
audience: integration-agent
description: Use when integrating a customer product, coding agent, generic automation agent, CLI, SDK, or backend service with the OpenGeni API. Covers managed API-key auth, configured/self-host bearer auth, workspace discovery, workspace-scoped sessions, choosing a session's compute target (a managed sandbox or an enrolled Connected Machine), machine enrollment (device-flow consent + headless enroll tokens), SSE/event replay, files, documents/search, schedules, GitHub repository resources, billing/limits handling, safe retries, and keeping client guidance aligned with the live OpenGeni service rather than stale docs.
---

# OpenGeni Client

This skill is for integration agents building customer products, CLIs, SDK wrappers, or automations against an OpenGeni API service.

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
- Every session picks a compute target at creation. Two co-equal kinds: a **Managed Sandbox** (a platform-owned ephemeral box, selected via the `sandboxBackend` enum and the `sandbox` placement union) or a **Connected Machine** (a user-owned machine enrolled into the workspace, addressed by `targetSandboxId` plus an optional per-session `workingDir`).
- A Connected Machine is first-class *primary* compute, not a backend overlay: there is no phantom cloud box behind it, no OpenGeni credential is distributed to it (it uses its own git auth), repos are not cloned onto it, and the session runs directly under the chosen `workingDir` on the machine. `selfhosted` is the internal `sandboxBackend` enum value for such a machine — prefer the product term "Connected Machine" in client-facing copy.
- Enrolling a machine is a client capability: an interactive device flow with a loud whole-machine consent step, or a headless enroll token for fleet/non-interactive enrollment. Gated by `enrollments:read` (list a workspace's machines) and `enrollments:manage` (approve/mint/revoke); `workspace:admin` is the super-wildcard over both.

## Integration Workflow

1. Determine the API base URL and credential type.
2. Fetch `/v1/config/client` to learn auth mode, model options, MCP providers, and upload capability.
3. Call `/v1/access/me`; use `defaultWorkspaceId` or list/create workspaces if permissions allow.
4. Create sessions under `/v1/workspaces/:workspaceId/sessions`, choosing the compute target: omit the sandbox fields for a managed sandbox (optionally pin `sandboxBackend` or the `sandbox` placement union), or set `targetSandboxId` (plus an optional `workingDir`) to run the session on an enrolled Connected Machine.
5. Stream events from `/v1/workspaces/:workspaceId/sessions/:sessionId/events/stream` and replay from the event list after reconnects.
6. Upload files through the workspace file upload flow before attaching file resources.
7. Select MCP tools by configured id, such as OpenGeni, Files, or Document Search.
8. Use workspace GitHub repository listings before attaching private GitHub App repositories.
9. For Connected Machines: list a workspace's machines (and their metrics) before targeting one, swap a session's active machine after create when needed, and enroll new machines through the device-flow (with consent) or a headless enroll token.
10. For recurring work, create scheduled tasks under the workspace and inspect run history.
11. Treat 401/403/404/402/429 as product signals: re-authenticate, switch workspace, stop on missing permissions, top up credits, or back off.

If you build a React client with `@opengeni/react`, the root entrypoint is the clean sandbox-only default. The Connected-Machine UI — the machines dashboard, the enrollment device-flow/consent screens, and the machine status pills — lives under the `@opengeni/react/machines` subpath (the root still re-exports it for back-compat, deprecated per #144). Separately, the root-exported sandbox-surfacing components (`WorkspaceDock`, `SandboxTerminal`, `FileBrowser`, `DiffView`, `DesktopViewer`) pull heavy client deps (`@xterm/*`, `@novnc/novnc`, `@pierre/diffs`, `@uiw/react-codemirror`, `@codemirror/lang-*`) as optional peer dependencies you install only for the surfaces you mount.

Read `references/api-workflows.md` for request shapes, retry guidance, and common client patterns.

## Guardrails

- Never put raw OpenGeni API keys, deployment shared keys, Stripe secrets, GitHub App secrets, cookies, or customer data into generated skills, docs, examples, or logs.
- Keep client examples generic and parameterized: `OPENGENI_API_BASE_URL`, `OPENGENI_API_KEY`, and `OPENGENI_WORKSPACE_ID`.
- Do not tell customer agents to call Temporal, NATS, Postgres, the worker, or the sandbox directly.
- Do not claim RLS, billing, GitHub, model, or sandbox behavior unless the deployed service or current source proves it.
- When behavior is ambiguous, write a small HTTP probe or inspect live responses instead of guessing.
