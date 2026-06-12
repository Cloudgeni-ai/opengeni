# Agent / automation notes (OpenGeni)

This repository is a clean TypeScript/Bun stack. The public API is session-based.

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
   - `OPENGENI_SANDBOX_BACKEND=docker` or `modal`
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

`bun run dev` may auto-select alternate Docker Compose host ports when defaults are already in use; it wires those selected ports into the API and worker environment for that run.

MinIO is the local S3-compatible object storage default for Docker Compose and optional self-contained Kubernetes smoke tests. Production deployments should use provider-native storage instead of deploying MinIO manually: `azure-blob` for Azure Blob, `aws-s3` for AWS S3, and `gcs` for Google Cloud Storage.

## Architecture Notes

- Public clients talk only to the API.
- Browser streaming uses `GET /v1/workspaces/:workspaceId/sessions/:id/events/stream` with SSE.
- Core NATS is the realtime bus between producers and API instances.
- Postgres is the durable event store and replay source.
- Temporal is orchestration only. Token streams do not go through workflow history.
- OpenAI Agents SDK execution happens inside non-retryable worker activities.
- Agent activities are side-effectful. Do not add automatic Temporal retries around full agent turns unless each model/tool/sandbox boundary has been made idempotent.

## Run Lifecycle (read `docs/run-lifecycle.md` before changing the session workflow, the agent turn activity, or memory)

Three principles here are load-bearing and easy to break by accident:

- **No run-length limits, by design.** OpenGeni runs agents that legitimately work for days. Run length is bounded by symptoms (no-progress detection, budget exhaustion), never by counts or clocks. Do not add or lower caps on model calls per turn, continuation count, or activity timeout as a way to "be safe" — fix the pathology instead. See `docs/run-lifecycle.md` and `docs/goals.md`.
- **Three memory stores, three jobs.** `session_history_items` is conversation truth fed to the model (default read path). `agent_run_states` is the serialized RunState blob, used *only* to resume a turn paused for a human approval — never as conversation memory. `session_events` is the redacted, lossy human/audit timeline and must never be fed back to the model. Sandbox recovery state is separate again in `sandbox_session_envelopes`.
- **Goals drive long runs.** An active goal turns "stop" into an explicit act; the continuation loop is replay-safe and lives in the session workflow. See `docs/goals.md`.
- **Worker restarts are survivable, hard kills are not retried.** A graceful shutdown (SIGTERM) preempts the in-flight turn: checkpoint, requeue, `preempted` activity result, re-dispatch on a healthy worker via a `turn.preempted` resume notice. Do not replace this with automatic Temporal retries of agent turns. See `docs/run-lifecycle.md`.

The agent turn activity is `runAgentTurn`, also registered under the legacy alias `runAgentSegment` for in-flight workflow histories — schedule `runAgentTurn` in new code.

## Keeping these notes current

If a change alters architecture, terminology, the run lifecycle, the memory model, or a "do not" guardrail above, update this file and the relevant `docs/*.md` in the same change. An out-of-date AGENTS.md or doc is a bug, not a nicety.

## Sandbox Notes

The Docker sandbox image includes Terraform, Checkov, Azure CLI, GitHub CLI, git, jq, curl, and base shell utilities. Bundled Terraform/checkov skills live under `packages/runtime/src/bundled_hashicorp_terraform_skills` and are mounted into the sandbox under `.agents/`.

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

When working on production deployment, Azure/AWS/GCP deployment, Helm, Terraform, conformance checks, preview environments, observability, or cloud-provider-agnostic infrastructure, treat the source as authoritative: deployment contracts in `packages/deployment`, the Helm chart under `deploy/helm/opengeni`, Terraform roots under `deploy/terraform`, stack wrappers under `deploy/stacks`, and operator docs in `docs/deployment.md`.

Keep provider resource inventories, cleanup notes, cloud account identifiers, private endpoints, generated credentials, kubeconfigs, Terraform state, plans, local tfvars, service-account keys, and access keys in private operator-controlled storage outside the repository.

Use official upstream charts/operators or managed services for production platform services. OpenGeni's chart should own OpenGeni API, web, worker, migrations, and integration resources. Built-in Postgres, Temporal, NATS, and MinIO templates are disposable conformance fixtures for local, CI, and smoke verification only; do not present them as lightweight production alternatives.
