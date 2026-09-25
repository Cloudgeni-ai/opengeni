# Local development

How to run Opengeni from a checkout, configure it, and verify a change. For
production deployment see [`deployment.md`](deployment.md); for the launcher's
internals (worktree isolation, port selection, native infrastructure, artifact
kernel) see [`deployment.md` § Local Development Stack](deployment.md#local-development-stack).

## Prerequisites

- Linux or macOS; on Windows, run the full stack inside WSL2. Keep the checkout and executable tools in the same environment. An agent's isolated sandbox is not automatically your physical computer.
- Bun at the exact version in `.bun-version`, plus Git, Bash and curl.
- Docker, for local Postgres, NATS, Temporal, and Garage when the daemon is up. The agent sandbox defaults to `local` (this machine). Set `OPENGENI_SANDBOX_BACKEND=docker` to run the agent in the local sandbox image instead.
- rustup and a C compiler only when a matching verified artifact-runtime prebuilt is unavailable or when the optional relay needs a source build. The artifact kernel uses its checked-in exact Rust toolchain.
- Model credentials for real agent runs. They are not required to start the app; use Settings → Models afterward. The `OPENGENI_OPENAI_API_KEY` example is commented out and empty.

Run `bun run dev:check` to collect missing prerequisites without starting services.
The native infrastructure path additionally needs PostgreSQL server/client tools
(`pg_config`, `psql`, `pg_isready`, `initdb`, `pg_ctl`) with `pgcrypto` and
`vector` extensions, NATS server, Temporal CLI and the selected object-storage
server. The Docker path needs a responding daemon and Compose; an installed
Docker CLI alone is not enough. Follow the checker diagnostics for your host,
rather than copying Linux package commands to macOS or Windows. Native process
supervision is supported on Linux/WSL2; use a running Docker daemon on macOS.
`bun run dev:tools` prints the project-local tool installation plan without
changing the machine. `bun run dev:tools -- --install` explicitly installs its
supported pinned binaries; it does not install OS packages or Rust, and does not
modify your shell profile. The launcher adds the exact tool directory to its
own `PATH`.

## Start the full stack

```bash
bun run dev
```

`bun run dev` installs dependencies, creates `.env` from `.env.example` when
missing, runs migrations, and starts the API, both workers (control and turn),
artifact services and web app. Connected Machines is optional and off in a fresh
checkout; set `OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true` to prepare and start its
relay. Existing explicit values are preserved. With
`OPENGENI_DEV_BACKEND=auto` (the default), it uses Docker when the daemon is
reachable and otherwise starts PostgreSQL, NATS, Temporal, and Garage as native
processes. Set the backend explicitly to `docker` or `native` when required.
An invocation's `OPENGENI_DEV_BACKEND` takes precedence over `.env`; when unset,
the file's setting remains effective. An explicit `docker` request fails if the
daemon is unavailable instead of silently starting native infrastructure.

The development web server forwards `/v1` requests to `VITE_API_BASE_URL`
(the API port selected by the launcher), matching production ingress routing.
OAuth callbacks can therefore return to the public web origin without landing
on the application's "Page not found" screen.

The native infrastructure path is intended for Linux/WSL2 hosts without Docker.
It changes a copied `OPENGENI_SANDBOX_BACKEND=docker` default to
the in-process `local` sandbox provider, while preserving explicit remote
providers such as Modal or OpenSandbox. Fresh storage uses Garage; existing
native MinIO state is preserved, and incompatible provider changes fail with a
diagnostic rather than silently using empty storage. MinIO remains an explicit
compatibility option (`OPENGENI_OBJECT_STORAGE_FIXTURE=minio`). Switching an
existing project requires a deliberate backup/migration; selecting Garage is
not a migration command. `bun run dev:down` stops this worktree's selected
infrastructure; `bun run dev:clean -- --yes` also removes its data and
`.env.runtime` without touching another worktree or unrelated Docker state.

The first development start also prepares the current-host editable-artifact
kernel. It reuses only a source-matched verified installation or prebuilt;
unavailable downloads fall back to an explicit source build. Published native
runtime releases are immutable and bound to the exact source commit and target;
setup verifies release provenance, archive digests and kernel receipts before
use. Anonymous release downloads are preferred, with authenticated exact-source
Actions artifacts as a fallback. CI publishes a complete native matrix only
after successful canonical main CI; a just-merged or modified checkout may need
a source build until matching assets exist. Download-cache reuse rechecks provider
metadata; already prepared installations can be reused offline without Rust.
No unrelated latest binary is substituted. For a source build,
OpenGeni reads `packages/artifact-tool/kernel/rust-toolchain.toml` and
invokes Cargo and rustc through `rustup run <exact-pin>`; unrelated Homebrew or
system Rust binaries earlier on `PATH` are ignored. Cargo is also bound to the
pinned toolchain's absolute compiler path, so ambient compiler/wrapper variables
and user Cargo configuration cannot substitute another rustc. Missing pinned
toolchains and declared targets are installed without changing the rustup
default or the shell `PATH`. Set `RUSTUP_AUTO_INSTALL=0` to forbid that setup
and receive the exact manual install command instead.

The artifact kernel and Connected Machines relay are separate dependencies.
Turning off Connected Machines does not turn off editable artifacts. An opted-in
relay is built before application startup, so its cold compilation does not
compete with readiness checks on a small host.

`bun run dev` isolates each checkout/worktree (project from the directory name,
free host ports, loopback URL rewrite including `nats://`, `.env.runtime`
overlay for `dev:*`/`db:*`). Copied `.env` host-port pins are ignored unless
`OPENGENI_PIN_PORTS=1`. Native and Docker warm restarts reuse only a healthy
recorded stack's generated ports.

The API, the web app, and the published Docker infrastructure ports bind
`127.0.0.1`, because the API runs in `local` access mode without authentication
and the default `local` sandbox runs agent commands directly on this computer. A
copied `OPENGENI_API_HOST` does not change that. Loopback keeps other devices
out; it does not authenticate programs on this computer, so treat the local API
like any other unauthenticated local service. Set `OPENGENI_DEV_BIND_HOST=0.0.0.0`
only when you deliberately want other devices, for example on a private tailnet,
to reach the stack; it exposes all of those services on every interface. Docker
sandboxes on Linux reach the API through the Docker bridge, so Codemode and the
Git broker inside them need that opt-in (or an explicit sandbox-reachable
`OPENGENI_MCP_URL`); Docker Desktop reaches a loopback API without it.

Wait for the aggregate readiness message, then open the printed web URL and
check that the app renders. If a model is connected, verify an assistant reply
and a harmless command in the default sandbox; a sandbox-free model response
does not test agent compute. Otherwise verify the model-connection screen and
complete that step when credentials are available. Keep the exact foreground
launcher running; Ctrl-C stops its application processes, and `dev:down` stops
this project's infrastructure. Do not kill processes by name or delete data as
a restart workaround.

Default URLs:

- Web app: `http://127.0.0.1:3000`
- API health: `http://127.0.0.1:8000/healthz`
- NATS monitor: `http://127.0.0.1:8222`
- Object storage: Garage `http://127.0.0.1:3900` for fresh Docker/native projects,
  or MinIO `http://127.0.0.1:9000` for existing/explicit MinIO projects
- Temporal gRPC: `127.0.0.1:7233`
- Native Temporal UI: `http://127.0.0.1:8233`

## Manual startup

Use this when you want separate terminals for each long-running process:

```bash
bun install
docker compose up -d postgres nats temporal garage
bun scripts/dev-native-storage.ts provision .
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
image identity for every Sandbox Environment. Optional `OPENGENI_MODAL_SANDBOX_CPU` and
`OPENGENI_MODAL_SANDBOX_MEMORY_MIB` values reserve physical CPU cores and MiB of
memory for every new box and remain stable through resume and replacement.
A verified Sandbox Environment provider image may accelerate physical cold create,
but never replaces that logical lease identity. Explicit Sandbox Environment image overrides
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
network exposure. The local stack binds loopback, so a machine on this computer
connects as is. A machine on another computer must reach this stack's API, NATS,
and relay, so it also needs the stack started with `OPENGENI_DEV_BIND_HOST=0.0.0.0`
(read [Start the full stack](#start-the-full-stack) first) and
`OPENGENI_SELFHOSTED_NATS_URL` and `OPENGENI_SELFHOSTED_RELAY_URL` (with
`OPENGENI_RELAY_BIND` for the local relay) pointing at an address it can reach,
such as a tailnet address. Operators enable the feature as described in
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
