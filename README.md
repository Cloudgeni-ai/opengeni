# OpenGeni

OpenGeni is a self-hostable managed agent service for long-running infrastructure work.

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

OpenGeni is intended to be self-hosted behind a trusted product, gateway, VPN, or reverse proxy. The base API does not yet ship built-in authentication, tenancy, RBAC, API keys, or scoped client permissions.

Do not expose the API or worker control plane directly to the public internet without an external access-control layer. Sandbox preparation profiles and env allowlists can make host credentials available to agent sandboxes, so review `.env` before running live sessions.

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
    DB["Postgres<br/>sessions, events, run state"]
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
- MinIO for local S3-compatible file storage and Azure Blob for production object storage
- OpenAI Agents SDK
- Docker and Modal sandbox backends

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
OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT=http://host.docker.internal:9000
```

The first endpoint is for the host, browser, and API. The sandbox endpoint is for Docker agent containers, where `127.0.0.1` points at the sandbox container instead of host MinIO. Presigned URLs generated for one host are not safely interchangeable with the other because the host is part of the S3 signature.

`bun run dev` auto-selects alternate Docker Compose host ports when common defaults such as `5432` are already in use, and it rewrites the in-memory runtime URLs for that run. Set `OPENGENI_*_HOST_PORT` values in `.env` when you need fixed local ports.

For Azure production deployments, prefer Azure Blob:

```bash
OPENGENI_OBJECT_STORAGE_BACKEND=azure-blob
OPENGENI_OBJECT_STORAGE_BUCKET=opengeni-files
OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING=...
```

`OPENGENI_OBJECT_STORAGE_BUCKET` maps to the Azure Blob container. The API uses SAS URLs for browser upload/download and server-side reads for document indexing. Docker/local sandboxes mount Azure Blob through rclone; Modal sandboxes receive attached Azure Blob files through sandbox file materialization before the agent starts.

For Modal runs, configure the Modal sandbox variables in `.env.example`.

## Deployment

The deployment foundation is tracked in `docs/infra-deployment-goal.md` and the operator guide is in `docs/deployment.md`.

Current deployment artifacts include:

- A repo-owned deployment contract in `packages/deployment`.
- A Helm chart for API, web, worker, migrations, and optional in-cluster NATS at `deploy/helm/opengeni`.
- An Azure reference Terraform substrate at `deploy/terraform/azure`.
- A preflight/profile command:

```bash
bun run deployment:profiles
bun run deployment:preflight -- --profile azure-existing-services
```

Azure resources created during deployment verification must be tracked in `docs/azure-resource-ledger.md`.

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

When the manifest base URL is public HTTPS, the generated app also includes webhook settings. Localhost manifests skip webhooks and still work for repository listing, clone tokens, commits, pushes, and pull requests.

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
- `POST /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `GET /v1/sessions/:sessionId/events`
- `GET /v1/sessions/:sessionId/events/stream`
- `POST /v1/sessions/:sessionId/events`

GitHub endpoints:

- `GET /v1/github/app`
- `GET /v1/github/repositories`
- `POST /v1/github/repositories/sync`
- `POST /v1/github/app-manifest`
- `GET /v1/github/app-manifest/callback`

Document endpoints:

- `GET /v1/document-bases`
- `POST /v1/document-bases`
- `GET /v1/document-bases/:baseId/documents`
- `POST /v1/document-bases/:baseId/documents`
- `POST /v1/document-bases/:baseId/search`
- `POST /v1/documents/:documentId/reindex`

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
- Browser streaming uses `GET /v1/sessions/:id/events/stream`.
- Agent activities are side-effectful. Do not add automatic Temporal retries around full agent segments unless each model, tool, and sandbox boundary has been made idempotent.
- Docker sandbox file resources use native S3-compatible in-container mounts. Attach file resources before the first run when using the Docker backend.
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

- Authentication, tenancy, API keys, and scoped client permissions.
- Outbound webhooks for event delivery.
- First-class `agents` and `environments` API resources.
- Client SDK for event streaming, timeline projection, rendering, approvals, and interrupts.
- More OpenAI Agents SDK-compatible sandbox backends.
- Native mid-session file mounts for Docker sandboxes once the SDK supports privilege-safe late in-container mounts.
- Deeper Temporal/OpenAI Agents SDK integration when the TypeScript SDK supports durable agent, tool, and sandbox boundaries cleanly.

## References

- [Anthropic Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Anthropic engineering: Managed Agents](https://www.anthropic.com/engineering/managed-agents)
