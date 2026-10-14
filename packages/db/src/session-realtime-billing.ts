import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { SessionRealtimeEndReason, SessionRealtimeModel } from "@opengeni/contracts";
import { withRlsContext, withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/** One provider connection of a live-voice mode, bounded by server observation. */
export type SessionRealtimeBillableConnection = {
  id: string;
  startedAt: Date;
  observedUntil: Date;
};

export type SessionRealtimeBillingFacts = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  realtimeId: string;
  model: SessionRealtimeModel;
  ownerSubjectId: string;
  state: "active" | "ended";
  connections: SessionRealtimeBillableConnection[];
};

/**
 * The last instant the server itself observed the voice owner alive. An
 * explicit owner-proven end is observed at `endedAt`; an expired lease only up
 * to its last heartbeat (late lazy settlement never extends the bill); an
 * active mode up to `now`, bounded by its lease.
 */
export function sessionRealtimeObservedUntil(
  mode: {
    state: string;
    endReason: string | null;
    endedAt: Date | null;
    lastHeartbeatAt: Date;
    leaseExpiresAt: Date;
  },
  now: Date,
): Date {
  if (mode.state === "ended") {
    const reason = mode.endReason as SessionRealtimeEndReason | null;
    if (reason !== "lease_expired" && mode.endedAt) return mode.endedAt;
    return mode.lastHeartbeatAt;
  }
  return new Date(Math.min(now.getTime(), mode.leaseExpiresAt.getTime()));
}

/**
 * Server-observed lifetime of every provider connection that was actually
 * issued (an SDP answer or a minted client secret was returned). Failed or
 * never-completed negotiations issued nothing billable.
 */
export async function loadSessionRealtimeBillingFacts(
  db: Database,
  input: { workspaceId: string; sessionId: string; realtimeId: string; now?: Date },
): Promise<SessionRealtimeBillingFacts | null> {
  const now = input.now ?? new Date();
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [mode] = await scopedDb
      .select()
      .from(schema.sessionRealtimeModes)
      .where(
        and(
          eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
          eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
          eq(schema.sessionRealtimeModes.id, input.realtimeId),
        ),
      )
      .limit(1);
    if (!mode) return null;
    const observedUntil = sessionRealtimeObservedUntil(mode, now);
    const rows = await scopedDb
      .select({
        id: schema.sessionRealtimeConnections.id,
        createdAt: schema.sessionRealtimeConnections.createdAt,
        closedAt: schema.sessionRealtimeConnections.closedAt,
      })
      .from(schema.sessionRealtimeConnections)
      .where(
        and(
          eq(schema.sessionRealtimeConnections.realtimeId, mode.id),
          isNotNull(schema.sessionRealtimeConnections.sdpAnswer),
        ),
      );
    return {
      accountId: mode.accountId,
      workspaceId: mode.workspaceId,
      sessionId: mode.sessionId,
      realtimeId: mode.id,
      model: mode.model as SessionRealtimeModel,
      ownerSubjectId: mode.ownerSubjectId,
      state: mode.state as "active" | "ended",
      connections: rows
        .map((row) => {
          const closed = row.closedAt ?? observedUntil;
          return {
            id: row.id,
            startedAt: row.createdAt,
            observedUntil: new Date(
              Math.max(
                row.createdAt.getTime(),
                Math.min(closed.getTime(), observedUntil.getTime()),
              ),
            ),
          };
        })
        .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime()),
    };
  });
}

/** Which of these usage idempotency keys are already recorded for the account. */
export async function existingUsageEventIdempotencyKeys(
  db: Database,
  input: { accountId: string; workspaceId: string; keys: readonly string[] },
): Promise<Set<string>> {
  if (input.keys.length === 0) return new Set();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select({ key: schema.usageEvents.idempotencyKey })
        .from(schema.usageEvents)
        .where(
          and(
            eq(schema.usageEvents.accountId, input.accountId),
            inArray(schema.usageEvents.idempotencyKey, [...input.keys]),
          ),
        );
      return new Set(rows.map((row) => row.key));
    },
  );
}
