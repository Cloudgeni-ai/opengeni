# Standalone Agent Bootstrap

Snapshot date: 2026-04-20.

## Structure

- `apps/api`: FastAPI service for API-facing run creation, run lookup, health, and event reads.
- `apps/web`: TanStack + Vite + React product UI (`npm run dev` — default `http://127.0.0.1:3000`;
  see `apps/web/.env.example` for `VITE_API_BASE_URL` → API, usually `http://127.0.0.1:8000`).
- `apps/worker`: Temporal worker process that registers the agent workflow.
- `packages/infra_agent_contracts`: Pydantic contracts for runs, events, resources, and artifacts.
- `packages/infra_agent_platform`: shared platform code for settings, SQLAlchemy persistence,
  Temporal wiring, OpenAI Agents SDK runtime glue, resources, artifacts, and events.
- `packages/infra_agent_testing`: test helpers shared across package and app tests.
- `alembic`: migration environment and the first runtime-table migration.

The workspace uses `uv` with ordinary Python packages. Ruff, mypy, pytest, SQLAlchemy,
Alembic, FastAPI, Temporal, OpenAI Agents SDK, Modal, and Docker sandbox support are
configured from the root `pyproject.toml`.

To **start the full stack** (migrations, `.env`, API, **`apps/web` dev server**, Temporal
worker, Temporal service requirement, and how final workflow output is observed), see
[`AGENTS.md`](../AGENTS.md) at the repository root. That is what “spin up everything”
means in this project.

## Why API and Worker Are Separate

The API owns external HTTP contracts and durable run records. It does not execute model
calls, create sandboxes, or talk to a sandbox backend. When `INFRA_AGENT_ENABLE_TEMPORAL_DISPATCH=true`,
it starts a Temporal workflow and records the workflow id.

The worker owns runtime execution. It registers `InfraAgentRunWorkflow`, configures
Temporal's `OpenAIAgentsPlugin`, and registers the configured sandbox backend. Model calls
and sandbox operations are routed through the Temporal/OpenAI integration path instead of
being handled directly in the API process.

## OpenAI Agents SDK Boundary

The platform builds an SDK `SandboxAgent` and runs it through the SDK `Runner`. The code does
not reimplement the agent loop, tool dispatch, handoffs, tracing, sessions, or sandbox run
configuration. SQLAlchemy runtime tables are intentionally separate from OpenAI
`SQLAlchemySession`: the platform database tracks runs, events, artifacts, workflow ids, and
future serialized run-state references, while SDK session storage remains a conversation
history surface.

For a concise reference on enabling **agent skills** via the Python SDK’s `Skills`
capability (vs. Responses API shell skills, vs. Codex), see
[openai-agents-sdk-skills.md](openai-agents-sdk-skills.md).

`build_sandbox_agent` also enables the OpenAI Agents SDK `Skills` capability
(`from_=LocalDir(absolute)`) and `InfraAgentRunWorkflow` passes the **processed** manifest
into `SandboxRunConfig` so the merged `.agents` entry (host path to the HashiCorp bundle) is
used when the sandbox session is created. Vendored
[HashiCorp Terraform agent skills](https://github.com/hashicorp/agent-skills) are under
`packages/infra_agent_platform/src/infra_agent_platform/bundled_hashicorp_terraform_skills` and
end up in the remote workspace at `.agents/<skill>`. See that folder’s `README.md` to refresh
the bundle.

## Sandbox Backend Boundary

There is no repo-local sandbox client code. The platform uses first-party OpenAI Agents SDK
sandbox clients directly and selects one with `INFRA_AGENT_SANDBOX_BACKEND`:

- `modal`: `agents.extensions.sandbox.modal.ModalSandboxClient`
- `docker`: `agents.sandbox.sandboxes.docker.DockerSandboxClient`
- `none`: no sandbox client provider

Sandbox options are passed through the Temporal workflow via `WorkflowRunInput` and
constructed into provider-specific SDK options on the workflow side:
`ModalSandboxClientOptions` for Modal and `DockerSandboxClientOptions` for Docker. The SDK
client always receives proper options without any local shim or wrapper.

For Docker, set `INFRA_AGENT_DOCKER_IMAGE` and optionally `INFRA_AGENT_DOCKER_EXPOSED_PORTS`.
The Docker image must include `git` for repository resources to mount via SDK `GitRepo`
entries.

The sandbox image is the common capability boundary for both Docker and Modal. Modal builds
from `docker/sandbox.Dockerfile` by default, using `.` as the Docker context. Override with
`INFRA_AGENT_MODAL_DOCKERFILE` or `INFRA_AGENT_MODAL_DOCKER_CONTEXT_DIR` if the worker starts
from a different layout. First builds can be slow, so `INFRA_AGENT_MODAL_SANDBOX_CREATE_TIMEOUT_SECONDS`
defaults to `600`.

For Docker, build the same image locally:

```bash
docker build -f docker/sandbox.Dockerfile -t infra-agents-sandbox:local .
```

You can also push the same image to a registry and point both sandbox backends at that tag:

```bash
docker build -f docker/sandbox.Dockerfile -t ghcr.io/YOUR_ORG/infra-agents-sandbox:dev .
docker push ghcr.io/YOUR_ORG/infra-agents-sandbox:dev

INFRA_AGENT_DOCKER_IMAGE=ghcr.io/YOUR_ORG/infra-agents-sandbox:dev
INFRA_AGENT_MODAL_IMAGE_REF=ghcr.io/YOUR_ORG/infra-agents-sandbox:dev
```

The image installs Terraform, Checkov, Azure CLI, GitHub CLI, and basic shell utilities. The
agent also receives `.agents/checkov/SKILL.md`, so Checkov remains a normal chat/shell
capability instead of a custom API or UI workflow.

Sandbox credentials are copied from the API/dispatcher process at run dispatch time, then
included in the Temporal workflow payload and sandbox manifest. Keep the set narrow and prefer
short-lived credentials.

Use `INFRA_AGENT_SANDBOX_ENV_PROFILES` for the normal case:

| Profile | Variables copied when present | Use |
| --- | --- | --- |
| `azure` | `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_AUTHORITY_HOST` | Terraform Azure provider and Azure CLI/SDK service-principal context |
| `github` | `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | GitHub CLI, pushes, PR creation, and commit identity |
| `none` | none | Disable profile-based sandbox env pass-through |

Add project-specific names with `INFRA_AGENT_SANDBOX_ENV_EXTRA_VARS`, for example
`TF_VAR_region,CUSTOM_PROVIDER_TOKEN`. `INFRA_AGENT_SANDBOX_ENV_VARS` is still supported as a
legacy explicit override; when set, it replaces profiles and extra vars entirely.

Runs started with repositories selected from the GitHub App list mint one short-lived
installation token for that selected installation. The dispatcher injects it as `GH_TOKEN` /
`GITHUB_TOKEN`, configures git's HTTPS auth header, and sets
`GIT_ASKPASS=/usr/local/bin/infra-agent-git-askpass`, so SDK `GitRepo` clones and
`gh -R owner/repo ...` commands can authenticate without tokenized clone URLs. Manual URL
repositories are not GitHub App-tokenized; they must be public or use credentials supplied by the
normal sandbox environment profiles.

The dispatcher also ensures every sandbox has a Git commit identity. Explicit raw
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` values or `INFRA_AGENT_GIT_AUTHOR_*` /
`INFRA_AGENT_GIT_COMMITTER_*` settings win. Otherwise, when the GitHub App is configured, it
resolves `<app-slug>[bot]` through GitHub and uses GitHub's noreply format:
`<bot-id>+<app-slug>[bot]@users.noreply.github.com`. If that cannot be resolved, it falls back
to `Infra Agent <infra-agent@example.invalid>`.

For Azure CLI, set service-principal credentials before starting API/worker:
`ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_TENANT_ID`, and usually
`ARM_SUBSCRIPTION_ID`. `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, and
`AZURE_SUBSCRIPTION_ID` are also supported; the sandbox helper falls back to `ARM_*`.
Run `infra-agent-azure-login` once before Azure CLI work. It performs
`az login --service-principal` and selects the subscription. Without these env vars,
`az account show` correctly reports that no Azure login is configured. Terraform does not need
the helper because the AzureRM provider reads `ARM_*` directly.

Model provider settings such as `INFRA_AGENT_AZURE_OPENAI_API_KEY` are platform credentials.
They are not passed into the sandbox unless you explicitly add their names, which should not be
needed for normal agent runs.

The GitHub App manifest helper can run from localhost. When the manifest base URL is not public
HTTPS, it omits webhook configuration and webhook event subscriptions so GitHub will not reject
`127.0.0.1` / `localhost` hook URLs. Set `INFRA_AGENT_GITHUB_APP_MANIFEST_BASE_URL` to a public
HTTPS API URL or tunnel only when webhook delivery is implemented and reachable.

**Modal credentials:** the worker calls `apply_modal_client_environ` on startup, mapping
`INFRA_AGENT_MODAL_TOKEN_ID` / `INFRA_AGENT_MODAL_TOKEN_SECRET` (and optional
`INFRA_AGENT_MODAL_PROFILE`, `INFRA_AGENT_MODAL_CONFIG_PATH`) to the `MODAL_*` environment
variables the [Modal](https://modal.com) Python client reads. You can also set `MODAL_*`
directly, or use `modal token set` and `~/.modal.toml` if no tokens are in `Settings`. See
[`.env.example`](../.env.example).

## Deferred Deliberately

- No CLI product.
- No webhooks or callback delivery layer.
- No generic provider abstraction tower.
- No direct API-to-OpenAI or API-to-Modal execution path.
- No full artifact object-store implementation beyond the initial filesystem seam.
- No production auth, tenancy, quota, cancellation, or streaming transport yet.
- No worker-side database status updates yet; the initial workflow returns a result through
  Temporal and leaves persistent status transitions for the next implementation slice.

## Local Commands

See [AGENTS.md](../AGENTS.md) for a single copy-paste “cold start” and troubleshooting.

```bash
uv sync --all-packages --dev
uv run ruff format .
uv run ruff check .
uv run mypy apps packages
uv run pytest
```

Run Alembic migrations against the configured database:

```bash
uv run alembic upgrade head
```

Run the API service:

```bash
uv run python -m infra_agent_api
```

Run the web app (Vite, port 3000 by default):

```bash
cd apps/web
npm install
cp .env.example .env  # if needed, then set VITE_API_BASE_URL
npm run dev
```

Run the Temporal worker:

```bash
uv run python -m infra_agent_worker
```

## Azure OpenAI model deployments (for example, GPT-5.4)

The worker supports two model providers:

- `INFRA_AGENT_OPENAI_PROVIDER=openai` (default): uses OpenAI API credentials.
- `INFRA_AGENT_OPENAI_PROVIDER=azure`: uses Azure OpenAI via deployment-based routing.

When using Azure, set:

```bash
INFRA_AGENT_OPENAI_PROVIDER=azure
INFRA_AGENT_OPENAI_MODEL=gpt-5.5
INFRA_AGENT_AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
INFRA_AGENT_AZURE_OPENAI_DEPLOYMENT=gpt-5-4-prod
INFRA_AGENT_AZURE_OPENAI_API_VERSION=2025-04-01-preview
# One of:
INFRA_AGENT_AZURE_OPENAI_API_KEY=...
# or
INFRA_AGENT_AZURE_OPENAI_AD_TOKEN=...
```

Notes:

- `INFRA_AGENT_OPENAI_MODEL` is the model name passed into the agent runtime.
- Per-run `reasoning_effort` controls the model thinking level and accepts `none`,
  `minimal`, `low`, `medium`, `high`, or `xhigh`.
- Azure routing uses your deployment endpoint (for example, deployment `gpt-5-4-prod`).
- Keep `INFRA_AGENT_AZURE_OPENAI_API_VERSION` aligned with your Azure resource/API support.

For Azure's v1-compatible endpoint style (`.../openai/v1`), use:

```bash
INFRA_AGENT_OPENAI_PROVIDER=azure
INFRA_AGENT_OPENAI_MODEL=gpt-5.5
INFRA_AGENT_AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/v1
INFRA_AGENT_AZURE_OPENAI_API_KEY=...
```

In this mode, API version may be omitted.
