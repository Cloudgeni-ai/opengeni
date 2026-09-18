# Local development

How to run Opengeni from a checkout, configure it, and verify a change. For
production deployment see [`deployment.md`](deployment.md); for the launcher's
internals (worktree isolation, port selection, native infrastructure, artifact
kernel) see [`deployment.md` § Local Development Stack](deployment.md#local-development-stack).

## Prerequisites

- Bun
- Docker (the default sandbox backend and the local infrastructure use it)
- rustup (the artifact kernel uses its checked-in exact Rust toolchain)
- OpenAI or Azure OpenAI credentials for real model runs

## Start the full stack

```bash
cp .env.example .env
bun run dev
```

`bun run dev` installs dependencies, creates `.env` from `.env.example` when
missing, runs migrations, and starts the API, both workers (control and turn),
artifact services, Connected Machines relay, and web app. With
`OPENGENI_DEV_BACKEND=auto` (the default), it uses Docker when the daemon is
reachable and otherwise starts PostgreSQL, NATS, Temporal, and MinIO as native
processes. Set the backend explicitly to `docker` or `native` when required.

The development web server forwards `/v1` requests to `VITE_API_BASE_URL`
(the API port selected by the launcher), matching production ingress routing.
OAuth callbacks can therefore return to the public web origin without landing
on the application's "Page not found" screen.

The native infrastructure path is intended for Linux sandboxes and other hosts
without Docker. It changes a copied `OPENGENI_SANDBOX_BACKEND=docker` default to
the in-process `local` sandbox provider, while preserving explicit remote
providers such as Modal or OpenSandbox. It also selects MinIO instead of the
Docker-only Garage fixture. `bun run dev:down` stops this worktree's selected
infrastructure; `bun run dev:clean -- --yes` also removes its data and
`.env.runtime` without touching another worktree or unrelated Docker state.

The first development start also prepares the current-host editable-artifact
kernel. Opengeni reads `packages/artifact-tool/kernel/rust-toolchain.toml` and
invokes Cargo and rustc through `rustup run <exact-pin>`; unrelated Homebrew or
system Rust binaries earlier on `PATH` are ignored. Cargo is also bound to the
pinned toolchain's absolute compiler path, so ambient compiler/wrapper variables
and user Cargo configuration cannot substitute another rustc. Missing pinned
toolchains and declared targets are installed without changing the rustup
default or the shell `PATH`. Set `RUSTUP_AUTO_INSTALL=0` to forbid that setup
and receive the exact manual install command instead.

`bun run dev` isolates each checkout/worktree (project from the directory name,
free host ports, loopback URL rewrite including `nats://`, `.env.runtime`
overlay for `dev:*`/`db:*`). Copied `.env` host-port pins are ignored unless
`OPENGENI_PIN_PORTS=1`. Native and Docker warm restarts reuse only a healthy
recorded stack's generated ports.

Default URLs:

- Web app: `http://127.0.0.1:3000`
- API health: `http://127.0.0.1:8000/healthz`
- NATS monitor: `http://127.0.0.1:8222`
- Object storage: Garage `http://127.0.0.1:3900` with Docker by default, or
  MinIO `http://127.0.0.1:9000` with the native backend/explicit MinIO fixture
- Temporal gRPC: `127.0.0.1:7233`
- Native Temporal UI: `http://127.0.0.1:8233`

## Manual startup

Use this when you want separate terminals for each long-running process:

```bash
bun install
docker compose up -d postgres nats temporal garage garage-init
bun run db:migrate
docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .
bun run dev:api
bun run dev:worker:control
bun run dev:worker:turn
bun run dev:web
```

The control and turn workers poll separate Temporal task queues, so both must run.
A stack with only the control worker serves the API and web app normally but never
executes an agent turn.

## Configuration

Copy `.env.example` to `.env` and configure at least:

- `OPENGENI_DATABASE_URL`
- `OPENGENI_NATS_URL`
- `OPENGENI_TEMPORAL_HOST`
- `OPENGENI_TEMPORAL_API_KEY` when using Temporal Cloud (enables TLS automatically)
- `OPENGENI_STARTUP_DEPENDENCY_RETRY_*` if dependencies need longer startup windows
- `OPENGENI_DEV_BACKEND` when automatic Docker/native selection is not desired
- `OPENGENI_OPENAI_PROVIDER`
- OpenAI or Azure OpenAI credentials
- Extra OpenAI-compatible servers, AI Gateway, OpenRouter, Codex, and SuperGrok: see
  [Configuring inference](model-providers.md#configuring-inference)
- `OPENGENI_SANDBOX_BACKEND`
- `OPENGENI_SANDBOX_PREPARATION_PROFILES` when sandbox credentials or lifecycle hooks are needed

If you are migrating from the pre-Opengeni codebase, move the old `.env` aside
and create a fresh one from `.env.example`; old `INFRA_AGENT_*` names are no
longer read.

Sandbox preparation profiles are explicit. Model provider credentials are not
automatically exposed inside sandboxes unless configured. Sandbox preparation
profiles and env allowlists can make host credentials available to agent
sandboxes, so review `.env` before running live sessions.

### Access modes

There are three product access modes, selected by `OPENGENI_PRODUCT_ACCESS_MODE`:

- `local`: local development bootstrap account/workspace, subject `dev`, broad permissions.
- `configured`: self-hosted or embedded deployments using configured deployment keys or delegated bearer tokens from a parent product.
- `managed`: Opengeni owns email/password sign-up through Better Auth, workspaces, organization and workspace API keys, prepaid Stripe credits, usage, and limits.

The optional deployment shared-key boundary is still available for infra smoke
tests and simple self-hosting. Ordinary clients send it as
`x-opengeni-access-key`; organization API keys and delegated tokens use
`Authorization: Bearer ...`. Valid first-party delegated bearers can enter the
`/v1` API without copying the static deployment key, then remain constrained by
normal route authorization. See
[`deployment.md` § Security Boundary](deployment.md#security-boundary).

### Object storage

For local Garage, keep S3-compatible storage and both object-storage endpoints:

```bash
OPENGENI_OBJECT_STORAGE_BACKEND=s3-compatible
OPENGENI_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:3900
OPENGENI_OBJECT_STORAGE_INTERNAL_ENDPOINT=http://garage:3900
OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT=http://garage:3900
# Prefer unset: `bun run dev` sets OPENGENI_DOCKER_NETWORK=${COMPOSE_PROJECT_NAME}_default
```

The public endpoint is embedded in browser-facing signed URLs. The internal
endpoint is used by API and worker storage requests, while the sandbox endpoint
is supplied to Docker agent containers. The two private endpoints may share the
same address when those processes use one Docker network. Presigned URLs
generated for one host are not safely interchangeable with another because the
host is part of the S3 signature.

For production deployments, use the native provider object store instead of
running Garage or MinIO manually:

```bash
OPENGENI_OBJECT_STORAGE_BACKEND=azure-blob
OPENGENI_OBJECT_STORAGE_BUCKET=opengeni-files
OPENGENI_OBJECT_STORAGE_AZURE_CONNECTION_STRING=...
```

`OPENGENI_OBJECT_STORAGE_BUCKET` maps to the Azure Blob container. The API uses
SAS URLs for browser upload/download and server-side reads for document
indexing. Docker/local sandboxes mount Azure Blob through rclone; Modal
sandboxes receive attached Azure Blob files through sandbox file
materialization before the agent starts.

AWS S3 uses `OPENGENI_OBJECT_STORAGE_BACKEND=aws-s3` plus
`OPENGENI_OBJECT_STORAGE_REGION`; prefer IRSA/EKS Pod Identity over static keys.
GCS uses `OPENGENI_OBJECT_STORAGE_BACKEND=gcs` plus
`OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID`; prefer GKE Workload Identity over
service-account JSON. For AWS S3 and GCS file resources, Opengeni materializes
attached files in sandboxes through short-lived signed downloads.

Docker sandbox file resources from local S3-compatible storage are materialized
into the sandbox before the run. Attach file resources before the first run when
using the Docker backend.

### Modal sandboxes

For Modal runs, configure the Modal sandbox variables in `.env.example`. Private
registry images use `OPENGENI_MODAL_IMAGE_REGISTRY_SECRET`; the global
`OPENGENI_MODAL_IMAGE_REF` is warmed at worker boot and remains the logical base
image identity for every Rig. Optional `OPENGENI_MODAL_SANDBOX_CPU` and
`OPENGENI_MODAL_SANDBOX_MEMORY_MIB` values reserve physical CPU cores and MiB of
memory for every new box and remain stable through resume and replacement.
A verified Rig provider image may accelerate physical cold create,
but never replaces that logical lease identity. Explicit Rig image overrides
are disabled. The registry
Secret lookup uses the configured `OPENGENI_MODAL_TOKEN_ID` /
`OPENGENI_MODAL_TOKEN_SECRET` client, so embedded hosts do not need to also set
standard `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` env vars or provide a
`~/.modal.toml` profile.

### OpenSandbox

For OpenSandbox runs, set `OPENGENI_SANDBOX_BACKEND=opensandbox`, a private
`OPENGENI_OPENSANDBOX_BASE_URL`, `OPENGENI_OPENSANDBOX_API_KEY`, an
immutable `OPENGENI_OPENSANDBOX_IMAGE` digest, and configured object storage.
Kubernetes deployments can use the optional pinned upstream platform wrapper
under `deploy/stacks`; it keeps the lifecycle service private and its lifecycle
routes Secret-backed. Exec and files stay on that ClusterIP server-proxy.
Channel B uses signed URI-mode ingress when
`OPENGENI_OPENSANDBOX_SIGNED_ENDPOINTS=true` (default off: lifecycle proxy,
in-box curl, and API frame-proxy). OpenSandbox v1 uses exact ID-addressed
attach, renewable provider TTL, and portable `/workspace` tar archives in
object storage. A desktop-class image advertises ttyd PTY and
desktop/recording; native OpenSandbox snapshots and `runAs` stay unavailable.
See [`deployment.md` § Optional OpenSandbox Kubernetes provider](deployment.md#optional-opensandbox-kubernetes-provider).

### Document indexing

Document indexing depends on:

- `OPENGENI_DOCUMENT_PARSER`
- `OPENGENI_DOCUMENT_EMBEDDING_PROVIDER`
- `OPENGENI_DOCUMENT_EMBEDDING_MODEL`
- `OPENGENI_DOCUMENT_EMBEDDING_DIMENSIONS`

Typical uploads include PDF, Word, PowerPoint, Excel, OpenDocument,
plain-text/structured-text, email, and common image formats. The stock API and
worker images include headless LibreOffice for Office conversion and local
English OCR data; native source runs use the parser's built-in image conversion
but require LibreOffice on the host to index Office formats. If parser
dependencies are missing locally, documents can fail indexing and later be
retried from the UI after the dependency issue is fixed. See
[`knowledge.md`](knowledge.md) for how indexed content is retrieved.

## Using the web app

1. Start the stack with `bun run dev`.
2. Open `http://127.0.0.1:3000`.
3. Choose model and reasoning settings.
4. Answer **Where should this run?** — pick **Managed Sandbox** (a fresh box, set up for you) or **Connected Machine** (run on your own computer). Machine is offered only when the feature is enabled and you have at least one enrolled machine.
5. For a Connected Machine, pick the machine and its **Project / folder** — the per-session working directory the agent runs under (the machine root / its launch directory, or a subdirectory). A managed sandbox needs no folder choice.
6. Optionally attach repositories, files, or document search.
7. Send the first task.
8. Watch messages, tool calls, approvals, sandbox output, and final status. The session header's **Run on** control shows the active target and, when machines are enabled, lets you swap targets mid-session.
9. Send follow-ups, approve or reject tool requests, or interrupt the session.

Sessions are durable. Reloading the browser or opening the session URL later
replays event history from Postgres and reconnects to live events.

### Connecting a machine

When Connected Machines are enabled, connect one from the workspace **Machines**
dashboard (or from the composer's machine picker):

1. Click **Connect a machine** and run the printed one-liner on the computer you want to connect. The same command installs or updates the agent and adds this workspace without replacing any existing Opengeni connections on that computer.
2. Approve the machine. Two paths exist:
   - **Device flow (consent):** the agent prints a short code and a verification link; you open it and click **Grant** in the workspace to approve that specific machine. Approval is the loud, explicit consent step, and it records who approved.
   - **Zero-click enroll token:** mint a short-lived enroll token in the workspace ahead of time; the agent redeems it headlessly (the token is the grant, no per-machine click) — the path for scripted or fleet enrollment.
3. The machine appears in the dashboard with its status, OS/arch, and whether it offers a screen. You can revoke it at any time. Screen control is a separate opt-in granted at approval.

The agent dials **out** to the control plane, so the machine needs no inbound
network exposure. Operators enable the feature as described in
[`deployment.md` § Connected Machines](deployment.md#connected-machines);
the SDK-level contract is in [`connected-machines.md`](connected-machines.md).

### GitHub App

Give agents scoped repository access by creating and connecting a GitHub App
from the composer's repository picker. See
[`github-app.md` § Operator setup](github-app.md#operator-setup).

## Testing

Fast checks do not require Temporal, NATS, Postgres, a sandbox backend, or live
model credentials:

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

Integration and E2E tests use Bun's test runner. Deterministic SDK-level tests
use a scripted model so they can exercise the real worker, Temporal workflow,
NATS/SSE path, Postgres, and sandbox plumbing without depending on live model
output. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for which checks a pull
request needs.

## Development notes

- Public clients should treat the API as the source of truth.
- Browser streaming uses `GET /v1/workspaces/:workspaceId/sessions/:id/events/stream`.
- Agent activities are side-effectful. Do not add automatic Temporal retries around full agent turns unless each model, tool, and sandbox boundary has been made idempotent.
- Read [`../AGENTS.md`](../AGENTS.md) before changing the session workflow, the agent turn activity, or memory; [`run-lifecycle.md`](run-lifecycle.md) is the canonical lifecycle reference.
