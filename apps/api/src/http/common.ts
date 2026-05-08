import { getSession, type Database } from "@infra-agents/db";
import { HTTPException } from "hono/http-exception";

export function boundedLimit(raw: string | undefined): number {
  const limit = Number(raw ?? 100);
  if (!Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

export async function assertSessionExists(db: Database, sessionId: string): Promise<void> {
  if (!await getSession(db, sessionId)) {
    throw new HTTPException(404, { message: "session not found" });
  }
}
