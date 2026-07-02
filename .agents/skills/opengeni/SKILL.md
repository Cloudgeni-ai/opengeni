---
name: opengeni
description: >-
  Use when working in, operating, extending, integrating, documenting, or debugging OpenGeni: the session-based agent service with an API, durable event log, Temporal worker, sandboxed OpenAI Agents SDK runtime, file/object storage, MCP tools, scheduled tasks, and self-hosted local stack. Trigger this skill for questions about OpenGeni architecture, client-side API integration, sessions/events, worker orchestration, sandbox backends, file uploads, tools/MCP, scheduling, storage, GitHub integration, configuration, deployment, or how to keep agents using OpenGeni correctly as the repo evolves.
---

# OpenGeni

## Overview

Use this skill as an orientation layer, not as frozen API documentation. OpenGeni evolves through the codebase, so code wins over this skill whenever they differ.

OpenGeni is a workspace-scoped agent control plane. Public clients talk to an API. The API resolves every protected request to an access grant, persists sessions and events, accepts user/control events, exposes replay/SSE streams, handles uploads, and talks to Temporal. A worker runs OpenAI Agents SDK turns inside a configured sandbox backend. Postgres is durable state, NATS is live fanout, object storage holds uploaded file bytes, Temporal coordinates work and schedules, and MCP servers provide pluggable tools.

Canonical source repo: `https://github.com/Cloudgeni-ai/opengeni`. This skill may be installed outside that repo, which is normal. If the current workspace is not OpenGeni, first determine whether the user wants client integration against a deployed OpenGeni service, source-level changes, deployment help, or conceptual explanation. For source-level exactness, inspect or fetch the repo; for client integration, ask for or infer the deployed API base URL and inspect the running API/client config where possible.

## Start With Repository Discovery

Always inspect the current repo before making claims or changes. Use fast searches and prefer contracts/types/routes over README prose when exact behavior matters.

Useful first pass:

```bash
rg --files -g '!*node_modules*' -g '!*.lockb'
rg -n "app\\.(get|post|patch|delete|all)\\(|/v1/|SessionEvent|ResourceRef|ToolRef|SandboxBackend|workflow|activity|OPENGENI_|mcp|schedule|upload|objectStorage|NATS|Temporal" \
  -g '!*node_modules*' -g '!*.lockb'
```

Then open the smallest source files that answer the question:

- API routes: `apps/api/src/routes/`, plus `apps/api/src/app.ts` and `apps/api/src/index.ts`.
- Core domain/access/billing helpers: `packages/core/src/` (`access/`, `domain/`, `billing/`, and `dependencies.ts`). These moved out of `apps/api`; API routes are HTTP adapters over `@opengeni/core`.
- Public shapes: `packages/contracts/src/index.ts`, especially workspace, access, billing, usage, session, file, document, schedule, and MCP contracts.
- Config/env: `packages/config/src/index.ts`, `.env.example`, `README.md`, `AGENTS.md`.
- Run lifecycle / goals / memory: `docs/run-lifecycle.md`, `docs/goals.md`, plus `apps/worker/src/workflows/session.ts` and `apps/worker/src/activities/agent-turn.ts`.
- Feature subsystems: `docs/environments.md` (workspace secrets), `docs/packs.md` and `docs/capabilities.md` (capability packs / MCP catalog).
- Database/state: `packages/db/src/schema.ts`, `packages/db/src/index.ts`, `packages/db/drizzle/`.
- Event bus/SSE: `packages/events/src/index.ts`, `apps/api/src/http/sse.ts`.
- Worker/orchestration: `apps/worker/src/workflows/`, `apps/worker/src/activities/`.
- Runtime/sandbox/tools: `packages/runtime/src/index.ts`.
- Files/object storage: `apps/api/src/routes/files.ts`, `packages/storage/src/index.ts`.
- Deployment/operator sources: `packages/deployment`, `docs/deployment.md`, `deploy/helm/opengeni`, `deploy/terraform/`, and `deploy/stacks/`.
- Documents/retrieval: `apps/api/src/routes/documents.ts`, `packages/documents/src/index.ts`, `apps/api/src/mcp/`.
- GitHub integration: `apps/api/src/routes/github.ts`, `packages/github/src/index.ts`.
- Connected Machine (bring-your-own-compute / the `selfhosted` backend): API routes `apps/api/src/routes/machines.ts` and `apps/api/src/routes/enrollments.ts`; services `apps/api/src/sandbox/machines.ts` and `apps/api/src/sandbox/enrollment.ts`; the machine-primary turn branch in `apps/worker/src/activities/agent-turn.ts` and the clone-guard in `packages/runtime/src/index.ts`; the runtime session at `packages/runtime/src/sandbox/selfhosted/`; the on-machine agent + relay in the `agent/` Rust crate; design docs under `docs/design/connected-machines/`; opt-in UI at the `@opengeni/react/machines` subpath.
- Web usage examples: `apps/web/src/api.ts`, `apps/web/src/types.ts`, relevant UI components.
- TypeScript SDK: `packages/sdk/src/` (typed client, SSE streaming core with reconnect/replay-by-sequence, proxy re-streaming helpers) and `packages/sdk/README.md`.
- React hooks + styled components: `packages/react/src/` (hooks on the SDK, timeline projection, ChatComposer/MessageTimeline/SessionStatus/FleetTile, CSS-variable design tokens in `packages/react/styles/`) and `packages/react/README.md`; runnable harness under `packages/react/demo/`.

If paths have moved, find concepts by symbol name, not by old paths:

```bash
rg -n "CreateSessionRequest|ClientSessionEvent|sessionWorkflow|runAgentTurn|createSandboxClient|buildManifest|createObjectStorage|build.*McpServer|getSettings"
```

## Client Integration

For external clients, SaaS integrations, SDK wrappers, customer-side coding agents, or UIs on top of OpenGeni, prefer the separate `opengeni-client` skill when available. For TypeScript clients, `@opengeni/sdk` (`packages/sdk`) is the first-party client: typed session/event API, the SSE streaming core (reconnect + replay-by-sequence + dedup), and proxy-through-your-own-API re-streaming helpers. When staying inside this source-level skill, read `references/client-integration.md`. Treat OpenGeni as a service boundary: the client discovers or chooses a workspace, creates sessions under `/v1/workspaces/:workspaceId/...`, streams/replays events, sends follow-up/control events, uploads files, selects resources/tools, and displays approvals/status. Do not require the client to know worker, Temporal, NATS, or sandbox internals except as concepts for status and product behavior.

## Access, Workspaces, Billing

Keep these boundaries explicit:

- Workspace scoping is core. Durable operational resources live under a workspace and public operational routes must use `/v1/workspaces/:workspaceId/...`.
- Old unscoped operational routes are deleted, not soft-deprecated. Do not add compatibility aliases unless the user explicitly changes that product decision.
- Better Auth is only the managed-mode browser human auth resolver. It is not the tenant model and should not appear in core session/file/document/schedule route code.
- OpenGeni product API keys are owned by OpenGeni and use `Authorization: Bearer`. The optional deployment shared key uses `x-opengeni-access-key`.
- Billing, Stripe, prepaid credits, entitlements, usage, and limits belong in billing/access modules. Core route/domain code should check local providers/interfaces, not call Stripe directly.
- Product access mode (`local`, `configured`, `managed`) is separate from deployment/infrastructure profile (`azure-managed`, existing services, local Kubernetes, previews, and so on).
- RLS is defense-in-depth. Do not claim RLS-backed isolation from app-level checks alone; verify policies with a non-owner DB role and current workspace/account settings.

## Mental Model

Keep these concepts straight while working:

- **Account**: managed billing/ownership container for members, workspaces, credits, and billing mirrors.
- **Workspace**: operational data boundary for sessions, events, files, documents, schedules, GitHub installations, usage, and first-party MCP.
- **Access grant**: resolved subject plus permissions for one workspace. Route code should depend on grants and permissions, not on the caller's auth mechanism.
- **Session**: durable user-facing work container. It owns status, resources, selected tools, model/sandbox settings, event cursor, and active turn.
- **Turn**: one queued/running unit of agent work inside a session, run as one non-retryable Temporal activity (`runAgentTurn`). Follow-ups, goal continuations, and scheduled task firings become turns. Inside a turn the SDK makes as many model/tool calls as the work needs; run length is bounded by symptoms (no-progress, budget), not by counts or clocks. A graceful worker shutdown preempts an in-flight turn (checkpoint, requeue, resume on a healthy worker) instead of failing the session. See `docs/run-lifecycle.md`.
- **Goal**: optional durable per-session objective that flips "stop" into an explicit act — while active, the session workflow synthesizes continuation turns until the agent calls `goal_complete`/`goal_pause` or a user interrupts. The mechanism behind long-running autonomous runs. See `docs/goals.md`.
- **Session memory (three stores, three jobs)**: `session_history_items` is the conversation truth fed to the model (default read path); `agent_run_states` is the serialized RunState blob, used only to resume a turn paused for a human approval; `session_events` is the redacted/lossy human-audit timeline and is never fed back to the model. Sandbox recovery state lives separately in `sandbox_session_envelopes`. See `docs/run-lifecycle.md`.
- **Workspace environment**: named per-workspace set of secret env vars, attached to a session/scheduled-task/pack and injected into the sandbox at run time; values are write-only. See `docs/environments.md`.
- **Event log**: append-only session timeline with per-session sequence numbers. It supports replay, SSE reconnect, UI timeline projection, and auditing.
- **SSE/NATS split**: Postgres is replay/source of truth. NATS is live fanout. If live events are missed, API should backfill from Postgres by sequence.
- **Temporal**: orchestration, signals, timers, schedules, and worker dispatch. Token streams/tool output should not be pushed through workflow history unless the code intentionally changes that design.
- **Worker activity**: side-effect boundary where the OpenAI Agents SDK actually runs. Treat model/tool/sandbox/cloud calls as side-effectful.
- **Sandbox**: pluggable execution environment behind the OpenAI Agents SDK sandbox interface. OpenGeni should describe the contract and selected backend, not pretend the backend is hard-coded. The shipped `SandboxBackend` enum is broad (currently eleven members), so never claim it is only Docker/Modal/local/none.
- **Connected Machine**: a user's own machine (enrolled through the `agent/` Rust agent) that acts as a first-class *primary* compute target, co-equal with the managed cloud sandbox — a sibling compute target, not a backend overlay bolted onto Modal. Its enum value is `selfhosted`. A machine-targeted turn establishes a `SelfhostedSession` directly and does NOT create, lease, or bill a cloud (Modal) box; the platform mints no GitHub token for it and never clones repos onto it (the machine uses its own git auth and already owns its filesystem). Runs execute at a per-session `workingDir` (default = the agent's launch dir), not a fixed `/workspace`. The whole feature is gated by `OPENGENI_SANDBOX_SELFHOSTED_ENABLED` (default off). See `docs/design/connected-machines/` and `references/sandbox-configuration.md`.
- **Resources**: external context mounted or made available to a run, commonly repositories and uploaded files.
- **Tools**: currently MCP-first. Tool refs select configured MCP servers. Built-ins are defaults, not limits.
- **Object storage**: stores uploaded bytes. Database stores metadata/object keys. Sandbox file access is normally via manifest/mount/injection based on current runtime code.
- **Scheduled task**: persisted schedule plus agent config that dispatches one or more session turns through Temporal scheduling.

## Source Discovery Workflow

For architecture, documentation, implementation, debugging, or operational work, create a current picture from code:

1. Read `AGENTS.md` and `README.md` for operator intent and warnings.
2. Read contracts for names and public shapes.
3. Read API routes for current endpoints and behavior.
4. Read DB schema and event append/list code for durable state and ordering.
5. Read worker workflows/activities for orchestration and side effects.
6. Read runtime code for Agents SDK, sandbox, MCP, manifests, resume, and model provider behavior.
7. Read config parsing for environment variables and pluggability.
8. Mark every claim as shipped, configurable, delegated to a backend/provider, or roadmap/not shipped.
9. For workspace/auth/billing changes, run or inspect `scripts/check-workspace-billing-static.ts` and the workspace isolation integration test so old route/provider-boundary drift is caught.

Do not rely on this skill for exact route lists, env var lists, event types, model names, or backend names. Re-discover those from contracts/config/routes every time exactness matters.

## Code Change Workflow

Before editing, identify which layer owns the behavior:

- Public API or validation: routes, core domain helpers, contracts, tests.
- Persistence: DB schema, migrations, mapping functions, integration tests.
- Event semantics: append helpers, event bus, SSE replay, frontend timeline handling.
- Orchestration: Temporal workflow/signal/activity code and workflow tests.
- Agent runtime: runtime package, worker activity, OpenAI Agents SDK integration tests.
- Sandbox resources: resource validation, manifest building, object storage, sandbox environment.
- MCP tools: config parsing, runtime tool preparation, API MCP servers.
- Scheduling: scheduled task contracts/routes/core domain helpers, Temporal schedule mapping, dispatch activity.
- UI: `apps/web` API helpers/types/components.

After edits, run the smallest relevant verification first, then broader checks if behavior crosses boundaries. Common checks are:

```bash
bun run typecheck
bun test
bun run test:integration
bun scripts/check-workspace-billing-static.ts
```

Use the full local stack only when the task requires real Temporal/NATS/Postgres/sandbox behavior:

```bash
bun run dev
```

For infrastructure and deployment work, read `references/deployment-infrastructure.md`, `packages/deployment`, `docs/deployment.md`, `deploy/helm/opengeni`, `deploy/terraform/`, and `deploy/stacks/`. Run or inspect `bun run deployment:stack -- --profile <profile>` before making exact deployment claims. Keep public docs focused on reusable operator behavior, not private verification history or cloud-account-specific records.

Do not claim a deployment is operational from static validation, rendered artifacts, deterministic smoke responses, or a sandbox-disabled profile alone. Real deployment confidence requires the selected profile's live dependencies, model provider, sandbox backend, object storage, auth boundary, and conformance checks to match the behavior being claimed.

For production Kubernetes, use official upstream charts/operators or managed services for platform dependencies. OpenGeni's chart should own OpenGeni workloads and integration resources; built-in Postgres, Temporal, NATS, or MinIO templates are disposable conformance fixtures only and must not be described as the production path.

## File Upload And Sandbox Discovery

When working on file flows, trace the full path end to end:

1. Upload creation route and contract.
2. Object storage key, presigned PUT/GET, TTLs, size/checksum validation.
3. File metadata rows and statuses.
4. Resource validation when attaching a file to a session or scheduled task.
5. Runtime manifest/mount/injection code.
6. User-facing prompt text that tells the agent where files are available.
7. Any result/artifact flow, if present in current code.

Do not claim a generic artifact system, write-back path, or live mid-session remount behavior unless current code proves it.

## Sandbox Backend Discovery

For sandbox pluggability or adding a backend:

1. Find the current `SandboxBackend` contract.
2. Find config for backend-specific settings.
3. Find the runtime function that constructs the sandbox client.
4. Find manifest/resource construction.
5. Find resume/session-state handling.
6. Find environment/secret injection and any sandbox lifecycle hook logic.
7. Check tests for backend expectations.

Describe the backend contract in terms of the OpenAI Agents SDK sandbox client/session capabilities used by OpenGeni. Add a new backend by extending contracts/config, wiring a compatible SDK sandbox client, supporting manifests/resources/resume as needed, and adding tests.

For sandbox configuration work, read `references/sandbox-configuration.md`. Use it when configuring any sandbox backend (Docker, Modal, local, none, the cloud backends, or a Connected Machine / `selfhosted`), deciding which environment variables enter the sandbox, debugging resource mounts, explaining sandbox preparation profiles and lifecycle hooks, adding a sandbox backend, or checking what claims are safe for docs/marketing.

## Tools And MCP Discovery

For tools and MCP work, distinguish:

- MCP tool providers selected by session/turn/scheduled-task config.
- First-party MCP servers exposed by the API.
- Built-in SDK sandbox capabilities such as shell/files/skills.
- Tools available inside the sandbox image, such as CLIs.

Find current MCP behavior in config parsing, tool validation, runtime `prepareTools`, and API MCP server builders. Treat first-party document/file/scheduled-task tools as swappable defaults. If a user wants enterprise search, repo tools, web tools, or custom systems, point OpenGeni at a different MCP server if current config supports it.

## Scheduling Discovery

For queueing or scheduling work:

1. Inspect turn queue state and claim logic.
2. Inspect Temporal schedules and overlap policy mapping.
3. Inspect scheduled task run records and dispatch behavior.
4. Inspect REST and MCP surfaces.
5. Check whether retries, dead letters, quotas, or backpressure are implemented before claiming them.

Prefer precise language: "DB-backed per-session queued turns" is different from "global queue service"; "Temporal schedule overlap policy" is different from "complete scheduling platform."

## Safe Claims

Use careful wording:

- "OpenGeni is self-hostable" if the repo still includes local/deployable API, worker, DB, NATS, Temporal, and object storage config.
- "Session-based public API" if routes/contracts still expose sessions/events/turns.
- "Durable replayable event log" if session events are still stored and replayed by sequence.
- "Temporal coordinates work" if workflows/activities remain present.
- "Agents SDK runs in worker activities" if runtime calls remain in worker activity code.
- "Sandbox backend is pluggable" if backend selection and SDK client wiring remain configurable.
- "MCP tools are pluggable" if MCP server config and tool refs remain.

Avoid absolute claims until verified in current code:

- Auth, tenancy, RBAC, API keys, billing, and RLS unless verified in current code and tests.
- Webhooks and outbound event delivery.
- Exactly-once public API idempotency.
- Dead-letter queues or automatic retries.
- Network policy/egress controls.
- Artifact storage/write-back.
- Any specific cloud/deployment target beyond configured dependencies.
- Any exact model/backend/tool list.

## Keeping This Skill Current

Update this skill in the same change whenever the repo changes any of these:

- Core architecture: API/worker/runtime/storage/event-bus boundaries.
- Terminology: session, turn, goal, event, resource, tool, schedule, sandbox, activity, workspace environment.
- Run lifecycle: the goal continuation loop, the no-run-length-limits principle, and the three-store session memory model (history items / run-state blob / event log).
- Public workflow: how to create sessions, stream events, upload files, attach resources, approve/interrupt, schedule tasks.
- Pluggability model: sandbox backend contract, MCP tool config, model provider config, object storage, GitHub integration.
- Compute targeting: the Connected Machine (`selfhosted`) primary-compute model, the machines/enrollment routes, per-session `workingDir`, and the `targetSandboxId` create field.
- Source layout: if important files move or names change.
- Important "do not claim" guardrails.

Keep the skill stable and discovery-oriented. Do not copy long API references, full env lists, or large technical briefs into `SKILL.md`; instruct future agents how to find current details in code. If exact details become too large but repeatedly useful, add a focused `references/` file and link it from this skill.
