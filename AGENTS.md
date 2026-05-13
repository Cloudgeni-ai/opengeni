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

MinIO is the local S3-compatible object storage default for Docker Compose and optional self-contained Kubernetes smoke tests. Production Azure deployments should use `OPENGENI_OBJECT_STORAGE_BACKEND=azure-blob` with Azure Blob credentials instead of deploying MinIO manually.

## Architecture Notes

- Public clients talk only to the API.
- Browser streaming uses `GET /v1/sessions/:id/events/stream` with SSE.
- Core NATS is the realtime bus between producers and API instances.
- Postgres is the durable event store and replay source.
- Temporal is orchestration only. Token streams do not go through workflow history.
- OpenAI Agents SDK execution happens inside non-retryable worker activities.
- Agent activities are side-effectful. Do not add automatic Temporal retries around full agent segments unless each model/tool/sandbox boundary has been made idempotent.

## Sandbox Notes

The Docker sandbox image includes Terraform, Checkov, Azure CLI, GitHub CLI, git, jq, curl, and base shell utilities. Bundled Terraform/checkov skills live under `packages/runtime/src/bundled_hashicorp_terraform_skills` and are mounted into the sandbox under `.agents/`.

When the `azure` sandbox preparation profile is enabled and ARM/AZURE service-principal variables are allowed into the sandbox, the worker pre-authenticates normal Azure CLI inside the sandbox with `az login --service-principal` before the agent starts. There is no custom `opengeni-azure-login` helper.

Sandbox preparation is controlled by:

- `OPENGENI_SANDBOX_PREPARATION_PROFILES=none`, `azure`, `github`, or comma-separated profile names
- `OPENGENI_SANDBOX_ENV_ALLOWLIST=...` for extra explicit host env vars

Explicit `OPENGENI_GIT_*` settings can set sandbox git author/committer identity. Ambient host `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables only pass through when the `github` preparation profile or env allowlist permits them.

Do not expect model provider credentials to automatically appear in the sandbox unless explicitly allowed.

The API and sandbox file-resource object-storage boundary supports `s3-compatible` and `azure-blob`. Azure Blob-backed deployments use native Azure Blob manifest mounts for attached files.

## Verification

Unit tests and typechecks do not require Temporal, NATS, Postgres, a sandbox backend, or live model credentials:

```bash
bun run typecheck
bun test
```

End-to-end agent runs require the full stack plus valid model and sandbox credentials.

## Deployment Work Notes

When working on production deployment, Azure deployment, Helm, Terraform, conformance checks, or cloud-provider-agnostic infrastructure, read and keep `docs/infra-deployment-goal.md` current. Treat it as the source of truth for the active infrastructure end goal.

Track every Azure resource created for deployment verification in `docs/azure-resource-ledger.md` before or immediately after creation. Do not commit Azure secrets, kubeconfigs, Terraform state, local tfvars, generated credentials, or private endpoints that are not intentionally documented examples.
