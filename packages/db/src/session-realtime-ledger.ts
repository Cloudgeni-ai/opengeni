import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { sanitizeEventPayload, sanitizeModelPayload } from "./event-payload-sanitizer";
import type { Database } from "./index";
import * as schema from "./schema";
import {
  assertSessionRealtimeOwnerInTransaction,
  SessionRealtimeConflictError,
  type AssertSessionRealtimeOwnerInput,
} from "./session-realtime";
import { lockSessionEventWriteRows } from "./session-control";

export const SESSION_REALTIME_LEDGER_MAX_BATCH = 64;
export const SESSION_REALTIME_LEDGER_MAX_TEXT_BYTES = 131_072;
export const SESSION_REALTIME_LEDGER_MAX_PAYLOAD_BYTES = 131_072;
export const SESSION_REALTIME_LEDGER_MAX_OUTBOUND = 100;

export type SessionRealtimeConnectionState = "negotiating" | "active" | "failed" | "closed";

export type SessionRealtimeConnection = {
  id: string;
  realtimeId: string;
  operationId: string;
  connectionEpoch: number;
  state: SessionRealtimeConnectionState;
  sdpAnswer: string | null;
  failureCode: string | null;
  negotiatedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimSessionRealtimeConnectionInput = AssertSessionRealtimeOwnerInput & {
  operationId: string;
  expectedConnectionEpoch: number;
  rotate: boolean;
};

export type ClaimSessionRealtimeConnectionResult = {
  connection: SessionRealtimeConnection;
  modeVersion: number;
  replay: boolean;
};

export type CompleteSessionRealtimeConnectionInput = {
  workspaceId: string;
  sessionId: string;
  realtimeId: string;
  connectionId: string;
  operationId: string;
  connectionEpoch: number;
  sdpAnswer: string;
  now?: Date;
};

export type CompleteSessionRealtimeConnectionResult = {
  connection: SessionRealtimeConnection;
  replay: boolean;
};

export type FailSessionRealtimeConnectionInput = Omit<
  CompleteSessionRealtimeConnectionInput,
  "sdpAnswer"
> & {
  failureCode: string;
};

export type FailSessionRealtimeConnectionResult = {
  connection: SessionRealtimeConnection;
  replay: boolean;
};

export type SessionRealtimeLedgerDirection = "provider_in" | "provider_out";

export type SessionRealtimeLedgerKind =
  | "user_transcript"
  | "assistant_transcript"
  | "delegation_call"
  | "delegation_result"
  | "interruption"
  | "session_update"
  | "error";

export type SessionRealtimeLedgerEntry = {
  id: string;
  realtimeId: string;
  operationId: string;
  connectionEpoch: number;
  sequence: number;
  direction: SessionRealtimeLedgerDirection;
  kind: SessionRealtimeLedgerKind;
  role: "user" | "assistant" | null;
  providerEventId: string | null;
  delegationItemId: string | null;
  sourceUpdateId: string | null;
  historyItemId: string | null;
  text: string | null;
  payload: Record<string, unknown>;
  clientAckedAt: string | null;
  providerAckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionRealtimeInboundEntryInput = {
  operationId: string;
  kind: Exclude<SessionRealtimeLedgerKind, "delegation_result" | "session_update">;
  role?: "user" | "assistant" | null | undefined;
  providerEventId?: string | null | undefined;
  delegationItemId?: string | null | undefined;
  text?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
};

export type SyncSessionRealtimeLedgerInput = AssertSessionRealtimeOwnerInput & {
  connectionId: string;
  connectionEpoch: number;
  entries?: SessionRealtimeInboundEntryInput[] | undefined;
  clientAckThroughSequence?: number | null | undefined;
  providerAckThroughSequence?: number | null | undefined;
};

export type SyncSessionRealtimeLedgerResult = {
  accepted: Array<{ entry: SessionRealtimeLedgerEntry; replay: boolean }>;
  outbound: SessionRealtimeLedgerEntry[];
};

export type AppendSessionRealtimeOutboundInput = {
  workspaceId: string;
  sessionId: string;
  realtimeId: string;
  operationId: string;
  connectionEpoch: number;
  kind: Extract<SessionRealtimeLedgerKind, "delegation_result" | "error">;
  delegationItemId?: string | null;
  text?: string | null;
  payload?: Record<string, unknown>;
  now?: Date;
};

export type AppendSessionRealtimeOutboundResult = {
  entry: SessionRealtimeLedgerEntry;
  replay: boolean;
};

type ConnectionRow = typeof schema.sessionRealtimeConnections.$inferSelect;
type EntryRow = typeof schema.sessionRealtimeEntries.$inferSelect;

function mapConnection(row: ConnectionRow): SessionRealtimeConnection {
  return {
    id: row.id,
    realtimeId: row.realtimeId,
    operationId: row.operationId,
    connectionEpoch: row.connectionEpoch,
    state: row.state as SessionRealtimeConnectionState,
    sdpAnswer: row.sdpAnswer,
    failureCode: row.failureCode,
    negotiatedAt: row.negotiatedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapEntry(row: EntryRow): SessionRealtimeLedgerEntry {
  return {
    id: row.id,
    realtimeId: row.realtimeId,
    operationId: row.operationId,
    connectionEpoch: row.connectionEpoch,
    sequence: row.sequence,
    direction: row.direction as SessionRealtimeLedgerDirection,
    kind: row.kind as SessionRealtimeLedgerKind,
    role: row.role as "user" | "assistant" | null,
    providerEventId: row.providerEventId,
    delegationItemId: row.delegationItemId,
    sourceUpdateId: row.sourceUpdateId,
    historyItemId: row.historyItemId,
    text: row.text,
    payload: row.payload,
    clientAckedAt: row.clientAckedAt?.toISOString() ?? null,
    providerAckedAt: row.providerAckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertConnectionEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection epoch is invalid",
    );
  }
}

function assertBoundedString(
  value: string | null | undefined,
  maximum: number,
  label: string,
): void {
  if (value !== null && value !== undefined && Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`${label} exceeds the durable realtime ledger limit`);
  }
}

function boundedPayload(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const payload = sanitizeEventPayload(input ?? {});
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") > SESSION_REALTIME_LEDGER_MAX_PAYLOAD_BYTES
  ) {
    throw new Error("Realtime payload exceeds the durable ledger limit");
  }
  return payload;
}

function expectedRole(input: SessionRealtimeInboundEntryInput): "user" | "assistant" | null {
  if (input.kind === "user_transcript") {
    if (input.role !== undefined && input.role !== "user") {
      throw new Error("User transcript must use the user role");
    }
    return "user";
  }
  if (input.kind === "assistant_transcript") {
    if (input.role !== undefined && input.role !== "assistant") {
      throw new Error("Assistant transcript must use the assistant role");
    }
    return "assistant";
  }
  const role = input.role ?? null;
  if (!["user_transcript", "assistant_transcript"].includes(input.kind) && role !== null) {
    throw new Error("Only realtime transcripts may carry a role");
  }
  return null;
}

export async function claimSessionRealtimeConnectionInTransaction(
  db: Database,
  input: ClaimSessionRealtimeConnectionInput,
): Promise<ClaimSessionRealtimeConnectionResult> {
  assertConnectionEpoch(input.expectedConnectionEpoch);
  let staleRotationError: SessionRealtimeConflictError | null = null;
  let mode;
  try {
    mode = await assertSessionRealtimeOwnerInTransaction(db, input);
  } catch (error) {
    if (
      !input.rotate ||
      !(error instanceof SessionRealtimeConflictError) ||
      error.code !== "REALTIME_VERSION_CHANGED"
    ) {
      throw error;
    }
    staleRotationError = error;
    mode = await assertSessionRealtimeOwnerInTransaction(db, {
      ...input,
      expectedVersion: input.expectedVersion + 1,
    });
  }
  const targetEpoch = input.rotate
    ? input.expectedConnectionEpoch + 1
    : input.expectedConnectionEpoch;
  const [existing] = await db
    .select()
    .from(schema.sessionRealtimeConnections)
    .where(
      and(
        eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeConnections.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.connectionEpoch !== targetEpoch) {
      throw new SessionRealtimeConflictError(
        "REALTIME_CONNECTION_CHANGED",
        "Realtime connection operation was already used with different input",
      );
    }
    return {
      connection: mapConnection(existing),
      modeVersion: mode.version,
      replay: true,
    };
  }
  if (staleRotationError) throw staleRotationError;
  if (mode.connectionEpoch !== input.expectedConnectionEpoch) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection epoch changed",
    );
  }

  const [open] = await db
    .select()
    .from(schema.sessionRealtimeConnections)
    .where(
      and(
        eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId),
        inArray(schema.sessionRealtimeConnections.state, ["negotiating", "active"]),
      ),
    )
    .for("update")
    .limit(1);
  const now = input.now ?? new Date();
  let modeVersion = mode.version;
  if (!input.rotate && open) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_ACTIVE",
      "Realtime mode already has an open provider connection",
    );
  }
  if (input.rotate) {
    if (open) {
      await db
        .update(schema.sessionRealtimeConnections)
        .set({ state: "closed", closedAt: now, updatedAt: now })
        .where(eq(schema.sessionRealtimeConnections.id, open.id));
    }
    const [rotated] = await db
      .update(schema.sessionRealtimeModes)
      .set({
        connectionEpoch: targetEpoch,
        version: mode.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sessionRealtimeModes.id, input.realtimeId),
          eq(schema.sessionRealtimeModes.state, "active"),
          eq(schema.sessionRealtimeModes.version, mode.version),
          eq(schema.sessionRealtimeModes.connectionEpoch, input.expectedConnectionEpoch),
        ),
      )
      .returning({ version: schema.sessionRealtimeModes.version });
    if (!rotated) {
      throw new SessionRealtimeConflictError(
        "REALTIME_CONNECTION_CHANGED",
        "Realtime connection changed while rotating",
      );
    }
    modeVersion = rotated.version;
  }

  const [modeRow] = await db
    .select({ accountId: schema.sessionRealtimeModes.accountId })
    .from(schema.sessionRealtimeModes)
    .where(eq(schema.sessionRealtimeModes.id, input.realtimeId))
    .limit(1);
  if (!modeRow) throw new Error("Realtime mode disappeared while claiming connection");

  const [connection] = await db
    .insert(schema.sessionRealtimeConnections)
    .values({
      accountId: modeRow.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      realtimeId: input.realtimeId,
      operationId: input.operationId,
      connectionEpoch: targetEpoch,
      state: "negotiating",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!connection) throw new Error("Failed to claim realtime connection");
  return { connection: mapConnection(connection), modeVersion, replay: false };
}

async function lockConnectionFinalizationMode(
  db: Database,
  input: Pick<
    CompleteSessionRealtimeConnectionInput,
    "workspaceId" | "sessionId" | "realtimeId" | "connectionEpoch" | "now"
  >,
) {
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "share",
    sessionIds: [input.sessionId],
  });
  const [mode] = await db
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
  if (!mode || mode.state !== "active" || mode.leaseExpiresAt <= (input.now ?? new Date())) {
    throw new SessionRealtimeConflictError(
      "REALTIME_NOT_ACTIVE",
      "Realtime mode is no longer active",
    );
  }
  if (mode.connectionEpoch !== input.connectionEpoch) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection epoch changed before negotiation completed",
    );
  }
  return mode;
}

export async function completeSessionRealtimeConnectionInTransaction(
  db: Database,
  input: CompleteSessionRealtimeConnectionInput,
): Promise<CompleteSessionRealtimeConnectionResult> {
  assertConnectionEpoch(input.connectionEpoch);
  assertBoundedString(input.sdpAnswer, 1_048_576, "Realtime SDP answer");
  if (input.sdpAnswer.length === 0) throw new Error("Realtime SDP answer is empty");
  await lockConnectionFinalizationMode(db, input);
  const [connection] = await db
    .select()
    .from(schema.sessionRealtimeConnections)
    .where(
      and(
        eq(schema.sessionRealtimeConnections.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeConnections.sessionId, input.sessionId),
        eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeConnections.id, input.connectionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!connection) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_NOT_FOUND",
      "Realtime connection claim not found",
    );
  }
  if (
    connection.operationId !== input.operationId ||
    connection.connectionEpoch !== input.connectionEpoch
  ) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection claim changed",
    );
  }
  if (connection.state === "active") {
    if (connection.sdpAnswer !== input.sdpAnswer) {
      throw new SessionRealtimeConflictError(
        "REALTIME_CONNECTION_STATE_CHANGED",
        "Realtime connection was already completed with another answer",
      );
    }
    return { connection: mapConnection(connection), replay: true };
  }
  if (connection.state !== "negotiating") {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection is no longer current",
    );
  }
  const now = input.now ?? new Date();
  const [completed] = await db
    .update(schema.sessionRealtimeConnections)
    .set({
      state: "active",
      sdpAnswer: input.sdpAnswer,
      negotiatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionRealtimeConnections.id, input.connectionId),
        eq(schema.sessionRealtimeConnections.state, "negotiating"),
      ),
    )
    .returning();
  if (!completed) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_STATE_CHANGED",
      "Realtime connection changed while negotiation completed",
    );
  }
  return { connection: mapConnection(completed), replay: false };
}

export async function failSessionRealtimeConnectionInTransaction(
  db: Database,
  input: FailSessionRealtimeConnectionInput,
): Promise<FailSessionRealtimeConnectionResult> {
  assertConnectionEpoch(input.connectionEpoch);
  assertBoundedString(input.failureCode, 128, "Realtime connection failure code");
  if (!/^[a-z0-9_.:-]+$/i.test(input.failureCode)) {
    throw new Error("Realtime connection failure code is invalid");
  }
  await lockConnectionFinalizationMode(db, input);
  const [connection] = await db
    .select()
    .from(schema.sessionRealtimeConnections)
    .where(
      and(
        eq(schema.sessionRealtimeConnections.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeConnections.sessionId, input.sessionId),
        eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeConnections.id, input.connectionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!connection) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_NOT_FOUND",
      "Realtime connection claim not found",
    );
  }
  if (
    connection.operationId !== input.operationId ||
    connection.connectionEpoch !== input.connectionEpoch
  ) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection claim changed",
    );
  }
  if (connection.state === "failed") {
    if (connection.failureCode !== input.failureCode) {
      throw new SessionRealtimeConflictError(
        "REALTIME_CONNECTION_STATE_CHANGED",
        "Realtime connection was already failed with another code",
      );
    }
    return { connection: mapConnection(connection), replay: true };
  }
  if (connection.state !== "negotiating") {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection is no longer negotiating",
    );
  }
  const now = input.now ?? new Date();
  const [failed] = await db
    .update(schema.sessionRealtimeConnections)
    .set({
      state: "failed",
      failureCode: input.failureCode,
      closedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionRealtimeConnections.id, input.connectionId),
        eq(schema.sessionRealtimeConnections.state, "negotiating"),
      ),
    )
    .returning();
  if (!failed) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_STATE_CHANGED",
      "Realtime connection changed while negotiation failed",
    );
  }
  return { connection: mapConnection(failed), replay: false };
}

async function nextLedgerSequence(db: Database, realtimeId: string): Promise<number> {
  const [row] = await db
    .select({
      next: sql<number>`coalesce(max(${schema.sessionRealtimeEntries.sequence}), 0) + 1`,
    })
    .from(schema.sessionRealtimeEntries)
    .where(eq(schema.sessionRealtimeEntries.realtimeId, realtimeId));
  return Number(row?.next ?? 1);
}

async function nextHistoryPosition(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({
      next: sql<number>`coalesce(max(${schema.sessionHistoryItems.position}), -1) + 1`,
    })
    .from(schema.sessionHistoryItems)
    .where(
      and(
        eq(schema.sessionHistoryItems.workspaceId, workspaceId),
        eq(schema.sessionHistoryItems.sessionId, sessionId),
      ),
    );
  return Number(row?.next ?? 0);
}

async function validateActiveConnection(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    realtimeId: string;
    connectionId: string;
    connectionEpoch: number;
  },
) {
  const [connection] = await db
    .select()
    .from(schema.sessionRealtimeConnections)
    .where(
      and(
        eq(schema.sessionRealtimeConnections.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeConnections.sessionId, input.sessionId),
        eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeConnections.id, input.connectionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!connection) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_NOT_FOUND",
      "Realtime connection not found",
    );
  }
  if (connection.connectionEpoch !== input.connectionEpoch || connection.state !== "active") {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection is no longer active",
    );
  }
  return connection;
}

async function materializeRealtimeUpdates(
  db: Database,
  input: Pick<
    SyncSessionRealtimeLedgerInput,
    "workspaceId" | "sessionId" | "realtimeId" | "connectionEpoch"
  >,
  accountId: string,
  allocateSequence: () => number,
  now: Date,
): Promise<void> {
  const updates = await db
    .select()
    .from(schema.sessionSystemUpdates)
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, input.workspaceId),
        eq(schema.sessionSystemUpdates.sessionId, input.sessionId),
        inArray(schema.sessionSystemUpdates.state, ["pending", "deferred"]),
        inArray(schema.sessionSystemUpdates.kind, ["agent_message", "child_terminal_result"]),
      ),
    )
    .orderBy(asc(schema.sessionSystemUpdates.createdAt), asc(schema.sessionSystemUpdates.id))
    .limit(SESSION_REALTIME_LEDGER_MAX_OUTBOUND);
  if (updates.length === 0) return;
  const existing = await db
    .select({ sourceUpdateId: schema.sessionRealtimeEntries.sourceUpdateId })
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
        inArray(
          schema.sessionRealtimeEntries.sourceUpdateId,
          updates.map((update) => update.id),
        ),
      ),
    );
  const existingIds = new Set(
    existing.flatMap(({ sourceUpdateId }) => (sourceUpdateId ? [sourceUpdateId] : [])),
  );
  const missing = updates.filter((update) => !existingIds.has(update.id));
  if (missing.length === 0) return;
  await db.insert(schema.sessionRealtimeEntries).values(
    missing.map((update) => ({
      accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      realtimeId: input.realtimeId,
      operationId: update.id,
      connectionEpoch: input.connectionEpoch,
      sequence: allocateSequence(),
      direction: "provider_out",
      kind: "session_update",
      sourceUpdateId: update.id,
      text: update.summary,
      payload: boundedPayload({
        updateId: update.id,
        kind: update.kind,
        classification: update.classification,
        sourceId: update.sourceId,
        summary: update.summary,
        payload: update.payload,
        lineage: update.lineage,
      }),
      createdAt: now,
      updatedAt: now,
    })),
  );
}

function assertAck(value: number | null | undefined, maximum: number): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new SessionRealtimeConflictError(
      "REALTIME_ACK_INVALID",
      "Realtime acknowledgment is outside the durable ledger",
    );
  }
  return value;
}

export async function syncSessionRealtimeLedgerInTransaction(
  db: Database,
  input: SyncSessionRealtimeLedgerInput,
): Promise<SyncSessionRealtimeLedgerResult> {
  assertConnectionEpoch(input.connectionEpoch);
  if ((input.entries?.length ?? 0) > SESSION_REALTIME_LEDGER_MAX_BATCH) {
    throw new Error("Realtime ledger batch exceeds the server limit");
  }
  const mode = await assertSessionRealtimeOwnerInTransaction(db, input);
  if (mode.connectionEpoch !== input.connectionEpoch) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection epoch changed",
    );
  }
  const connection = await validateActiveConnection(db, input);
  if (connection.id !== input.connectionId) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection changed",
    );
  }

  const [modeRow] = await db
    .select({ accountId: schema.sessionRealtimeModes.accountId })
    .from(schema.sessionRealtimeModes)
    .where(eq(schema.sessionRealtimeModes.id, input.realtimeId))
    .limit(1);
  if (!modeRow) throw new Error("Realtime mode disappeared while syncing ledger");

  let nextSequence = await nextLedgerSequence(db, input.realtimeId);
  let historyPosition = await nextHistoryPosition(db, input.workspaceId, input.sessionId);
  const accepted: SyncSessionRealtimeLedgerResult["accepted"] = [];
  for (const incoming of input.entries ?? []) {
    const [existing] = await db
      .select()
      .from(schema.sessionRealtimeEntries)
      .where(
        and(
          eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
          eq(schema.sessionRealtimeEntries.operationId, incoming.operationId),
        ),
      )
      .limit(1);
    if (existing) {
      accepted.push({ entry: mapEntry(existing), replay: true });
      continue;
    }
    const role = expectedRole(incoming);
    const text = incoming.text ?? null;
    assertBoundedString(text, SESSION_REALTIME_LEDGER_MAX_TEXT_BYTES, "Realtime text");
    if (
      (incoming.kind === "user_transcript" || incoming.kind === "assistant_transcript") &&
      !text
    ) {
      throw new Error("Finalized realtime transcript text is required");
    }
    const payload = boundedPayload(incoming.payload);
    const now = input.now ?? new Date();
    let historyItemId: string | null = null;
    if (incoming.kind === "user_transcript" || incoming.kind === "assistant_transcript") {
      const [history] = await db
        .insert(schema.sessionHistoryItems)
        .values({
          accountId: modeRow.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          position: historyPosition++,
          item: sanitizeModelPayload({ type: "message", role, content: text }),
          producerCodexCredentialId: null,
          createdAt: now,
        })
        .returning({ id: schema.sessionHistoryItems.id });
      if (!history) throw new Error("Failed to append finalized realtime transcript");
      historyItemId = history.id;
    }
    const [entry] = await db
      .insert(schema.sessionRealtimeEntries)
      .values({
        accountId: modeRow.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        realtimeId: input.realtimeId,
        operationId: incoming.operationId,
        connectionEpoch: input.connectionEpoch,
        sequence: nextSequence++,
        direction: "provider_in",
        kind: incoming.kind,
        role,
        providerEventId: incoming.providerEventId ?? null,
        delegationItemId: incoming.delegationItemId ?? null,
        historyItemId,
        text,
        payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!entry) throw new Error("Failed to append realtime ledger entry");
    accepted.push({ entry: mapEntry(entry), replay: false });
  }

  const now = input.now ?? new Date();
  await materializeRealtimeUpdates(db, input, modeRow.accountId, () => nextSequence++, now);
  const maximum = nextSequence - 1;
  const clientAck = assertAck(input.clientAckThroughSequence, maximum);
  const providerAck = assertAck(input.providerAckThroughSequence, maximum);
  if (clientAck !== null && clientAck > 0) {
    await db
      .update(schema.sessionRealtimeEntries)
      .set({ clientAckedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
          eq(schema.sessionRealtimeEntries.direction, "provider_out"),
          isNull(schema.sessionRealtimeEntries.clientAckedAt),
          sql`${schema.sessionRealtimeEntries.sequence} <= ${clientAck}`,
        ),
      );
  }
  if (providerAck !== null && providerAck > 0) {
    await db
      .update(schema.sessionRealtimeEntries)
      .set({ providerAckedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
          eq(schema.sessionRealtimeEntries.direction, "provider_out"),
          isNull(schema.sessionRealtimeEntries.providerAckedAt),
          sql`${schema.sessionRealtimeEntries.sequence} <= ${providerAck}`,
        ),
      );
  }
  const outbound = await db
    .select()
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeEntries.direction, "provider_out"),
        sql`(${schema.sessionRealtimeEntries.clientAckedAt} is null or ${schema.sessionRealtimeEntries.providerAckedAt} is null)`,
      ),
    )
    .orderBy(asc(schema.sessionRealtimeEntries.sequence))
    .limit(SESSION_REALTIME_LEDGER_MAX_OUTBOUND);
  return { accepted, outbound: outbound.map(mapEntry) };
}

export async function appendSessionRealtimeOutboundInTransaction(
  db: Database,
  input: AppendSessionRealtimeOutboundInput,
): Promise<AppendSessionRealtimeOutboundResult> {
  assertConnectionEpoch(input.connectionEpoch);
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "share",
    sessionIds: [input.sessionId],
  });
  const [mode] = await db
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
  if (
    !mode ||
    mode.state !== "active" ||
    mode.connectionEpoch !== input.connectionEpoch ||
    mode.leaseExpiresAt <= (input.now ?? new Date())
  ) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime connection changed before outbound delivery",
    );
  }
  const [activeConnection] = await db
    .select({ id: schema.sessionRealtimeConnections.id })
    .from(schema.sessionRealtimeConnections)
    .where(
      and(
        eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeConnections.connectionEpoch, input.connectionEpoch),
        eq(schema.sessionRealtimeConnections.state, "active"),
      ),
    )
    .limit(1);
  if (!activeConnection) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_NOT_FOUND",
      "Active realtime connection not found",
    );
  }
  const [existing] = await db
    .select()
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeEntries.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (existing) return { entry: mapEntry(existing), replay: true };
  const text = input.text ?? null;
  assertBoundedString(text, SESSION_REALTIME_LEDGER_MAX_TEXT_BYTES, "Realtime text");
  const payload = boundedPayload(input.payload);
  const nextSequence = await nextLedgerSequence(db, input.realtimeId);
  const now = input.now ?? new Date();
  const [entry] = await db
    .insert(schema.sessionRealtimeEntries)
    .values({
      accountId: mode.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      realtimeId: input.realtimeId,
      operationId: input.operationId,
      connectionEpoch: input.connectionEpoch,
      sequence: Number(nextSequence),
      direction: "provider_out",
      kind: input.kind,
      delegationItemId: input.delegationItemId,
      text,
      payload,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!entry) throw new Error("Failed to append realtime outbound entry");
  return { entry: mapEntry(entry), replay: false };
}
