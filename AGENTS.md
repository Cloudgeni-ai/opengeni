# Agent / automation notes (Infra Agents)

This repository is a clean TypeScript/Bun stack. The public API is session-based.

When the user says **"start the dev server"**, **"spin it up"**, or **"run the full stack"**, they mean the steps under **Full local stack**.

## Full Local Stack

The stack means everything needed to run the Hono API, React web app, Temporal worker, Postgres event store, Core NATS realtime bus, Temporal service, and configured OpenAI Agents SDK sandbox backend.

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
   docker build -f docker/sandbox.Dockerfile -t infra-agents-sandbox:local .
   ```

4. Copy `.env.example` to `.env` and configure at least:

   - `INFRA_AGENT_DATABASE_URL`
   - `INFRA_AGENT_NATS_URL`
   - `INFRA_AGENT_TEMPORAL_HOST`
   - OpenAI or Azure OpenAI credentials
   - `INFRA_AGENT_SANDBOX_BACKEND=docker` or `modal`
   - sandbox credential pass-through profiles/extra vars when needed

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

When ARM/AZURE service-principal variables are passed through, the worker pre-authenticates normal Azure CLI inside the sandbox with `az login --service-principal` before the agent starts. There is no custom `infra-agent-azure-login` helper.

Sandbox credential pass-through is controlled by:

- `INFRA_AGENT_SANDBOX_ENV_PROFILES=azure,github`
- `INFRA_AGENT_SANDBOX_ENV_EXTRA_VARS=...`
- `INFRA_AGENT_SANDBOX_ENV_VARS=...` for explicit override

Do not expect model provider credentials to automatically appear in the sandbox unless explicitly allowed.

## Verification

Unit tests and typechecks do not require Temporal, NATS, Postgres, a sandbox backend, or live model credentials:

```bash
bun run typecheck
bun test
```

End-to-end agent runs require the full stack plus valid model and sandbox credentials.
