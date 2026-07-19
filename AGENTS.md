# Agent / automation notes (OpenGeni)

This repository is a clean TypeScript/Bun stack. The public API is session-based.

> **Start here for orientation: [`docs/architecture.md`](docs/architecture.md).** It is the canonical whole-system map — what OpenGeni is, the load-bearing invariants, the full repo layout, per-component deep-dives, and a *"if you're changing X, read Y first"* decision table. Read it before navigating an unfamiliar area, and **keep it current**: if your change adds/removes/renames an app, package, or sandbox backend; alters an architectural invariant, the data-flow, or the session/turn lifecycle; or changes which file is canonical for a change area — update `docs/architecture.md` in the *same* change. A stale map is a bug. (This file, AGENTS.md, owns *how to run and operate* the stack; architecture.md owns *how the system is shaped*.)

When the user says **"start the dev server"**, **"spin it up"**, or **"run the full stack"**, they mean the steps under **Full local stack**.

## Full Local Stack

The stack means everything needed to run the Hono API, React web app, Temporal worker, Postgres event store, Core NATS realtime bus, Temporal service, and configured OpenAI Agents SDK sandbox backend.

1. Start the full local stack:

   ```bash
   bun run dev
   ```

   This installs dependencies, starts the Docker infrastructure, runs migrations, builds the local sandbox image, and starts API, worker, and web processes.

Manual equivalent:

1. Install dependencies:

   ```bash
   bun install
   ```

2. Start infrastructure:

   ```bash
   docker compose up -d postgres nats temporal minio minio-init
   bun run db:migrate
   ```

3. Build the local sandbox image when using Docker sandbox:

   ```bash
   docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .
   ```

4. Copy `.env.example` to `.env` and configure at least:

   - `OPENGENI_DATABASE_URL`
   - `OPENGENI_NATS_URL`
   - `OPENGENI_TEMPORAL_HOST`
   - `OPENGENI_STARTUP_DEPENDENCY_RETRY_*` when dependencies need longer startup windows
   - OpenAI or Azure OpenAI credentials
   - `OPENGENI_SANDBOX_BACKEND` (see Sandbox Notes for the full backend list; `docker` is the default for local dev)
   - sandbox preparation profiles / env allowlist when needed

5. Start long-running processes in separate terminals:

   ```bash
   bun run dev:api
   bun run dev:worker
   bun run dev:web
   ```

Default URLs:

- API: `http://127.0.0.1:8000`
- API health: `http://127.0.0.1:8000/healthz`
- Web: `http://127.0.0.1:3000`
- NATS monitor: `http://127.0.0.1:8222`
- Temporal gRPC: `127.0.0.1:7233`

`bun run dev` may auto-select alternate Docker Compose host ports when defaults are already in use; it wires those selected ports into the API and worker variable set for that run.

MinIO is the local S3-compatible object storage default for Docker Compose and optional self-contained Kubernetes smoke tests. Production deployments should use provider-native storage instead of deploying MinIO manually: `azure-blob` for Azure Blob, `aws-s3` for AWS S3, and `gcs` for Google Cloud Storage.

## Architecture Notes

For a map of every app, package, and how the parts fit together, start at [`docs/architecture.md`](docs/architecture.md) and follow its links to the focused topic docs.

- Public clients talk only to the API.
- Domain/access/billing helpers now live in `@opengeni/core` under `packages/core/src`; `apps/api` routes are HTTP adapters over them.
- Browser streaming uses `GET /v1/workspaces/:workspaceId/sessions/:id/events/stream` with SSE.
- Session goals support `GET`, `PATCH(status paused|active)`, and idempotent `DELETE` clear on `/v1/workspaces/:workspaceId/sessions/:id/goal`; clearing removes the goal row and emits `goal.cleared`.
- Core NATS is the realtime bus between producers and API instances.
- Postgres is the durable event store and replay source.
- Temporal is orchestration only. Token streams do not go through workflow history.
- OpenAI Agents SDK execution happens inside non-retryable worker activities.
- Agent activities are side-effectful. Do not add automatic Temporal retries around full agent turns unless each model/tool/sandbox boundary has been made idempotent.

## Run Lifecycle (read `docs/run-lifecycle.md` before changing the session workflow, the agent turn activity, or memory)

Three principles here are load-bearing and easy to break by accident:

- **No run-length limits, by design.** OpenGeni runs agents that legitimately work for days. Run length is bounded by symptoms (no-progress detection, budget exhaustion), never by counts or clocks. Do not add or lower caps on model calls per turn, continuation count, or activity timeout as a way to "be safe" — fix the pathology instead. See `docs/run-lifecycle.md` and `docs/goals.md`.
- **Three memory stores, three jobs.** `session_history_items` is conversation truth fed to the model (default read path). `agent_run_states` is the serialized RunState blob, used *only* to resume a turn paused for a human approval — never as conversation memory. `session_events` is the redacted, lossy human/audit timeline and must never be fed back to the model. Sandbox recovery state is separate again in `sandbox_session_envelopes`. Workspace knowledge memory (`knowledge_memories`, human-reviewed: agents search approved records and propose via the docs MCP tools) is retrieval context, never conversation memory.
- **Goals drive long runs.** An active goal continues until it is completed or paused; the continuation loop is replay-safe and lives in the session workflow. See `docs/goals.md`.
- **Synthesized follow-up turns preserve the effective model policy.** Goal continuations inherit model + reasoning from the newest turn that durably emitted `turn.started`, falling back to the session default only when no turn has actually run. A claimed turn rejected during admission must not silently switch the next turn's provider or billing owner. Child terminal results always enter the bounded typed internal-update batch for their parent.
- **Context compaction is one durable, portable transition.** OpenGeni uses Codex's local plaintext checkpoint algorithm for every provider: the summarizer sees a protocol-valid temporary copy of active structured history plus the fixed checkpoint prompt; the replacement is built from the unmodified active history as the newest real user messages in one cumulative 20,000-token budget plus one summary. Before the provider call, aggregate oversized tool results are replaced oldest-first only in that temporary copy; if needed, whole oldest user-delimited units are removed and the suffix is re-sanitized. One provider overflow permits one smaller refit, never one provider request per item. Provider failure leaves active history unchanged. There is no deterministic summary, compatibility ladder, ordinary inference-time history trim, SDK `context_management`, or new queue turn. The exact current turn-attempt UUID fences both the replacement-history transaction and its token signal. A pending receipt whose complete pair was made inactive by compaction is consumed without reactivation or duplicate output; a still-active complete pair retains its recovery event because the crash may have occurred before the original event publish. This intentionally differs from Codex remote-v2: OpenGeni rotates sessions across independent subscription identities, so an opaque provider-encrypted compaction blob is not portable conversation memory. Codex subscription model limits are raw/effective/auto-compact 272,000/258,400/244,800.
- **Escaped MCP transport timeouts are recoverable without replay.** A connect/tools-list/next-loop MCP request timeout can escape after a successful tool output even though thrown tool-call failures are normally converted to `isError` outputs. The worker checkpoints conversation truth, truthfully settles that turn as retryable/idle, and lets an active goal continue after pacing; it never blindly replays the completed tool call or full turn.
- **All-exhausted Codex capacity is a durable wait, not a user-message recovery.** When no allocator-enabled subscription is available for an active goal, the worker atomically settles the blocked turn and persists one session waiter. The workflow waits on its authoritative reset timer or a revisioned capacity signal, reconstructs the wait after restart/continue-as-new, then enqueues at most one normal goal continuation after row-locked allocator re-evaluation. It never synthesizes a user message, polls with model turns, replays the failed full turn, or consumes a reset/boost entitlement. See [`docs/codex-subscription-rotation.md`](docs/codex-subscription-rotation.md).
- **Sandbox warming is bounded and tracked.** A provider instance id must be persisted on the warming lease immediately after create returns, before readiness/setup. A turn waiting on another worker's warming lease is bounded by `OPENGENI_SANDBOX_WARMING_TIMEOUT_MS` (default 600000) and fails clearly on backend capacity/create timeout instead of heartbeating forever.
- **Worker deaths recover the same logical turn, never by manufacturing queue work.** A graceful shutdown or ungraceful worker loss checkpoints the durable conversation truth and moves the exact turn to `recovering`; the workflow claims that same turn with a new attempt UUID and generation. It does not create a prompt, resume notice, or machine-generated queue row. A dying activity never performs a competing terminal settlement, and late callbacks remain visible as rejected evidence without becoming current truth. Do not add automatic Temporal retries around the side-effectful agent activity.
- **Every turn attempt is fenced; lifecycle settlement is atomic.** Before model/tool work, a claimed turn registers a first-class UUID attempt plus its execution generation and exact Temporal dispatch. The canonical lock order is workspace → session → exact turn. Events, conversation history, run state, context replacement, input-token signals, queue/control state, system-update bundles, turn state, session pointer, and sequence commit must all reject a replaced attempt. A rejected callback is retained as `turn.event.rejected_late` evidence. A normal Send appends a prompt but never mutates an unsettled Pause/Steer fence. Never restore append-then-CAS or a dying activity's independent cancellation write.

The agent turn implementation and Temporal activity identifier are both
`runAgentTurn`; session control uses the `sessionControl` signal. The production
cutover drains and terminates every old session workflow before the new worker
starts, so no removed activity/signal identifier or replay adapter belongs in
the new runtime.

## Keeping these notes current

If a change alters architecture, terminology, the run lifecycle, the memory model, or a "do not" guardrail above, update this file, [`docs/architecture.md`](docs/architecture.md), and the relevant `docs/*.md` in the same change. In particular, structural changes (an app/package/sandbox backend added, removed, or renamed; a moved responsibility; a changed invariant, data-flow, or canonical source) belong in `docs/architecture.md` — see its "Keeping this current" section. An out-of-date AGENTS.md or doc is a bug, not a nicety.

## Keeping docs true

Use [`docs/README.md`](docs/README.md) as the docs map. When you move or rename files or packages, run `bun run check:docs-refs` and fix every current-tier reference it reports. A new package needs a package README plus the [`docs/architecture.md`](docs/architecture.md) package table. A new embed surface or port belongs in [`docs/embedding.md`](docs/embedding.md). A new process or command belongs in its canonical home from the docs map; link to that home instead of restating volatile details.

## Sandbox Notes

Sandbox execution is pluggable. `OPENGENI_SANDBOX_BACKEND` selects one of the backends defined by the `SandboxBackend` enum in `packages/contracts/src/index.ts` (the canonical list): `docker`, `modal`, `local`, `none`, `daytona`, `runloop`, `e2b`, `blaxel`, `cloudflare`, `vercel`, and `selfhosted`. `docker` is the default and the usual local-dev choice; `modal` and the other cloud backends are provisioned, swappable boxes. When you change the set of backends, update the enum first and treat it as the source of truth — this file and the README follow it.

The Docker sandbox image includes Terraform, Checkov, Azure CLI, GitHub CLI, git, jq, curl, and base shell utilities. Managed sandboxes also provision git-provider CLI auth wrappers for `gh`, `glab`, and `az`; the wrappers read current provider token files at invocation time and pass through cleanly when a token file is absent. A token file is never authorization: resource-less/rematerialized boxes may recover only through a secret-free exact repository binding, and the worker generation-fences every final file write against revocation. Connected Machines bypass platform Git discovery, binding, minting, and token files entirely. Bundled Terraform/checkov skills live under `packages/runtime/src/bundled_hashicorp_terraform_skills` and are mounted into the sandbox under `.agents/`.

### Bring-your-own-compute — the Connected Machine (`selfhosted`)

A **Connected Machine** (the `selfhosted` backend) is a user's own always-on machine — a **first-class, co-equal PRIMARY compute target**, not merely a swappable sandbox. When a turn's *effective* backend is a machine, the agent runs on it **directly**; there is no provisioned box behind it. Use "Connected Machine" in product-facing prose and reserve "selfhosted" for the enum value / internal plumbing. Key invariants — do not break them:

- **Machine-primary, not a phantom box.** A machine-targeted turn establishes the `SelfhostedSession` **directly** (`establishSelfhostedTurnSession` in `apps/worker/src/activities/agent-turn.ts`, the `machinePrimary` branch) and leases the group as `selfhosted` — it does **not** call `resumeBoxForTurn`, so **no Modal/cloud box is created, leased, or billed** for that turn. Warm-seconds meter off the effective backend (`selfhosted` = 0 rate), never the session's home backend.
- **No platform Git credential crosses to the machine; it uses its own git auth.** The env mint skips platform git-provider tokens for a `selfhosted`-effective turn (`sandboxEnvironmentForRun({ skipGitHubToken })` in `apps/worker/src/activities/environment.ts`), and selfhosted `exec` puts platform Git `env: {}` on the wire — structurally those provider tokens never reach the machine. The machine authenticates git with its **own** credentials. When Toolspace is enabled, the separate intentional exception is one narrow `toolspace:call`, session/TTL-bound `ogd_` credential delivered off-manifest so tools can call the selected OpenGeni MCP surface.
- **Repos are never cloned onto a machine.** `repositoryUsesSandboxClone` (`packages/runtime/src/index.ts`) returns `false` for a `selfhosted` effective backend (the clone-guard) — the machine already owns its filesystem, so a platform `git clone` must never land on the user's real disk.
- **Per-session working directory, not a fixed `/workspace`.** A machine runs under `sessions.working_dir` (migration 0027); `toMachinePath` (`packages/runtime/src/sandbox/selfhosted/session.ts`) re-anchors the virtual `/workspace` frame onto the chosen host path (default = the agent's launch `workspace_root`). The "`/workspace` for every run" assumption holds only for provisioned boxes.
- **Targeting a machine at create time.** `CreateSessionRequest.targetSandboxId` (+ optional `workingDir`) selects the machine for a new session; the active-sandbox pointer is seeded at creation so the **first** turn routes there (race-free). `workingDir` without `targetSandboxId` is a **422**, and an invalid/unowned/offline target **422s** rather than silently falling back to the default box (`packages/core/src/domain/sessions.ts`).
- **Never cold-create or kill a user's machine.** An offline self-hosted agent is *not* a `NotFound`; the lease never provisions a rival box, and the reaper drains a self-hosted box to cold but never provider-stops it. The capability descriptor is `persistable: false` (no disk snapshot) and the box is never idle-reaped.
- **Control surface is NATS, not a provider API.** Exec/fs/git run over a `ControlRpc` request/reply seam addressed by `agent.<ws>.<id>.rpc`, encoded via `@opengeni/agent-proto` (the protobuf wire IDL codegen'd to both Rust and TS so the control plane and agent never drift). `negotiateCapabilities` surfaces online/offline/reconnecting/consent_required/display_unavailable states.
- **Control liveness is isolated from accepted host work.** The Rust supervisor answers `ping` and publishes heartbeats outside a bounded platform-work pool; a full pool returns typed, retryable `DRAINING` backpressure without marking the machine offline. A connection-generation end cancels its accepted work; native execs run in OS process groups/Job Objects so ordinary contained descendants cannot become invisible when their leader exits and the containment group/job is terminated on deadline or cancellation; and the control plane sends an agent exec deadline inside a slightly larger request/reply deadline. Do not move host operations back into the heartbeat/subscription loop or make reconnect forget in-flight admission.
- **Enrollment credentials rotate and revoke under one fence.** The 30-day `oge_` bearer is the recovery credential; NATS user JWTs and relay producer tokens last at most five minutes. The agent bearer-authenticates `POST /v1/enrollments/self/refresh` one minute before the earliest expiry, atomically persists the exact-identity/consent-validated result before publishing it in memory, and gives each connection an immutable credential snapshot. Refresh and revoke take the same enrollment-row lock, so neither can mint past a committed revoke. Live relay sockets disconnect at token expiry.
- **A revoked machine is history, never a target.** Revocation clears only session pointers that still name that enrollment and increments their active epoch. The enrollment remains visible to administrators as revoked history, but fleet discovery omits it and turn routing reports `offline_enrollment`; a missing/revoked machine home fails loudly and never provisions phantom cloud compute.
- **Native service cleanup is fail-closed.** Linux probes user and system systemd unit paths independently. macOS owns a per-user plist and uses exact `launchctl bootout gui/<uid> <plist>` / `bootstrap gui/<uid> <plist>` operations. Any ambiguous cleanup preserves the binary and credentials and blocks remote revoke, so a still-running KeepAlive service cannot race destructive uninstall.
- **Gated off by default.** The whole feature is behind `OPENGENI_SANDBOX_SELFHOSTED_ENABLED` (default OFF). When off, enrollment routes 404 and the backend is inert — boot is unaffected. Related config: the `OPENGENI_SELFHOSTED_NATS_*`, `OPENGENI_SELFHOSTED_RELAY_*`, and `OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET` env vars wire the control plane, callout account, and relay tier.
- **Machine UI is opt-in.** Connected-machine React components (machines dashboard, enrollment, status pills, metrics) live on the `@opengeni/react/machines` subpath, so the `@opengeni/react` root import stays a clean sandbox-only default; the root re-exports them deprecated for back-compat (#144).
- Sandbox/enrollment/metrics tables and the session `active_sandbox_id`/`active_epoch` pointer (migration 0024) make sandboxes swappable within a session. The pointer is **establishment-safe**: a swap/seed to a target no turn can establish is rejected before the epoch-fenced CAS with a typed `code`; a persisted-unestablishable pointer is reset to the session home at turn start under the fence with a visible `session.route.reconciled` event; and a `null` pointer always resolves to the session home (the Modal group box, or the machine for a machine-home session). See `docs/architecture.md` §3.9. Design dossier lives under `docs/design/sandbox-surfacing/`.

Enabled capability packs can scope the runtime per workspace: a registered pack manifest may declare `skills` (delivered into the same `.agents/` skill index as the bundled skills) and a `sandboxImage` that replaces the global `OPENGENI_DOCKER_IMAGE`/`OPENGENI_MODAL_IMAGE_REF` for that workspace's sessions. At most one enabled pack per workspace may declare an image — no image composition. See `docs/packs.md`.

When the `azure` sandbox preparation profile is enabled and ARM/AZURE service-principal variables are allowed into the sandbox, the worker pre-authenticates normal Azure CLI inside the sandbox with `az login --service-principal` before the agent starts. There is no custom `opengeni-azure-login` helper.

Sandbox preparation is controlled by:

- `OPENGENI_SANDBOX_PREPARATION_PROFILES=none`, `azure`, `github`, or comma-separated profile names
- `OPENGENI_SANDBOX_ENV_ALLOWLIST=...` for extra explicit host env vars

Explicit `OPENGENI_GIT_*` settings can set sandbox git author/committer identity. Ambient host `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables only pass through when the `github` preparation profile or env allowlist permits them.

Do not expect model provider credentials to automatically appear in the sandbox unless explicitly allowed.

The API and sandbox file-resource object-storage boundary supports `s3-compatible`, `azure-blob`, `aws-s3`, and `gcs`. Azure Blob-backed Docker/local sandboxes use native Azure Blob manifest mounts. Modal Azure Blob, AWS S3, and GCS file resources use short-lived signed download materialization.

## Verification

Unit tests and typechecks do not require Temporal, NATS, Postgres, a sandbox backend, or live model credentials:

```bash
bun run typecheck
bun test
```

End-to-end agent runs require the full stack plus valid model and sandbox credentials.

## Deployment Work Notes

When working on production deployment, Azure/AWS/GCP deployment, Helm, Terraform, conformance checks, preview variable-sets, observability, or cloud-provider-agnostic infrastructure, treat the source as authoritative: deployment contracts in `packages/deployment`, the Helm chart under `deploy/helm/opengeni`, Terraform roots under `deploy/terraform`, stack wrappers under `deploy/stacks`, and operator docs in `docs/deployment.md`.

Every new SQL migration must declare its reviewed production path on the first lines: `-- deployment-mode: rolling` for online-compatible expand-and-contract work, or `-- deployment-mode: maintenance` for an incompatible one-way cutover. The protected production gate hashes the ordered SQL history and rejects rewrites or unclassified additions.

Keep provider resource inventories, cleanup notes, cloud account identifiers, private endpoints, generated credentials, kubeconfigs, Terraform state, plans, local tfvars, service-account keys, and access keys in private operator-controlled storage outside the repository.

Use official upstream charts/operators or managed services for production platform services. OpenGeni's chart should own OpenGeni API, web, worker, migrations, and integration resources. Built-in Postgres, Temporal, NATS, and MinIO templates are disposable conformance fixtures for local, CI, and smoke verification only; do not present them as lightweight production alternatives.
