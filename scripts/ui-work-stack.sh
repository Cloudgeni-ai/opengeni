#!/usr/bin/env bash
# Durable local stack + mega stream for the opengeni-ui-work checkout.
# Pins app ports away from the default 8000/3000 so other worktrees can coexist.
# Usage: bash scripts/ui-work-stack.sh
# Prefer: tmux new-session -d -s opengeni-ui-work "bash scripts/ui-work-stack.sh"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then set -a; # shellcheck disable=SC1091
  . ./.env
  set +a
fi
if [ -f .env.runtime ]; then set -a; # shellcheck disable=SC1091
  . ./.env.runtime
  set +a
fi

export OPENGENI_API_PORT="${OPENGENI_API_PORT:-8100}"
export OPENGENI_WEB_PORT="${OPENGENI_WEB_PORT:-3100}"
export OPENGENI_WORKER_HTTP_PORT="${OPENGENI_WORKER_HTTP_PORT:-8101}"
export OPENGENI_TURN_WORKER_HTTP_PORT="${OPENGENI_TURN_WORKER_HTTP_PORT:-8102}"
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://127.0.0.1:${OPENGENI_API_PORT}}"
export OPENGENI_SANDBOX_BACKEND="${OPENGENI_SANDBOX_BACKEND:-none}"
export OPENGENI_DATABASE_URL="${OPENGENI_DATABASE_URL:?missing OPENGENI_DATABASE_URL (run bun run dev once or set .env.runtime)}"
export OPENGENI_NATS_URL="${OPENGENI_NATS_URL:?missing OPENGENI_NATS_URL}"
export OPENGENI_TEMPORAL_HOST="${OPENGENI_TEMPORAL_HOST:-127.0.0.1:8236}"

LOG_DIR="${LOG_DIR:-/tmp/opengeni-ui-work}"
mkdir -p "$LOG_DIR"
WS="${OPENGENI_SEED_WORKSPACE_ID:-9faae847-d440-4f9f-afb5-44a45005d1c4}"
SID="${OPENGENI_SEED_SESSION_ID:-95d8c854-5858-420d-9f35-656fbd5841b6}"

echo "[ui-work] root=$ROOT"
echo "[ui-work] api=:${OPENGENI_API_PORT} web=:${OPENGENI_WEB_PORT} db=${OPENGENI_DATABASE_URL}"

docker start opengeni-ui-work-postgres-1 opengeni-ui-work-nats-1 opengeni-ui-work-temporal-1 opengeni-ui-work-minio-1 >/dev/null 2>&1 || true

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

start_if_needed() {
  local name="$1"
  local port="$2"
  shift 2
  if port_in_use "$port"; then
    echo "[ui-work] $name already on :$port"
    return 0
  fi
  echo "[ui-work] starting $name on :$port"
  nohup env "$@" >/dev/null 2>&1 &
  echo $! >"$LOG_DIR/$name.pid"
}

# Kill stale listeners only if they belong to this worktree.
for port in "$OPENGENI_API_PORT" "$OPENGENI_WEB_PORT"; do
  if port_in_use "$port"; then
    pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | head -1 || true)"
    cwd="$(lsof -a -p "$pid" -d cwd 2>/dev/null | awk 'NR==2{print $NF}')"
    case "$cwd" in
      *opengeni-ui-work*)
        echo "[ui-work] recycling stale $cwd pid=$pid on :$port"
        kill "$pid" 2>/dev/null || true
        sleep 0.3
        ;;
    esac
  fi
done

if ! port_in_use "$OPENGENI_API_PORT"; then
  nohup env \
    OPENGENI_DATABASE_URL="$OPENGENI_DATABASE_URL" \
    OPENGENI_NATS_URL="$OPENGENI_NATS_URL" \
    OPENGENI_TEMPORAL_HOST="$OPENGENI_TEMPORAL_HOST" \
    OPENGENI_API_PORT="$OPENGENI_API_PORT" \
    OPENGENI_WORKER_HTTP_PORT="$OPENGENI_WORKER_HTTP_PORT" \
    OPENGENI_OBJECT_STORAGE_ENDPOINT="${OPENGENI_OBJECT_STORAGE_ENDPOINT:-}" \
    OPENGENI_SANDBOX_BACKEND="$OPENGENI_SANDBOX_BACKEND" \
    bun --env-file=/dev/null run --bun "$ROOT/apps/api/src/index.ts" \
    >"$LOG_DIR/api.log" 2>&1 &
  echo $! >"$LOG_DIR/api.pid"
fi

if ! pgrep -f "opengeni-ui-work/apps/worker.*OPENGENI_WORKER_ROLE=control|WORKER_ROLE=control.*opengeni-ui-work" >/dev/null 2>&1; then
  # Workers don't bind a unique easy port check — start if none from this tree.
  if ! pgrep -f "$ROOT/apps/worker" >/dev/null 2>&1; then
    nohup env \
      OPENGENI_DATABASE_URL="$OPENGENI_DATABASE_URL" \
      OPENGENI_NATS_URL="$OPENGENI_NATS_URL" \
      OPENGENI_TEMPORAL_HOST="$OPENGENI_TEMPORAL_HOST" \
      OPENGENI_WORKER_ROLE=control \
      OPENGENI_WORKER_HTTP_PORT="$OPENGENI_WORKER_HTTP_PORT" \
      OPENGENI_SANDBOX_BACKEND="$OPENGENI_SANDBOX_BACKEND" \
      bun --env-file=/dev/null run --bun "$ROOT/apps/worker/src/index.ts" \
      >"$LOG_DIR/worker-control.log" 2>&1 &
    echo $! >"$LOG_DIR/worker-control.pid"

    nohup env \
      OPENGENI_DATABASE_URL="$OPENGENI_DATABASE_URL" \
      OPENGENI_NATS_URL="$OPENGENI_NATS_URL" \
      OPENGENI_TEMPORAL_HOST="$OPENGENI_TEMPORAL_HOST" \
      OPENGENI_WORKER_ROLE=turn \
      OPENGENI_WORKER_HTTP_PORT="$OPENGENI_TURN_WORKER_HTTP_PORT" \
      OPENGENI_SANDBOX_BACKEND="$OPENGENI_SANDBOX_BACKEND" \
      bun --env-file=/dev/null run --bun "$ROOT/apps/worker/src/index.ts" \
      >"$LOG_DIR/worker-turn.log" 2>&1 &
    echo $! >"$LOG_DIR/worker-turn.pid"
  fi
fi

if ! port_in_use "$OPENGENI_WEB_PORT"; then
  nohup bash -c "cd \"$ROOT/apps/web\" && VITE_API_BASE_URL=\"$VITE_API_BASE_URL\" bunx vite dev --port \"$OPENGENI_WEB_PORT\" --host 127.0.0.1" \
    >"$LOG_DIR/web.log" 2>&1 &
  echo $! >"$LOG_DIR/web.pid"
fi

echo "[ui-work] waiting for API…"
for _ in $(seq 1 60); do
  if curl -sS -m 1 "http://127.0.0.1:${OPENGENI_API_PORT}/healthz" >/dev/null 2>&1; then
    echo "[ui-work] API up"
    break
  fi
  sleep 0.5
done
curl -sS -m 2 "http://127.0.0.1:${OPENGENI_API_PORT}/healthz" >/dev/null \
  || { echo "[ui-work] API failed"; tail -40 "$LOG_DIR/api.log"; exit 1; }

for _ in $(seq 1 40); do
  code="$(curl -sS -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${OPENGENI_WEB_PORT}/" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    echo "[ui-work] web up"
    break
  fi
  sleep 0.5
done

# Ensure stream target session exists and is idle (no real model turn).
OPENGENI_DATABASE_URL="$OPENGENI_DATABASE_URL" \
OPENGENI_SEED_BASE_URL="http://127.0.0.1:${OPENGENI_API_PORT}" \
WS="$WS" SID="$SID" \
bun --env-file=/dev/null -e '
import { createDb, createSession, getSession, withRlsContext } from "@opengeni/db";
import { and, eq } from "drizzle-orm";
import { sessions } from "@opengeni/db/schema";

const databaseUrl = process.env.OPENGENI_DATABASE_URL!;
const base = process.env.OPENGENI_SEED_BASE_URL!;
let workspaceId = process.env.WS!;
let sessionId = process.env.SID!;
const { db } = createDb(databaseUrl);
const me = (await fetch(`${base}/v1/access/me`).then((r) => r.json())) as {
  defaultWorkspaceId: string;
  accountGrants: { accountId: string }[];
};
workspaceId = me.defaultWorkspaceId || workspaceId;
const accountId = me.accountGrants[0]!.accountId;
let session = sessionId ? await getSession(db, workspaceId, sessionId) : null;
if (!session) {
  session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "tip-ink mega stream seed",
    resources: [],
    metadata: { origin: "stream-seed" },
    model: "scripted-model",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: "dev", label: "Stream seed" },
  });
  sessionId = session.id;
}
await withRlsContext(db, { accountId, workspaceId }, async (scoped) => {
  await scoped
    .update(sessions)
    .set({ status: "idle", updatedAt: new Date() })
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.id, sessionId)));
});
console.log(`${workspaceId} ${sessionId}`);
' | tee "$LOG_DIR/seed-ids.txt"
read -r WS SID <"$LOG_DIR/seed-ids.txt"

pkill -f "$ROOT/test/e2e/seed/stream-session-events.ts" 2>/dev/null || true
pkill -f "$ROOT/scripts/ui-work-stream-loop.sh" 2>/dev/null || true
sleep 0.2

LINK="http://127.0.0.1:${OPENGENI_WEB_PORT}/workspaces/${WS}/sessions/${SID}"
echo "$LINK" >"$LOG_DIR/session.url"
echo "[ui-work] READY"
echo "[ui-work] open: $LINK"
echo "[ui-work] logs: $LOG_DIR"
echo "[ui-work] mega stream watchdog (auto-restart) → workspace=$WS session=$SID"

# Forever-restart the seed so a crash/SIGHUP cannot leave the timeline idle.
export OPENGENI_SEED_WORKSPACE_ID="$WS"
export OPENGENI_SEED_SESSION_ID="$SID"
export OPENGENI_SEED_BASE_URL="http://127.0.0.1:${OPENGENI_API_PORT}"
export OPENGENI_SEED_WEB_URL="http://127.0.0.1:${OPENGENI_WEB_PORT}"
export OPENGENI_SEED_STREAM_TOKEN_MS="${OPENGENI_SEED_STREAM_TOKEN_MS:-28}"
export OPENGENI_SEED_STREAM_BURST_MS="${OPENGENI_SEED_STREAM_BURST_MS:-160}"
export OPENGENI_SEED_STREAM_TURN_MS="${OPENGENI_SEED_STREAM_TURN_MS:-900}"
export OPENGENI_DATABASE_URL OPENGENI_NATS_URL
exec bash "$ROOT/scripts/ui-work-stream-loop.sh"
