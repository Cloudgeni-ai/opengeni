# Agent / automation notes (Infra Agents)

This file is for **automation and coding agents** (and humans) who work in this repository.  
When the user says **"start the dev server"**, **"spin it up"**, or **"run the full stack"**, they mean the steps under **## Full local stack (definition)**.

---

## Full local stack (definition)

**"The stack"** here means everything needed to create agent runs from the API (or the small web UI) and have **Temporal** execute the **OpenAI Agents SDK** workflow in a **Modal** sandbox, using credentials from the environment.

That includes, in order:

1. **Dependencies and database**
   - `uv sync --all-packages --dev`
   - `uv run alembic upgrade head` (SQLite at `./var/infra_agents.db` by default, from `Settings.database_url`)

2. **Temporal** must be **reachable** at the address in `CLOUD_AGENT_TEMPORAL_HOST` (default `localhost:7233`). The worker does not start a Temporal server; you run one separately (e.g. Temporal dev server / your cluster). Without it, the API can still respond, but dispatch or workflow progress will fail.

3. **Environment** — copy [`.env.example`](./.env.example) to **`.env`** in the **repository root** and set at least:
   - `CLOUD_AGENT_ENABLE_TEMPORAL_DISPATCH=true` to enqueue workflows
   - Model provider settings (e.g. Azure: `CLOUD_AGENT_OPENAI_PROVIDER=azure` and the `CLOUD_AGENT_AZURE_OPENAI_*` variables, or OpenAI)
   - Modal: `CLOUD_AGENT_SANDBOX_BACKEND=modal` and, if you use the Settings mapping, `CLOUD_AGENT_MODAL_TOKEN_ID` / `CLOUD_AGENT_MODAL_TOKEN_SECRET` (or rely on `MODAL_*` / `~/.modal.toml` after worker startup)

4. **Two long-running processes** (two terminals, or `nohup` / a process manager):
   - **API + web UI:** from repo root, `uv run python -m cloud_agent_api`  
     - Serves `http://0.0.0.0:8000` (open **`http://localhost:8000/`** for the HTML form, **`http://localhost:8000/docs`** for Swagger, **`/healthz`** for health)
   - **Worker:** from repo root, `uv run python -m cloud_agent_worker`  
     - Connects to Temporal, registers `CloudAgentRunWorkflow`, and applies `apply_modal_client_environ` from `Settings` on startup

All commands assume the **current working directory is the repo root** so `.env` and `alembic.ini` resolve correctly.

---

## Quick copy-paste: cold start

```bash
cd /path/to/infra-agents   # repo root
export PATH="$HOME/.local/bin:$PATH"  # or wherever `uv` lives
uv sync --all-packages --dev
uv run alembic upgrade head
set -a; source .env; set +a
uv run python -m cloud_agent_api &
uv run python -m cloud_agent_worker &
```

Then verify: `curl -sS http://127.0.0.1:8000/healthz` and open `http://127.0.0.1:8000/`.

If port 8000 is in use, stop the old Uvicorn process (or use another port by changing the API code / deployment — default is 8000).

---

## What the API does *not* return (yet)

- **`GET /v1/runs/{id}`** returns the **persisted run record** (status, `temporal_workflow_id`, etc.). It does **not** embed the workflow’s final model output by default; that is produced when **Temporal** completes the workflow.
- **Final agent output** for a run: use the **Temporal** workflow for that run (e.g. `agent-run-<uuid>`) — for example the Temporal CLI `workflow result` with that workflow id — or your observability around Modal/worker logs.

The **web UI at `/`** only submits **`POST /v1/runs`** and shows the JSON **creation/dispatch** response, not a live stream of the model’s answer.

---

## Skilled agents (context)

- Agent behavior and bundled Terraform **Skills** are configured in the platform; see [docs/bootstrap.md](docs/bootstrap.md) (OpenAI Agents SDK boundary, Modal, local commands).
- Eager `Skills(from_=LocalDir(...))` materialize under `.agents/` in the sandbox as described there.

---

## When tests are enough

Unit tests and `uv run pytest` do **not** require Temporal, Modal, or a live model. Full **end-to-end** checks require the full stack above plus valid cloud credentials.
