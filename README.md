# OpenGeni

OpenGeni is a self-hostable managed agent service for long-running workspace and infrastructure work.

It provides a session-based API for creating, steering, observing, interrupting, and replaying agent runs. The included React app is one client for that API; other products can call the same API directly and let OpenGeni own durable session state, event history, approvals, and final outputs.

## What It Does

- Runs OpenAI Agents SDK agents behind a durable API.
- Streams live session events over SSE while storing the replayable event log in Postgres.
- Coordinates long-running work with Temporal signals for follow-ups, approvals, and interrupts.
- Executes agent tools in sandbox backends such as Docker, Modal, local, or none.
- Attaches repositories, uploaded files, and document-search tools to sessions.
- Uses a GitHub App integration for scoped repository access.
- Supports document upload, indexing, retry, and semantic search with pgvector.

## Project Status

This repository is early, but it now includes the baseline files expected for public collaboration:

- Apache-2.0 license.
- Contribution guide.
- Security reporting guide.
- Code of conduct.
- Issue templates.
- Pull request template.
- CI for typechecks and unit tests.

## Public Preview / Security Boundary

OpenGeni's core API is workspace-scoped. Canonical protected routes include the workspace id in the URL, and every request resolves to an internal access grant before route code touches workspace-owned data.

There are three product access modes:

- `local`: local development bootstrap account/workspace, subject `dev`, broad permissions.
- `configured`: self-hosted or embedded deployments using configured deployment keys or delegated bearer tokens from a parent product.
- `managed`: OpenGeni owns email/password sign-up through Better Auth, workspaces, OpenGeni API keys, prepaid Stripe credits, usage, and limits.

The optional deployment shared-key boundary is still available for infra smoke tests and simple self-hosting. It uses `x-opengeni-access-key`, not `Authorization`. Product API keys and delegated tokens use `Authorization: Bearer ...`.

Do not expose a production deployment without a deliberate access mode, RLS-tested database role posture, rate limits, real model/sandbox credentials, and reviewed sandbox preparation policy. Sandbox preparation profiles and env allowlists can make host credentials available to agent sandboxes, so review `.env` before running live sessions.

## Architecture

Public clients talk only to the Hono API. The API validates requests, creates sessions, accepts user messages and control events, exposes durable history, and streams live events.

```mermaid
flowchart LR
  Web["React web client"]
  Service["External service"]
  Webhook["Webhook caller"]
  CustomUI["Custom UI or SDK"]

  subgraph Managed["Managed agent service"]
    API["Hono API<br/>public contract"]
    DB["Postgres<br/>sessions, events, history items, run state"]
    Temporal["Temporal<br/>orchestration and signals"]
    Worker["Worker<br/>OpenAI Agents SDK harness"]
    NATS["NATS Core<br/>live fanout"]
    Sandbox["Sandbox backend<br/>Docker, Modal, local, none"]
  end

  Web --> API
  Service --> API
  Webhook --> API
  CustomUI --> API
  API <--> DB
  API --> Temporal
  API <--> NATS
  Temporal --> Worker
  Worker <--> DB
  Worker --> NATS
  Worker <--> Sandbox
```

Postgres is the durable source of truth. NATS is only the realtime fanout bus. If an API instance or SSE client misses live events, the API backfills from Postgres by event sequence.

Temporal coordinates the work, but token streams and tool output do not go through workflow history. Agent execution runs inside non-retryable activities because model calls, sandbox commands, GitHub operations, and cloud-provider actions are side-effectful.

## Stack

- Bun workspace
- Hono API
- React and Vite web app
- Temporal worker
- Postgres with Drizzle and pgvector
- NATS Core realtime bus
- MinIO for local S3-compatible file storage and Azure Blob, AWS S3, or GCS for production object storage
- OpenAI Agents SDK
- Docker and Modal sandbox backends

## Agent Guides

Pair this README with the [CloudGeni Infrastructure Agents Guide](https://github.com/Cloudgeni-ai/infrastructure-agents-guide) for architecture patterns and operating guidance around infrastructure-focused agents, including repositories, sandbox tools, Terraform/Checkov skills, GitHub App access, and cloud credentials.

The capability catalog lets operators see and enable packs, MCP tools, APIs, skills, and plugins for the same runtime. See [docs/capabilities.md](docs/capabilities.md) for the unified catalog and [docs/packs.md](docs/packs.md) for the marketing social daily analysis pack.

## Quick Start

Prerequisites:

- Bun
- Docker
- OpenAI or Azure OpenAI credentials for real model runs

Start the full local stack:

```bash
bun run dev
```

`bun run dev` installs dependencies, creates `.env` from `.env.example` when missing, starts Docker infrastructure, runs migrations, builds the local sandbox image, and starts the API, worker, and web app.

Open:

- Web app: `http://127.0.0.1:3000`
- API health: `http://127.0.0.1:8000/healthz`
- NATS monitor: `http://127.0.0.1:8222`
- MinIO console: `http://127.0.0.1:9001`
- Temporal gRPC: `127.0.0.1:7233`

If you run Temporal with the local dev server instead of Docker Compose, the Temporal UI is commonly available at `http://127.0.0.1:8233`.

## Manual Startup

Use this when you want separate terminals for each long-running process:

```bash
bun install
docker compose up -d postgres nats temporal minio minio-init
bun run db:migrate
docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .
bun run dev:api
bun run dev:worker
bun run dev:web
```

## Configuration

Copy `.env.example` to `.env` and configure at least:

- `OPENGENI_DATABASE_URL`
- `OPENGENI_NATS_URL`
- `OPENGENI_TEMPORAL_HOST`
- `OPENGENI_STARTUP_DEPENDENCY_RETRY_*` if dependencies need longer startup windows
- `OPENGENI_OPENAI_PROVIDER`
- OpenAI or Azure OpenAI credentials
- `OPENGENI_SANDBOX_BACKEND`
- `OPENGENI_SANDBOX_PREPARATION_PROFILES` when sandbox credentials or lifecycle hooks are needed

If you are migrating from the pre-OpenGeni codebase, move the old `.env` aside and create a fresh one from `.env.example`; old `INFRA_AGENT_*` names are no longer read.

For local MinIO, keep S3-compatible storage and both object-storage endpoints:

```bash
OPENGENI_OBJECT_STORAGE_BACKEND=s3-compatible
OPENGENI_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9000
OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT=http://minio:9000
OPENGENI_DOCKER_NETWORK=opengeni_default
```

The first endpoint is for the host, browser, and API. The sandbox endpoint is for Docker agent containers joined to the local Compose network, where `minio:9000` resolves to the MinIO service. Presigned URLs generated for one host are not safely interchangeable with the other because the host is part of the S3 signature.

`bun run dev` auto-selects alternate Docker Compose host ports when common defaults such as `5432` are already in use, and it rewrites the in-memory runtime URLs for that run. Set `OPENGENI_*_HOST_PORT` values in `.env` when you need fixed local ports.

For production deployments, use the native provider object store instead of running MinIO manually:

```bash
OPENGENI_OBJECT_STORAGE_BACKEND=azure-blob
OPENGENI_OBJECT_STORAGE_BUCKET=opengeni-files
OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING=...
```

`OPENGENI_OBJECT_STORAGE_BUCKET` maps to the Azure Blob container. The API uses SAS URLs for browser upload/download and server-side reads for document indexing. Docker/local sandboxes mount Azure Blob through rclone; Modal sandboxes receive attached Azure Blob files through sandbox file materialization before the agent starts.

AWS S3 uses `OPENGENI_OBJECT_STORAGE_BACKEND=aws-s3` plus `OPENGENI_OBJECT_STORAGE_REGION`; prefer IRSA/EKS Pod Identity over static keys. GCS uses `OPENGENI_OBJECT_STORAGE_BACKEND=gcs` plus `OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID`; prefer GKE Workload Identity over service-account JSON. For AWS S3 and GCS file resources, OpenGeni materializes attached files in sandboxes through short-lived signed downloads.

For Modal runs, configure the Modal sandbox variables in `.env.example`.

## Deployment

The operator guide is in `docs/deployment.md`.

Current deployment artifacts include:

- A repo-owned deployment contract in `packages/deployment`.
- A Helm chart for API, web, worker, migrations, and disposable local/smoke fixtures at `deploy/helm/opengeni`.
- An Azure reference Terraform substrate at `deploy/terraform/azure`.
- AWS and GCP reference Terraform substrates at `deploy/terraform/aws` and `deploy/terraform/gcp`.
- Stack-wrapper plans that can install official upstream NATS and Temporal Helm charts outside the OpenGeni application chart.
- Runtime artifact generators for provider-specific non-secret Helm values and private runtime env files.
- A preflight/profile command:

```bash
bun run deployment:profiles
bun run deployment:preflight -- --profile azure-existing-services
bun run deployment:stack -- --profile gcp-managed
```

Production operators should use managed services, existing endpoints, or official upstream charts/operators for Postgres, Temporal, NATS, secret delivery, ingress/TLS, and observability. The in-chart Postgres, Temporal, NATS, and MinIO templates are only for local, CI, and smoke verification. Keep cloud resource inventories, generated credentials, kubeconfigs, Terraform state, and filled tfvars in private operator-controlled storage outside the repository.

## Web App

1. Start the stack with `bun run dev`.
2. Open `http://127.0.0.1:3000`.
3. Choose model and reasoning settings.
4. Optionally attach repositories, files, or document search.
5. Send the first task.
6. Watch messages, tool calls, approvals, sandbox output, and final status.
7. Send follow-ups, approve or reject tool requests, or interrupt the session.

Sessions are durable. Reloading the browser or opening the session URL later replays event history from Postgres and reconnects to live events.

## GitHub App Setup

The GitHub App integration is optional, but it is the recommended way to give agents scoped repository access. It lets the UI list installed repositories and lets the worker mint short-lived installation tokens only for repositories selected for a session.

From the web app:

1. Open the repository picker in the composer.
2. Expand **GitHub App**.
3. Optionally enter an organization login if the app should be created under an organization instead of your personal account.
4. Click **Create app**. The web app submits a GitHub App manifest to GitHub, and GitHub opens a prefilled app form.
5. Create the app in GitHub. The callback page prints `OPENGENI_GITHUB_APP_*` lines and includes a copy button.
6. Copy those lines into `.env`.
7. Restart the API and worker, or restart everything with `bun run dev`.
8. Install the app on the repositories the agent should access.
9. Refresh repositories in the picker and select repositories for the session.

For local development, the manifest callback can use the API origin from the running request. If you run behind a tunnel or deployed URL, set:

```bash
OPENGENI_GITHUB_APP_MANIFEST_BASE_URL=https://YOUR_DOMAIN
OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET=change-me
```

The generated app requests user authorization during install so OpenGeni can prove that the installer can access the installation before binding it to a workspace. First-release manifests do not register GitHub webhooks; repository listing, clone tokens, commits, pushes, and pull requests use installation access tokens.

The generated GitHub URL is only the manifest form target. Opening or copying that URL by itself only sends `state`, so GitHub shows an empty app form instead of the prefilled manifest.

## Documents

The Documents workspace supports document bases, file upload, indexing status, failed-document retry, and semantic search. Failed rows show parser errors and can be retried individually or in bulk after fixing the parser/runtime issue.

Document indexing depends on:

- `OPENGENI_DOCUMENT_PARSER`
- `OPENGENI_DOCUMENT_EMBEDDING_PROVIDER`
- `OPENGENI_DOCUMENT_EMBEDDING_MODEL`
- `OPENGENI_DOCUMENT_EMBEDDING_DIMENSIONS`

DOCX/PDF parsing depends on the configured parser backend. If parser dependencies are missing locally, documents can fail indexing and later be retried from the UI after the dependency issue is fixed.

## Public API

Core endpoints:

- `GET /healthz`
- `GET /v1/config/client`
- `GET /v1/access/me`
- `GET /v1/workspaces`
- `POST /v1/workspaces`
- `POST /v1/workspaces/:workspaceId/sessions`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events/stream`
- `POST /v1/workspaces/:workspaceId/sessions/:sessionId/events`

GitHub endpoints:

- `GET /v1/workspaces/:workspaceId/github/app`
- `GET /v1/workspaces/:workspaceId/github/repositories`
- `POST /v1/workspaces/:workspaceId/github/repositories/sync`
- `POST /v1/workspaces/:workspaceId/github/app-manifest`
- `GET /v1/github/app-manifest/callback`
- `GET /v1/github/setup`

Document endpoints:

- `GET /v1/workspaces/:workspaceId/document-bases`
- `POST /v1/workspaces/:workspaceId/document-bases`
- `GET /v1/workspaces/:workspaceId/document-bases/:baseId/documents`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/documents`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/search`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId/reindex`

## Testing

Fast checks do not require Temporal, NATS, Postgres, a sandbox backend, or live model credentials:

```bash
bun run typecheck
bun test
```

Broader checks:

```bash
bun run test:integration
bun run test:e2e
bun run test:live
bun run check
bun run check:full
```

Integration and E2E tests use Bun's test runner. Deterministic SDK-level tests use a scripted model so they can exercise the real worker, Temporal workflow, NATS/SSE path, Postgres, and sandbox plumbing without depending on live model output.

## Development Notes

- Public clients should treat the API as the source of truth.
- Browser streaming uses `GET /v1/workspaces/:workspaceId/sessions/:id/events/stream`.
- Agent activities are side-effectful. Do not add automatic Temporal retries around full agent turns unless each model, tool, and sandbox boundary has been made idempotent.
- Docker sandbox file resources from local S3-compatible storage are materialized into the sandbox before the run. Attach file resources before the first run when using the Docker backend.
- Sandbox preparation profiles are explicit. Model provider credentials are not automatically exposed inside sandboxes unless configured.

## Open Source Release Notes

The first public release should be published from a clean root commit instead of preserving private development history. Create the public repository from the final tracked source tree, not from the existing `.git` directory.

Before publishing:

- Confirm local `.env` files, `var/`, `node_modules/`, and generated build outputs are absent from the exported tree.
- Confirm local-only private workspaces are absent from the exported tree.
- Run a secret scan against the export, for example `gitleaks detect --no-git --source <export-dir>` and optionally `trufflehog filesystem <export-dir>`.
- Rotate any credential that ever appeared in the old private history, even if the new public export is clean.

The project license is Apache-2.0. Bundled HashiCorp Terraform-oriented agent skills include their own license at `packages/runtime/src/bundled_hashicorp_terraform_skills/LICENSE`.

## Roadmap

- First-class `agents` and `environments` API resources.
- Outbound webhooks for event delivery.
- Client SDK for event streaming, timeline projection, rendering, approvals, and interrupts.
- More OpenAI Agents SDK-compatible sandbox backends.
- Native mid-session file mounts for Docker sandboxes once the SDK supports privilege-safe late in-container mounts.
- Deeper Temporal/OpenAI Agents SDK integration when the TypeScript SDK supports durable agent, tool, and sandbox boundaries cleanly.

## References

- [Anthropic Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Anthropic engineering: Managed Agents](https://www.anthropic.com/engineering/managed-agents)
