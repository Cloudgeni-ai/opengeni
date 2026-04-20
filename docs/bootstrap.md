# Standalone Agent Bootstrap

Snapshot date: 2026-04-17.

## Structure

- `apps/api`: FastAPI service for API-facing run creation, run lookup, health, and event reads.
- `apps/worker`: Temporal worker process that registers the agent workflow.
- `packages/cloud_agent_contracts`: Pydantic contracts for runs, events, resources, and artifacts.
- `packages/cloud_agent_platform`: shared platform code for settings, SQLAlchemy persistence,
  Temporal wiring, OpenAI Agents SDK runtime glue, Modal sandbox integration, resources,
  artifacts, and events.
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

## Modal Sandbox Boundary

`cloud_agent_platform.sandbox.modal` no longer carries a repo-local Modal backend. The real
Modal implementation comes from the OpenAI Agents SDK first-party sandbox module. The only
repo-local code that remains is a tiny compatibility shim that injects default Modal client
options for the current Temporal workflow contract, which passes a sandbox provider name but
not provider-specific create options.

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
