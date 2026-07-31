#!/usr/bin/env bash
# Keep the mega stream seed running. Restarts on any exit until killed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${LOG_DIR:-/tmp/opengeni-ui-work}"
mkdir -p "$LOG_DIR"

: "${OPENGENI_DATABASE_URL:?}"
: "${OPENGENI_NATS_URL:?}"
: "${OPENGENI_SEED_WORKSPACE_ID:?}"
: "${OPENGENI_SEED_SESSION_ID:?}"
: "${OPENGENI_SEED_BASE_URL:?}"
: "${OPENGENI_SEED_WEB_URL:?}"

echo $$ >"$LOG_DIR/stream-loop.pid"
echo "[stream-loop] watching ${OPENGENI_SEED_WEB_URL}/workspaces/${OPENGENI_SEED_WORKSPACE_ID}/sessions/${OPENGENI_SEED_SESSION_ID}"

idle_session() {
  # Bounded — a stuck DB/RLS call must not block the stream forever.
  timeout 8 env \
    OPENGENI_DATABASE_URL="$OPENGENI_DATABASE_URL" \
    OPENGENI_SEED_BASE_URL="$OPENGENI_SEED_BASE_URL" \
    WS="$OPENGENI_SEED_WORKSPACE_ID" SID="$OPENGENI_SEED_SESSION_ID" \
    bun --env-file=/dev/null -e '
import { createDb, withRlsContext, getSession } from "@opengeni/db";
import { and, eq } from "drizzle-orm";
import { sessions } from "@opengeni/db/schema";
const workspaceId = process.env.WS!;
const sessionId = process.env.SID!;
const client = createDb(process.env.OPENGENI_DATABASE_URL!);
try {
  const me = await fetch(`${process.env.OPENGENI_SEED_BASE_URL}/v1/access/me`).then((r) => r.json());
  if (!(await getSession(client.db, workspaceId, sessionId))) {
    console.error("[stream-loop] session missing", workspaceId, sessionId);
    process.exit(2);
  }
  await withRlsContext(client.db, { accountId: me.accountGrants[0].accountId, workspaceId }, async (scoped) => {
    await scoped.update(sessions).set({ status: "idle", updatedAt: new Date() })
      .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.id, sessionId)));
  });
} finally {
  await client.close();
}
' >>"$LOG_DIR/stream.log" 2>&1
}

while true; do
  # Wait for API before each attempt.
  for _ in $(seq 1 30); do
    if curl -sS -m 1 "$OPENGENI_SEED_BASE_URL/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  idle_session || echo "[stream-loop] idle step failed/timed out — starting anyway" | tee -a "$LOG_DIR/stream.log"

  echo "[stream-loop] $(date '+%H:%M:%S') starting stream-session-events" | tee -a "$LOG_DIR/stream.log"
  bun --env-file=/dev/null "$ROOT/test/e2e/seed/stream-session-events.ts" \
    >>"$LOG_DIR/stream.log" 2>&1 &
  child=$!
  echo "$child" >"$LOG_DIR/stream.pid"
  wait "$child"
  code=$?
  echo "[stream-loop] $(date '+%H:%M:%S') exited code=$code — restart in 1s" | tee -a "$LOG_DIR/stream.log"
  sleep 1
done
