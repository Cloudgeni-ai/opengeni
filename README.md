# infra-agents

TypeScript/Bun infra-agent platform using:

- Hono for the API
- React/Vite for the web app
- Temporal for durable orchestration
- OpenAI Agents SDK for the agent runtime and sandbox agents
- Drizzle/Postgres for durable session and event storage
- Core NATS for low-latency realtime fanout

## Local Stack

```bash
bun install
docker compose up -d postgres nats temporal
bun run db:migrate
docker build -f docker/sandbox.Dockerfile -t infra-agents-sandbox:local .
cp .env.example .env
bun run dev:api
bun run dev:worker
bun run dev:web
```

Open:

- Web: `http://127.0.0.1:3000`
- API health: `http://127.0.0.1:8000/healthz`
- NATS monitor: `http://127.0.0.1:8222`

## Runtime Model

Clients create sessions and send commands through the Hono API. Session events are persisted in Postgres and published through Core NATS. API instances subscribe to NATS for active sessions and fan out events to browser clients over SSE.

Temporal owns orchestration, queueing, approval waits, and cancellation. Agent execution runs in non-retryable activities because model calls, sandbox commands, and tools are side-effectful. If an activity fails mid-turn, the session is marked failed instead of automatically replaying the whole agent segment.

The worker persists OpenAI Agents SDK run state after every turn, so follow-ups keep conversation history and sandbox session state. Docker/Modal sandboxes receive explicitly allowed credential env vars; Azure CLI auth uses normal `az login --service-principal` preflight when ARM/AZURE service-principal variables are present.

## Public API

- `POST /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `GET /v1/sessions/:sessionId/events`
- `GET /v1/sessions/:sessionId/events/stream`
- `POST /v1/sessions/:sessionId/events`
- `GET /v1/config/client`
- `GET /v1/github/app`
- `GET /v1/github/repositories`
- `POST /v1/github/app-manifest`
- `GET /v1/github/app-manifest/callback`

## Verification

```bash
bun run typecheck
bun test
```
