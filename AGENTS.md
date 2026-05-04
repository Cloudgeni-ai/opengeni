# Agent / automation notes (Infra Agents)

This file is for **automation and coding agents** (and humans) who work in this repository.  
When the user says **"start the dev server"**, **"spin it up"**, or **"run the full stack"**, they mean the steps under **## Full local stack (definition)**.

---

## Full local stack (definition)

**"The stack"** here means everything needed to run the **FastAPI** backend, the **TanStack web app** in `apps/web`, and the **Temporal worker**, so you can create agent runs and have **Temporal** execute the **OpenAI Agents SDK** workflow in the configured sandbox backend (`modal` or `docker`), using credentials from the environment.

That includes, in order:

1. **Dependencies and database (Python)**
   - `uv sync --all-packages --dev`
   - `uv run alembic upgrade head` (SQLite at `./var/infra_agents.db` by default, from `Settings.database_url`)

1b. **Web app dependencies (Node, for `apps/web`)**
   - `cd apps/web && npm install` (or the package manager you use with `package-lock.json`)

2. **Temporal** must be **reachable** at the address in `INFRA_AGENT_TEMPORAL_HOST` (default `localhost:7233`). The worker does not start a Temporal server; you run one separately (e.g. Temporal dev server / your cluster). Without it, the API can still respond, but dispatch or workflow progress will fail.

3. **Environment** — copy [`.env.example`](./.env.example) to **`.env`** in the **repository root** and set at least:
   - `INFRA_AGENT_ENABLE_TEMPORAL_DISPATCH=true` to enqueue workflows
   - Model provider settings (e.g. Azure: `INFRA_AGENT_OPENAI_PROVIDER=azure` and the `INFRA_AGENT_AZURE_OPENAI_*` variables, or OpenAI)
   - Sandbox: `INFRA_AGENT_SANDBOX_BACKEND=modal` or `INFRA_AGENT_SANDBOX_BACKEND=docker`
   - Modal backend: if you use the Settings mapping, set `INFRA_AGENT_MODAL_TOKEN_ID` / `INFRA_AGENT_MODAL_TOKEN_SECRET` (or rely on `MODAL_*` / `~/.modal.toml` after worker startup)
   - Docker backend: build the local image with `docker build -f docker/sandbox.Dockerfile -t infra-agents-sandbox:local .` and set `INFRA_AGENT_DOCKER_IMAGE=infra-agents-sandbox:local`

4. **Three long-running processes** (separate terminals, or `nohup` / a process manager):
   - **API** (from repo root): `uv run python -m infra_agent_api`  
     - JSON API and OpenAPI: **`http://127.0.0.1:8000`**, docs at **`/docs`**, **`/healthz`**. There is **no** product HTML at `/` — the browser UI lives in `apps/web`.
   - **Web (TanStack + Vite, from `apps/web`)**: `npm run dev` (or `npx vite dev --port 3000`)  
     - Default: **`http://127.0.0.1:3000`**. Set `VITE_API_BASE_URL` (see `apps/web/.env.example`, usually `http://127.0.0.1:8000`) so the app talks to the API.
   - **Worker** (from repo root): `uv run python -m infra_agent_worker`  
     - Connects to Temporal, registers `InfraAgentRunWorkflow`, maps Modal env vars when configured, and registers the selected sandbox client

All commands assume the **current working directory is the repo root** so `.env` and `alembic.ini` resolve correctly.

`apps/web` is an npm package: **`http://127.0.0.1:3000` → API `http://127.0.0.1:8000`**. The `dev` script binds Vite to **`0.0.0.0:3000`** so **`127.0.0.1`** and **`localhost`** both work. CORS in `Settings` already allows `localhost` / `127.0.0.1` with any port, so a browser on **:3000** can call the API on **:8000** as long as both processes are up.

### Start the web (what “start the web” means in automation)

Do this when the user only asks to **run the product UI** (Vite) — still create **`apps/web/.env`** if missing:

```bash
test -f apps/web/.env || cp apps/web/.env.example apps/web/.env
cd apps/web && npm install && npm run dev
# Open http://127.0.0.1:3000 — API must be on VITE_API_BASE_URL (default :8000) for the app to work
```

To exercise runs end-to-end, start the **API** and **worker** in other shells (or background jobs) *before* or *along with* the web, per **Quick copy-paste** below. The API does not serve the SPA: **`GET /` on :8000 is not the app.**

---

## Quick copy-paste: cold start

```bash
cd /path/to/infra-agents   # repo root
export PATH="$HOME/.local/bin:$PATH"  # or wherever `uv` lives
uv sync --all-packages --dev
uv run alembic upgrade head
set -a; source .env; set +a
uv run python -m infra_agent_api &
uv run python -m infra_agent_worker &
# Third shell — web (see “Start the web” above)
# cd apps/web && npm install && npm run dev
```

Then verify: `curl -sS http://127.0.0.1:8000/healthz` and open **`http://127.0.0.1:3000`**. The API is **`/docs` or `/healthz` on :8000**, not the home page of the product.

If port 8000 is in use, stop the old Uvicorn process (or use another port by changing the API code / deployment — default is 8000).

---

## What the API does *not* return (yet)

- **`GET /v1/runs/{id}`** returns the **persisted run record** (status, `temporal_workflow_id`, etc.). It does **not** embed the workflow’s final model output by default; that is produced when **Temporal** completes the workflow.
- **Final agent output** for a run: use the **Temporal** workflow for that run (e.g. `agent-run-<uuid>`) — for example the Temporal CLI `workflow result` with that workflow id — or your observability around worker/sandbox logs.

The **React app** in `apps/web` calls the HTTP API; final streaming / progress behavior is whatever that client implements. Core platform behavior: **`GET /v1/runs/{id}`** does not embed the full final model transcript unless the product layer adds that.

---

## Skilled agents (context)

- Agent behavior, repository mounts, and bundled Terraform **Skills** are configured in the platform; see [docs/bootstrap.md](docs/bootstrap.md) (OpenAI Agents SDK boundary, sandbox backends, local commands).
- Eager `Skills(from_=LocalDir(...))` materialize under `.agents/` in the sandbox as described there.

---

## When tests are enough

Unit tests and `uv run pytest` do **not** require Temporal, a sandbox backend, or a live model. Full **end-to-end** checks require the full stack above plus valid model credentials and whichever sandbox backend you select.

---

## Web: “Failed to start run” (home page toast)

`apps/web` calls `POST {VITE_API_BASE_URL}/v1/runs`. The toast is shown when that request fails. **Read the description line** (it is `API {status}: {detail}` or a network error).

| What you see | Usual cause |
|--------------|-------------|
| `Failed to fetch` / `NetworkError` / `Load failed` | The **API is not running** on the URL in `VITE_API_BASE_URL`, a firewall blocks the port, or the URL is wrong (e.g. opened the site at `http://0.0.0.0:3000` while `VITE_API_BASE_URL` is `127.0.0.1:8000` and the request is blocked; prefer **`http://127.0.0.1:3000` or `http://localhost:3000`**) — fix: start `uv run python -m infra_agent_api`, confirm `curl "$VITE_API_BASE_URL/healthz"`, and use `apps/web/.env` to match. |
| `API 503: ...Temporal...` or `failed to connect to Temporal` | **Temporal** is not listening at `INFRA_AGENT_TEMPORAL_HOST` (default `localhost:7233`), or wrong host/namespace. Start a Temporal dev server and retry. `INFRA_AGENT_ENABLE_TEMPORAL_DISPATCH` must be `true` or the API never tries Temporal (if dispatch is on and Temporal is down, you get 503). |
| `API 503: failed to start workflow` | Temporal is up but the workflow start failed (permissions, bad payload, or duplicate `workflowId`). |
| `API 500: ...` | **Database** (e.g. migrations not run: `uv run alembic upgrade head`) or a server bug — check API logs. |

A successful `POST` returns **202** and navigates to `/runs/<id>`. If the request succeeds but the **worker** is not running, the run may sit **dispatched** while the workflow does not make progress; that is a **separate** problem from the toast (start run is “started” in the API/Temporal sense).
