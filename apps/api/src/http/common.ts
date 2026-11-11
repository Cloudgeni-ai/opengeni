import { getSessionEventSequence, type Database } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

export function boundedLimit(raw: string | undefined): number {
  const limit = Number(raw ?? 100);
  if (!Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

export async function assertSessionExists(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  await requireSessionSequence(db, workspaceId, sessionId);
}

/**
 * Response header naming the session event sequence a read reflects. The
 * session row is read BEFORE the projection, so every event at or below this
 * sequence was committed before the projection was read: a client that loaded
 * the event log separately refreshes the projection only for a later event.
 */
export const SESSION_SEQUENCE_HEADER = "X-OpenGeni-Session-Sequence";

/** 404 unless the session exists; otherwise its current event sequence. */
export async function requireSessionSequence(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  const sequence = await getSessionEventSequence(db, workspaceId, sessionId);
  if (sequence === null) {
    throw new HTTPException(404, { message: "session not found" });
  }
  return sequence;
}
