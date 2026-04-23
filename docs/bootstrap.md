# Standalone Agent Bootstrap

Snapshot date: 2026-04-20.

## Structure

- `apps/api`: FastAPI service for API-facing run creation, run lookup, health, and event reads.
- `apps/worker`: Temporal worker process that registers the agent workflow.
- `packages/cloud_agent_contracts`: Pydantic contracts for runs, events, resources, and artifacts.
- `packages/cloud_agent_platform`: shared platform code for settings, SQLAlchemy persistence,
  Temporal wiring, OpenAI Agents SDK runtime glue, resources, artifacts, and events.
- `packages/cloud_agent_testing`: test helpers shared across package and app tests.
- `alembic`: migration environment and the first runtime-table migration.

The workspace uses `uv` with ordinary Python packages. Ruff, mypy, pytest, SQLAlchemy,
Alembic, FastAPI, Temporal, OpenAI Agents SDK, and Modal are configured from the root
`pyproject.toml`.

## Why API and Worker Are Separate

The API owns external HTTP contracts and durable run records. It does not execute model
calls, create sandboxes, or talk to Modal. When `CLOUD_AGENT_ENABLE_TEMPORAL_DISPATCH=true`,
it starts a Temporal workflow and records the workflow id.

The worker owns runtime execution. It registers `CloudAgentRunWorkflow`, configures
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

`build_sandbox_agent` also enables the OpenAI Agents SDK `Skills` capability: vendored
[HashiCorp Terraform agent skills](https://github.com/hashicorp/agent-skills) live under
`packages/cloud_agent_platform/src/cloud_agent_platform/bundled_hashicorp_terraform_skills` and
are copied into the sandbox at `.agents/<skill>` when a run starts. See that folder’s
`README.md` to update the bundle.

## Modal Sandbox Boundary

There is no repo-local Modal sandbox code. The platform uses the first-party OpenAI Agents SDK
Modal sandbox client (`agents.extensions.sandbox.modal.ModalSandboxClient`) directly.

Sandbox options (`app_name`, `timeout`) are passed through the Temporal workflow via
`WorkflowRunInput` and constructed into `ModalSandboxClientOptions` on the workflow side, so
the SDK client always receives proper options without any local shim or wrapper.

**Modal credentials:** the worker calls `apply_modal_client_environ` on startup, mapping
`CLOUD_AGENT_MODAL_TOKEN_ID` / `CLOUD_AGENT_MODAL_TOKEN_SECRET` (and optional
`CLOUD_AGENT_MODAL_PROFILE`, `CLOUD_AGENT_MODAL_CONFIG_PATH`) to the `MODAL_*` environment
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
uv run python -m cloud_agent_api
```

Run the Temporal worker:

```bash
uv run python -m cloud_agent_worker
```

## Azure OpenAI model deployments (for example, GPT-5.4)

The worker supports two model providers:

- `CLOUD_AGENT_OPENAI_PROVIDER=openai` (default): uses OpenAI API credentials.
- `CLOUD_AGENT_OPENAI_PROVIDER=azure`: uses Azure OpenAI via deployment-based routing.

When using Azure, set:

```bash
CLOUD_AGENT_OPENAI_PROVIDER=azure
CLOUD_AGENT_OPENAI_MODEL=gpt-5.4
CLOUD_AGENT_AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
CLOUD_AGENT_AZURE_OPENAI_DEPLOYMENT=gpt-5-4-prod
CLOUD_AGENT_AZURE_OPENAI_API_VERSION=2025-04-01-preview
# One of:
CLOUD_AGENT_AZURE_OPENAI_API_KEY=...
# or
CLOUD_AGENT_AZURE_OPENAI_AD_TOKEN=...
```

Notes:

- `CLOUD_AGENT_OPENAI_MODEL` is the model name passed into the agent runtime.
- Azure routing uses your deployment endpoint (for example, deployment `gpt-5-4-prod`).
- Keep `CLOUD_AGENT_AZURE_OPENAI_API_VERSION` aligned with your Azure resource/API support.

For Azure's v1-compatible endpoint style (`.../openai/v1`), use:

```bash
CLOUD_AGENT_OPENAI_PROVIDER=azure
CLOUD_AGENT_OPENAI_MODEL=gpt-5.4
CLOUD_AGENT_AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/v1
CLOUD_AGENT_AZURE_OPENAI_API_KEY=...
```

In this mode, API version may be omitted.
