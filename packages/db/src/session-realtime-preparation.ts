import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { Database } from "./database";
import { sessionRealtimeConnections, sessionRealtimeModes } from "./schema";

/** Caller holds the session write lock. An unaccepted call has no lifecycle event. */
export async function endSessionRealtimePreparationsInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    callId?: string;
    exceptModeId?: string;
    exceptDevice?: string;
    expiredBefore?: Date;
    reason: "browser_unload" | "lease_expired" | "authority_revoked";
    now: Date;
  },
): Promise<void> {
  const ended = await db
    .update(sessionRealtimeModes)
    .set({
      state: "ended",
      endReason: input.reason,
      endedAt: input.now,
      updatedAt: input.now,
      version: sql`${sessionRealtimeModes.version} + 1`,
    })
    .where(
      and(
        eq(sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(sessionRealtimeModes.sessionId, input.sessionId),
        eq(sessionRealtimeModes.state, "preparing"),
        input.callId ? eq(sessionRealtimeModes.incomingCallId, input.callId) : undefined,
        input.exceptModeId ? ne(sessionRealtimeModes.id, input.exceptModeId) : undefined,
        input.exceptDevice
          ? sql`${sessionRealtimeModes.incomingCallDevice} is distinct from ${input.exceptDevice}`
          : undefined,
        input.expiredBefore
          ? lte(sessionRealtimeModes.leaseExpiresAt, input.expiredBefore)
          : undefined,
      ),
    )
    .returning({ id: sessionRealtimeModes.id });
  if (ended.length === 0) return;
  await db
    .update(sessionRealtimeConnections)
    .set({
      state: "closed",
      closedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        inArray(
          sessionRealtimeConnections.realtimeId,
          ended.map((mode) => mode.id),
        ),
        inArray(sessionRealtimeConnections.state, ["negotiating", "ready", "active"]),
      ),
    );
}
