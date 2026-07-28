import { createHash, timingSafeEqual } from "node:crypto";

import type {
  SessionEventType,
  SessionRealtimeEndReason,
  SessionRealtimeMode,
  SessionRealtimeModel,
} from "@opengeni/contracts";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { sanitizeEventPayload } from "./event-payload-sanitizer";
import type { Database } from "./index";
import {
  evaluateSessionControl,
  lockSessionEventWriteRows,
  registerSessionWorkflowWakeInTransaction,
} from "./session-control";
import * as schema from "./schema";

export const SESSION_REALTIME_LEASE_MS = 30_000;
const SESSION_REALTIME_MIN_LEASE_MS = 5_000;
const SESSION_REALTIME_MAX_LEASE_MS = 120_000;

export type SessionRealtimeConflictCode =
  | "SESSION_CANCELLED"
  | "SESSION_NOT_IDLE"
  | "QUEUED_PROMPT"
  | "PENDING_HUMAN_INPUT"
  | "PENDING_APPROVAL"
  | "CONTROL_NOT_ACTIVE"
  | "REALTIME_ACTIVE"
  | "REALTIME_NOT_FOUND"
  | "REALTIME_NOT_ACTIVE"
  | "REALTIME_OWNER_MISMATCH"
  | "REALTIME_VERSION_CHANGED"
  | "REALTIME_CONNECTION_CHANGED"
  | "REALTIME_CONNECTION_ACTIVE"
  | "REALTIME_CONNECTION_NOT_FOUND"
  | "REALTIME_CONNECTION_STATE_CHANGED"
  | "REALTIME_ACK_INVALID";

export class SessionRealtimeConflictError extends Error {
  readonly name = "SessionRealtimeConflictError";

  constructor(
    readonly code: SessionRealtimeConflictCode,
    message: string,
  ) {
    super(message);
  }
}

type RealtimeRow = typeof schema.sessionRealtimeModes.$inferSelect;
type SessionRow = typeof schema.sessions.$inferSelect;

export type BeginSessionRealtimeInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  operationId: string;
  ownerSubjectId: string;
  browserInstanceId: string;
  ownerKey: string;
  model: SessionRealtimeModel;
  now?: Date;
  leaseMs?: number;
};

export type RenewSessionRealtimeInput = {
  workspaceId: string;
  sessionId: string;
  realtimeId: string;
  ownerSubjectId: string;
  browserInstanceId: string;
  ownerKey: string;
  expectedVersion: number;
  now?: Date;
  leaseMs?: number;
};

export type EndSessionRealtimeInput = Omit<RenewSessionRealtimeInput, "leaseMs"> & {
  reason: Extract<SessionRealtimeEndReason, "user_stop" | "browser_unload">;
};

export type AssertSessionRealtimeOwnerInput = Omit<RenewSessionRealtimeInput, "leaseMs">;

export type SessionRealtimeMutationResult = {
  mode: SessionRealtimeMode;
  replay: boolean;
  eventIds: string[];
  workflowWakeRevision: number | null;
};

export type RenewSessionRealtimeResult = SessionRealtimeMutationResult & {
  expired: boolean;
};

export type ActiveSessionRealtime = {
  id: string;
  leaseExpiresAt: Date;
  version: number;
};

function hashOwnerKey(ownerKey: string): string {
  return createHash("sha256").update(ownerKey).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function leaseExpiry(now: Date, leaseMs = SESSION_REALTIME_LEASE_MS): Date {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < SESSION_REALTIME_MIN_LEASE_MS ||
    leaseMs > SESSION_REALTIME_MAX_LEASE_MS
  ) {
    throw new Error("Realtime lease duration is outside server bounds");
  }
  return new Date(now.getTime() + leaseMs);
}

function mapRealtimeMode(row: RealtimeRow): SessionRealtimeMode {
  return {
    id: row.id,
    sessionId: row.sessionId,
    operationId: row.operationId,
    browserInstanceId: row.browserInstanceId,
    model: row.model as SessionRealtimeModel,
    state: row.state as SessionRealtimeMode["state"],
    version: row.version,
    connectionEpoch: row.connectionEpoch,
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason as SessionRealtimeEndReason | null,
  };
}

function assertOwner(
  row: RealtimeRow,
  input: {
    ownerSubjectId: string;
    browserInstanceId: string;
    ownerKey: string;
  },
): void {
  if (
    row.ownerSubjectId !== input.ownerSubjectId ||
    row.browserInstanceId !== input.browserInstanceId ||
    !sameHash(row.ownerKeyHash, hashOwnerKey(input.ownerKey))
  ) {
    throw new SessionRealtimeConflictError(
      "REALTIME_OWNER_MISMATCH",
      "Realtime mode belongs to another authenticated browser owner",
    );
  }
}

async function appendRealtimeLifecycleEvent(
  db: Database,
  session: SessionRow,
  sequence: number,
  type: Extract<SessionEventType, "session.realtime.started" | "session.realtime.ended">,
  payload: Record<string, unknown>,
  now: Date,
) {
  // Keep the sole lifecycle event writer independently on the canonical
  // control/workspace/session prefix. Current callers already own these locks,
  // so this is a nonblocking re-acquisition that also prevents a future caller
  // from inserting a sequence row without the required session fence.
  await lockSessionEventWriteRows(db, {
    workspaceId: session.workspaceId,
    controlLock: "share",
    sessionIds: [session.id],
  });
  const [event] = await db
    .insert(schema.sessionEvents)
    .values({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      sequence,
      type,
      payload: sanitizeEventPayload(payload),
      occurredAt: now,
    })
    .returning();
  if (!event) throw new Error(`Failed to append ${type}`);
  await db
    .update(schema.sessions)
    .set({ lastSequence: sequence, updatedAt: now })
    .where(
      and(eq(schema.sessions.workspaceId, session.workspaceId), eq(schema.sessions.id, session.id)),
    );
  return event;
}

async function loadActiveRowForUpdate(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<RealtimeRow | null> {
  const [row] = await db
    .select()
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.workspaceId, workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, sessionId),
        eq(schema.sessionRealtimeModes.state, "active"),
      ),
    )
    .orderBy(asc(schema.sessionRealtimeModes.createdAt), asc(schema.sessionRealtimeModes.id))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function endRow(
  db: Database,
  row: RealtimeRow,
  reason: SessionRealtimeEndReason,
  now: Date,
): Promise<RealtimeRow> {
  const [ended] = await db
    .update(schema.sessionRealtimeModes)
    .set({
      state: "ended",
      version: row.version + 1,
      endedAt: now,
      endReason: reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionRealtimeModes.id, row.id),
        eq(schema.sessionRealtimeModes.state, "active"),
        eq(schema.sessionRealtimeModes.version, row.version),
      ),
    )
    .returning();
  if (!ended) throw new Error("Realtime owner changed while ending mode");
  return ended;
}

async function registerNormalModeWake(db: Database, session: SessionRow, reason: string) {
  return await registerSessionWorkflowWakeInTransaction(db, {
    accountId: session.accountId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    temporalWorkflowId: session.temporalWorkflowId ?? `session-${session.id}`,
    reason,
  });
}

async function endWithEvent(
  db: Database,
  session: SessionRow,
  row: RealtimeRow,
  reason: SessionRealtimeEndReason,
  now: Date,
): Promise<{
  mode: SessionRealtimeMode;
  eventId: string;
  workflowWakeRevision: number;
  session: SessionRow;
}> {
  const ended = await endRow(db, row, reason, now);
  await db
    .update(schema.sessionRealtimeConnections)
    .set({ state: "closed", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.sessionRealtimeConnections.realtimeId, row.id),
        inArray(schema.sessionRealtimeConnections.state, ["negotiating", "active"]),
      ),
    );
  const event = await appendRealtimeLifecycleEvent(
    db,
    session,
    session.lastSequence + 1,
    "session.realtime.ended",
    {
      realtimeId: ended.id,
      operationId: ended.operationId,
      reason,
      version: ended.version,
      connectionEpoch: ended.connectionEpoch,
    },
    now,
  );
  const workflowWakeRevision = await registerNormalModeWake(db, session, `realtime_${reason}`);
  return {
    mode: mapRealtimeMode(ended),
    eventId: event.id,
    workflowWakeRevision,
    session: { ...session, lastSequence: event.sequence, updatedAt: now },
  };
}

async function lockRealtimeSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<{
  session: SessionRow;
  control: Awaited<ReturnType<typeof evaluateSessionControl>>;
}> {
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId,
    controlLock: "share",
    sessionIds: [sessionId],
  });
  const session = locks.sessions[0];
  if (!session) {
    throw new SessionRealtimeConflictError("REALTIME_NOT_FOUND", "Session not found");
  }
  const control = await evaluateSessionControl(db, workspaceId, sessionId, {
    workspaceControl: locks.control ?? undefined,
  });
  return { session, control };
}

async function assertRealtimeAdmission(db: Database, session: SessionRow): Promise<void> {
  if (session.status === "cancelled") {
    throw new SessionRealtimeConflictError(
      "SESSION_CANCELLED",
      "Cancelled session cannot enter realtime mode",
    );
  }
  if (session.activeTurnId !== null) {
    throw new SessionRealtimeConflictError(
      "SESSION_NOT_IDLE",
      "Session has active or requires-action work",
    );
  }
  const [liveAttempt] = await db
    .select({ id: schema.sessionTurnAttempts.id })
    .from(schema.sessionTurnAttempts)
    .where(
      and(
        eq(schema.sessionTurnAttempts.workspaceId, session.workspaceId),
        eq(schema.sessionTurnAttempts.sessionId, session.id),
        inArray(schema.sessionTurnAttempts.state, ["claimed", "running"]),
      ),
    )
    .limit(1);
  if (liveAttempt) {
    throw new SessionRealtimeConflictError(
      "SESSION_NOT_IDLE",
      "Session still has an admitted ordinary work owner",
    );
  }
  const [queuedPrompt] = await db
    .select({ id: schema.sessionTurns.id })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, session.workspaceId),
        eq(schema.sessionTurns.sessionId, session.id),
        eq(schema.sessionTurns.status, "queued"),
        inArray(schema.sessionTurns.source, ["user", "api"]),
      ),
    )
    .limit(1);
  if (queuedPrompt) {
    throw new SessionRealtimeConflictError("QUEUED_PROMPT", "Session has a queued human prompt");
  }
  const [humanInput] = await db
    .select({ id: schema.sessionHumanInputRequests.id })
    .from(schema.sessionHumanInputRequests)
    .where(
      and(
        eq(schema.sessionHumanInputRequests.workspaceId, session.workspaceId),
        eq(schema.sessionHumanInputRequests.sessionId, session.id),
        eq(schema.sessionHumanInputRequests.status, "pending"),
      ),
    )
    .limit(1);
  if (humanInput) {
    throw new SessionRealtimeConflictError(
      "PENDING_HUMAN_INPUT",
      "Session has unresolved human input",
    );
  }
  const [approval] = await db
    .select({ id: schema.agentRunStates.id })
    .from(schema.agentRunStates)
    .where(
      and(
        eq(schema.agentRunStates.workspaceId, session.workspaceId),
        eq(schema.agentRunStates.sessionId, session.id),
        sql`jsonb_array_length(${schema.agentRunStates.pendingApprovals}) > 0`,
      ),
    )
    .limit(1);
  if (approval) {
    throw new SessionRealtimeConflictError(
      "PENDING_APPROVAL",
      "Session has unresolved tool approval",
    );
  }
}

export async function beginSessionRealtimeInTransaction(
  db: Database,
  input: BeginSessionRealtimeInput,
): Promise<SessionRealtimeMutationResult> {
  const now = input.now ?? new Date();
  let { session, control } = await lockRealtimeSession(db, input.workspaceId, input.sessionId);
  if (session.accountId !== input.accountId) {
    throw new SessionRealtimeConflictError("REALTIME_NOT_FOUND", "Session not found");
  }

  let active = await loadActiveRowForUpdate(db, input.workspaceId, input.sessionId);
  const eventIds: string[] = [];
  let workflowWakeRevision: number | null = null;
  if (active && active.leaseExpiresAt <= now) {
    const expired = await endWithEvent(db, session, active, "lease_expired", now);
    session = expired.session;
    eventIds.push(expired.eventId);
    workflowWakeRevision = expired.workflowWakeRevision;
    active = null;
  }

  const [operation] = await db
    .select()
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
        eq(schema.sessionRealtimeModes.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (operation) {
    assertOwner(operation, input);
    if (operation.model !== input.model) {
      throw new SessionRealtimeConflictError(
        "REALTIME_OWNER_MISMATCH",
        "Realtime operation was already used with different input",
      );
    }
    return {
      mode: mapRealtimeMode(operation),
      replay: true,
      eventIds,
      workflowWakeRevision,
    };
  }
  if (active) {
    throw new SessionRealtimeConflictError(
      "REALTIME_ACTIVE",
      "Session already has an active realtime owner",
    );
  }
  if (control.state !== "active") {
    throw new SessionRealtimeConflictError(
      "CONTROL_NOT_ACTIVE",
      "Session control must be active before realtime starts",
    );
  }
  await assertRealtimeAdmission(db, session);

  const [row] = await db
    .insert(schema.sessionRealtimeModes)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      ownerSubjectId: input.ownerSubjectId,
      browserInstanceId: input.browserInstanceId,
      ownerKeyHash: hashOwnerKey(input.ownerKey),
      model: input.model,
      state: "active",
      version: 1,
      connectionEpoch: 1,
      leaseExpiresAt: leaseExpiry(now, input.leaseMs),
      lastHeartbeatAt: now,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("Failed to start realtime mode");
  const event = await appendRealtimeLifecycleEvent(
    db,
    session,
    session.lastSequence + 1,
    "session.realtime.started",
    {
      realtimeId: row.id,
      operationId: row.operationId,
      model: row.model,
      version: row.version,
      connectionEpoch: row.connectionEpoch,
      leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    },
    now,
  );
  eventIds.push(event.id);
  return {
    mode: mapRealtimeMode(row),
    replay: false,
    eventIds,
    workflowWakeRevision: null,
  };
}

async function loadOwnedRealtimeRow(
  db: Database,
  input: RenewSessionRealtimeInput,
): Promise<RealtimeRow> {
  const [row] = await db
    .select()
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
        eq(schema.sessionRealtimeModes.id, input.realtimeId),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) {
    throw new SessionRealtimeConflictError("REALTIME_NOT_FOUND", "Realtime mode not found");
  }
  assertOwner(row, input);
  return row;
}

/**
 * Fence a provider connection to the exact active authenticated browser owner.
 * The caller must finish this transaction before contacting the provider; owner
 * proof is authorization material and must never cross that boundary.
 */
export async function assertSessionRealtimeOwnerInTransaction(
  db: Database,
  input: AssertSessionRealtimeOwnerInput,
): Promise<SessionRealtimeMode> {
  const now = input.now ?? new Date();
  await lockRealtimeSession(db, input.workspaceId, input.sessionId);
  const row = await loadOwnedRealtimeRow(db, input);
  if (row.state !== "active" || row.leaseExpiresAt <= now) {
    throw new SessionRealtimeConflictError(
      "REALTIME_NOT_ACTIVE",
      "Realtime mode is no longer active",
    );
  }
  if (row.version !== input.expectedVersion) {
    throw new SessionRealtimeConflictError(
      "REALTIME_VERSION_CHANGED",
      "Realtime lease version changed",
    );
  }
  return mapRealtimeMode(row);
}

export async function renewSessionRealtimeInTransaction(
  db: Database,
  input: RenewSessionRealtimeInput,
): Promise<RenewSessionRealtimeResult> {
  const now = input.now ?? new Date();
  const { session } = await lockRealtimeSession(db, input.workspaceId, input.sessionId);
  const row = await loadOwnedRealtimeRow(db, input);
  if (row.state === "ended") {
    return {
      mode: mapRealtimeMode(row),
      replay: true,
      eventIds: [],
      workflowWakeRevision: null,
      expired: row.endReason === "lease_expired",
    };
  }
  if (row.version !== input.expectedVersion) {
    throw new SessionRealtimeConflictError(
      "REALTIME_VERSION_CHANGED",
      "Realtime lease version changed",
    );
  }
  if (row.leaseExpiresAt <= now) {
    const expired = await endWithEvent(db, session, row, "lease_expired", now);
    return {
      mode: expired.mode,
      replay: false,
      eventIds: [expired.eventId],
      workflowWakeRevision: expired.workflowWakeRevision,
      expired: true,
    };
  }
  const [renewed] = await db
    .update(schema.sessionRealtimeModes)
    .set({
      version: row.version + 1,
      leaseExpiresAt: leaseExpiry(now, input.leaseMs),
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionRealtimeModes.id, row.id),
        eq(schema.sessionRealtimeModes.state, "active"),
        eq(schema.sessionRealtimeModes.version, row.version),
      ),
    )
    .returning();
  if (!renewed) {
    throw new SessionRealtimeConflictError(
      "REALTIME_VERSION_CHANGED",
      "Realtime lease version changed",
    );
  }
  return {
    mode: mapRealtimeMode(renewed),
    replay: false,
    eventIds: [],
    workflowWakeRevision: null,
    expired: false,
  };
}

export async function endSessionRealtimeInTransaction(
  db: Database,
  input: EndSessionRealtimeInput,
): Promise<SessionRealtimeMutationResult> {
  const now = input.now ?? new Date();
  const { session } = await lockRealtimeSession(db, input.workspaceId, input.sessionId);
  const row = await loadOwnedRealtimeRow(db, input);
  if (row.state === "ended") {
    return {
      mode: mapRealtimeMode(row),
      replay: true,
      eventIds: [],
      workflowWakeRevision: null,
    };
  }
  if (row.version !== input.expectedVersion) {
    throw new SessionRealtimeConflictError(
      "REALTIME_VERSION_CHANGED",
      "Realtime lease version changed",
    );
  }
  const reason: SessionRealtimeEndReason =
    row.leaseExpiresAt <= now ? "lease_expired" : input.reason;
  const ended = await endWithEvent(db, session, row, reason, now);
  return {
    mode: ended.mode,
    replay: false,
    eventIds: [ended.eventId],
    workflowWakeRevision: ended.workflowWakeRevision,
  };
}

/** Called after the canonical session row is locked by a normal command. */
export async function sessionRealtimeIsActiveInTransaction(
  db: Database,
  workspaceId: string,
  sessionId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.sessionRealtimeModes.id })
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.workspaceId, workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, sessionId),
        eq(schema.sessionRealtimeModes.state, "active"),
        gt(schema.sessionRealtimeModes.leaseExpiresAt, now),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Final ordinary-work claim fence, called under the canonical session lock. */
export async function fenceSessionWorkClaimForRealtimeInTransaction(
  db: Database,
  session: SessionRow,
  now = new Date(),
): Promise<{ active: ActiveSessionRealtime | null; session: SessionRow }> {
  const row = await loadActiveRowForUpdate(db, session.workspaceId, session.id);
  if (!row) return { active: null, session };
  if (row.leaseExpiresAt > now) {
    return {
      active: { id: row.id, leaseExpiresAt: row.leaseExpiresAt, version: row.version },
      session,
    };
  }
  const expired = await endWithEvent(db, session, row, "lease_expired", now);
  return { active: null, session: expired.session };
}

export async function peekActiveSessionRealtime(
  db: Database,
  workspaceId: string,
  sessionId: string,
  now = new Date(),
): Promise<ActiveSessionRealtime | null> {
  const [row] = await db
    .select({
      id: schema.sessionRealtimeModes.id,
      leaseExpiresAt: schema.sessionRealtimeModes.leaseExpiresAt,
      version: schema.sessionRealtimeModes.version,
    })
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.workspaceId, workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, sessionId),
        eq(schema.sessionRealtimeModes.state, "active"),
        gt(schema.sessionRealtimeModes.leaseExpiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}
