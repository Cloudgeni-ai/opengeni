import { createHash } from "node:crypto";

import { LatencyMode, ReasoningEffort, type SessionRealtimeMode } from "@opengeni/contracts";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Database } from "./database";
import {
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  LOSSLESS_CONTENT_CODEC_VERSION,
} from "./lossless-json";
import * as schema from "./schema";
import {
  assertSessionRealtimeOwnerInTransaction,
  SessionRealtimeConflictError,
  type AssertSessionRealtimeOwnerInput,
} from "./session-realtime";
import { lockSessionEventWriteRows, lockWorkspaceInferenceControl } from "./session-control";
import { submitHumanPromptInTransaction } from "./session-queue-commands";
import { mirrorSessionRealtimeContextInTransaction } from "./session-realtime-mirror";

export const SESSION_REALTIME_LEDGER_MAX_BATCH = 64;
export const SESSION_REALTIME_LEDGER_MAX_TEXT_BYTES = 131_072;
export const SESSION_REALTIME_LEDGER_MAX_PAYLOAD_BYTES = 131_072;
export const SESSION_REALTIME_LEDGER_MAX_OUTBOUND = 100;
export const SESSION_REALTIME_STARTUP_MAX_ENTRIES = 100;
const SESSION_REALTIME_SOURCE_EVENT_IDS_MAX = 64;

export type SessionRealtimeConnectionState =
  | "negotiating"
  | "ready"
  | "active"
  | "failed"
  | "closed";

export type SessionRealtimeConnectionPromotionMode = "legacy" | "staged";

export type SessionRealtimeConnection = {
  id: string;
  realtimeId: string;
  operationId: string;
  connectionEpoch: number;
  startupFenceSequence: number;
  promotionMode: SessionRealtimeConnectionPromotionMode;
  state: SessionRealtimeConnectionState;
  sdpAnswer: string | null;
  failureCode: string | null;
  providerSessionId: string | null;
  startupEventId: string | null;
  startupAcknowledgedAt: string | null;
  negotiatedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimSessionRealtimeConnectionInput = AssertSessionRealtimeOwnerInput & {
  operationId: string;
  expectedConnectionEpoch: number;
  rotate: boolean;
  promotionMode?: SessionRealtimeConnectionPromotionMode | undefined;
};

export type ClaimSessionRealtimeConnectionResult = {
  connection: SessionRealtimeConnection;
  startupEntries: SessionRealtimeLedgerEntry[];
  mode: SessionRealtimeMode;
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

export type ActivateSessionRealtimeConnectionInput = AssertSessionRealtimeOwnerInput & {
  operationId: string;
  connectionId: string;
  connectionEpoch: number;
  expectedConnectionEpoch: number;
};

export type ActivateSessionRealtimeConnectionResult = {
  connection: SessionRealtimeConnection;
  mode: SessionRealtimeMode;
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
  | "delegation_progress"
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
  turnId: string | null;
  text: string | null;
  payload: Record<string, unknown>;
  clientAckedAt: string | null;
  providerAckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionRealtimeInboundEntryInput = {
  operationId: string;
  kind: Exclude<
    SessionRealtimeLedgerKind,
    "delegation_progress" | "delegation_result" | "session_update"
  >;
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
  providerAckSequences?: number[] | undefined;
  providerStarted?:
    | { providerSessionId: string; providerEventId?: string | null | undefined }
    | undefined;
};

export type SyncSessionRealtimeLedgerResult = {
  accepted: Array<{ entry: SessionRealtimeLedgerEntry; replay: boolean }>;
  outbound: SessionRealtimeLedgerEntry[];
  eventIds: string[];
  workflowWakeRevision: number | null;
};

export type SyncSessionRealtimeLedgerHooks = {
  /** Test-only failure injection after both durable admission rows exist. */
  afterDelegationAdmission?:
    | ((admission: { entryId: string; turnId: string }) => void | Promise<void>)
    | undefined;
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

export {
  projectSessionRealtimeDelegationTerminalInTransaction,
  type ProjectSessionRealtimeDelegationTerminalInput,
  type ProjectSessionRealtimeDelegationTerminalResult,
} from "./session-realtime-terminal";

export type ProjectSessionRealtimeDelegationProgressInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  events: ReadonlyArray<{
    id: string;
    sequence: number;
    type: string;
    payload: unknown;
  }>;
  now?: Date;
};

export type ProjectSessionRealtimeDelegationProgressResult = {
  entries: SessionRealtimeLedgerEntry[];
};

type ConnectionRow = typeof schema.sessionRealtimeConnections.$inferSelect;
type EntryRow = typeof schema.sessionRealtimeEntries.$inferSelect;

function mapConnection(row: ConnectionRow): SessionRealtimeConnection {
  return {
    id: row.id,
    realtimeId: row.realtimeId,
    operationId: row.operationId,
    connectionEpoch: row.connectionEpoch,
    startupFenceSequence: row.startupFenceSequence,
    promotionMode: row.promotionMode as SessionRealtimeConnectionPromotionMode,
    state: row.state as SessionRealtimeConnectionState,
    sdpAnswer: row.sdpAnswer,
    failureCode: row.failureCode,
    providerSessionId: row.providerSessionId,
    startupEventId: row.startupEventId,
    startupAcknowledgedAt: row.startupAcknowledgedAt?.toISOString() ?? null,
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
    turnId: row.turnId,
    text: row.text === null ? null : fromPostgresLosslessText(row.text, row.textCodecVersion),
    payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
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
  const payload = input ?? {};
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") > SESSION_REALTIME_LEDGER_MAX_PAYLOAD_BYTES
  ) {
    throw new Error("Realtime payload exceeds the durable ledger limit");
  }
  return payload;
}

function realtimeDelegationMetadata(metadata: Record<string, unknown>): {
  realtimeId: string;
  connectionEpoch: number;
  delegationItemId: string;
  ledgerEntryId: string;
} | null {
  const value = metadata.realtimeDelegation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const delegation = value as Record<string, unknown>;
  if (
    typeof delegation.realtimeId !== "string" ||
    typeof delegation.connectionEpoch !== "number" ||
    !Number.isSafeInteger(delegation.connectionEpoch) ||
    delegation.connectionEpoch < 1 ||
    typeof delegation.delegationItemId !== "string" ||
    delegation.delegationItemId.length === 0 ||
    typeof delegation.ledgerEntryId !== "string"
  ) {
    return null;
  }
  return {
    realtimeId: delegation.realtimeId,
    connectionEpoch: delegation.connectionEpoch,
    delegationItemId: delegation.delegationItemId,
    ledgerEntryId: delegation.ledgerEntryId,
  };
}

/** True only for an exact provider-call-linked ordinary turn shape. */
export function isSessionRealtimeDelegationTurnMetadata(
  metadata: Record<string, unknown>,
): boolean {
  return realtimeDelegationMetadata(metadata) !== null;
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceEventProvenance(ids: readonly string[]): {
  identity: string;
  ids: string[];
  count: number;
  truncated: boolean;
} {
  const identity = createHash("sha256").update(ids.join(":"), "utf8").digest("hex");
  if (ids.length <= SESSION_REALTIME_SOURCE_EVENT_IDS_MAX) {
    return { identity, ids: [...ids], count: ids.length, truncated: false };
  }
  const half = SESSION_REALTIME_SOURCE_EVENT_IDS_MAX / 2;
  return {
    identity,
    ids: [...ids.slice(0, half), ...ids.slice(-half)],
    count: ids.length,
    truncated: true,
  };
}

function utf8Chunks(value: string, maximumBytes: number): string[] {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return [value];
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maximumBytes, bytes.length);
    if (end < bytes.length) {
      while (end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    }
    if (end === start) throw new Error("Realtime progress chunk boundary is invalid");
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
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
  const promotionMode = input.promotionMode ?? "staged";
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
    if (
      existing.promotionMode !== promotionMode ||
      (input.rotate && existing.connectionEpoch <= input.expectedConnectionEpoch) ||
      (!input.rotate && existing.connectionEpoch !== input.expectedConnectionEpoch)
    ) {
      throw new SessionRealtimeConflictError(
        "REALTIME_CONNECTION_CHANGED",
        "Realtime connection operation was already used with different input",
      );
    }
    return {
      connection: mapConnection(existing),
      startupEntries: await startupEntriesForConnection(db, existing),
      mode,
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

  const connections = await db
    .select()
    .from(schema.sessionRealtimeConnections)
    .where(eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId))
    .for("update");
  const now = input.now ?? new Date();
  const active = connections.find((connection) => connection.state === "active");
  const preparing = connections.find(
    (connection) => connection.state === "negotiating" || connection.state === "ready",
  );
  if (!input.rotate && (active || preparing)) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_ACTIVE",
      "Realtime mode already has an open provider connection",
    );
  }
  if (input.rotate) {
    if (promotionMode === "staged") {
      if (active?.promotionMode === "legacy" || preparing?.promotionMode === "legacy") {
        throw new SessionRealtimeConflictError(
          "REALTIME_CONNECTION_ACTIVE",
          "Legacy realtime connection must finish rotating before staged promotion",
        );
      }
      if (preparing) {
        await db
          .update(schema.sessionRealtimeConnections)
          .set({ state: "closed", closedAt: now, updatedAt: now })
          .where(eq(schema.sessionRealtimeConnections.id, preparing.id));
      }
    } else {
      await db
        .update(schema.sessionRealtimeConnections)
        .set({ state: "closed", closedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId),
            inArray(schema.sessionRealtimeConnections.state, ["negotiating", "ready", "active"]),
          ),
        );
    }
  }

  const highestEpoch = connections.reduce(
    (maximum, connection) => Math.max(maximum, connection.connectionEpoch),
    input.expectedConnectionEpoch,
  );
  const targetEpoch = input.rotate ? highestEpoch + 1 : input.expectedConnectionEpoch;

  let modeVersion = mode.version;
  if (input.rotate && promotionMode === "legacy") {
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

  const startupEntries = await db
    .select()
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeEntries.direction, "provider_out"),
        isNull(schema.sessionRealtimeEntries.providerAckedAt),
      ),
    )
    .orderBy(asc(schema.sessionRealtimeEntries.sequence))
    .limit(SESSION_REALTIME_STARTUP_MAX_ENTRIES);
  const startupFenceSequence = startupEntries.at(-1)?.sequence ?? 0;

  const [connection] = await db
    .insert(schema.sessionRealtimeConnections)
    .values({
      accountId: modeRow.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      realtimeId: input.realtimeId,
      operationId: input.operationId,
      connectionEpoch: targetEpoch,
      startupFenceSequence,
      promotionMode,
      state: "negotiating",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!connection) throw new Error("Failed to claim realtime connection");
  return {
    connection: mapConnection(connection),
    startupEntries: startupEntries.map(mapEntry),
    mode,
    modeVersion,
    replay: false,
  };
}

async function startupEntriesForConnection(
  db: Database,
  connection: ConnectionRow,
): Promise<SessionRealtimeLedgerEntry[]> {
  if (connection.startupFenceSequence === 0) return [];
  const rows = await db
    .select()
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, connection.realtimeId),
        eq(schema.sessionRealtimeEntries.direction, "provider_out"),
        isNull(schema.sessionRealtimeEntries.providerAckedAt),
        sql`${schema.sessionRealtimeEntries.sequence} <= ${connection.startupFenceSequence}`,
      ),
    )
    .orderBy(asc(schema.sessionRealtimeEntries.sequence))
    .limit(SESSION_REALTIME_STARTUP_MAX_ENTRIES);
  return rows.map(mapEntry);
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
  if (mode.connectionEpoch > input.connectionEpoch) {
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
  if (connection.state === "ready" || connection.state === "active") {
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
  const completedState = connection.promotionMode === "legacy" ? "active" : "ready";
  const [completed] = await db
    .update(schema.sessionRealtimeConnections)
    .set({
      state: completedState,
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

export async function activateSessionRealtimeConnectionInTransaction(
  db: Database,
  input: ActivateSessionRealtimeConnectionInput,
): Promise<ActivateSessionRealtimeConnectionResult> {
  assertConnectionEpoch(input.connectionEpoch);
  assertConnectionEpoch(input.expectedConnectionEpoch);
  let mode;
  try {
    mode = await assertSessionRealtimeOwnerInTransaction(db, input);
  } catch (error) {
    if (
      !(error instanceof SessionRealtimeConflictError) ||
      error.code !== "REALTIME_VERSION_CHANGED"
    ) {
      throw error;
    }
    mode = await assertSessionRealtimeOwnerInTransaction(db, {
      ...input,
      expectedVersion: input.expectedVersion + 1,
    });
  }

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
    if (mode.connectionEpoch !== connection.connectionEpoch) {
      throw new SessionRealtimeConflictError(
        "REALTIME_CONNECTION_CHANGED",
        "Realtime connection is no longer current",
      );
    }
    return {
      connection: mapConnection(connection),
      mode,
      replay: true,
    };
  }
  if (
    connection.promotionMode !== "staged" ||
    connection.state !== "ready" ||
    mode.connectionEpoch !== input.expectedConnectionEpoch ||
    connection.connectionEpoch < mode.connectionEpoch
  ) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_CHANGED",
      "Realtime replacement is no longer ready for activation",
    );
  }

  const now = input.now ?? new Date();
  await db
    .update(schema.sessionRealtimeConnections)
    .set({ state: "closed", closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.sessionRealtimeConnections.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeConnections.state, "active"),
      ),
    );
  const [activated] = await db
    .update(schema.sessionRealtimeConnections)
    .set({ state: "active", updatedAt: now })
    .where(
      and(
        eq(schema.sessionRealtimeConnections.id, connection.id),
        eq(schema.sessionRealtimeConnections.state, "ready"),
      ),
    )
    .returning();
  if (!activated) {
    throw new SessionRealtimeConflictError(
      "REALTIME_CONNECTION_STATE_CHANGED",
      "Realtime replacement changed while activating",
    );
  }

  let modeVersion = mode.version;
  if (mode.connectionEpoch !== connection.connectionEpoch) {
    const [promoted] = await db
      .update(schema.sessionRealtimeModes)
      .set({
        connectionEpoch: connection.connectionEpoch,
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
    if (!promoted) {
      throw new SessionRealtimeConflictError(
        "REALTIME_CONNECTION_CHANGED",
        "Realtime connection changed while activating replacement",
      );
    }
    modeVersion = promoted.version;
  }
  return {
    connection: mapConnection(activated),
    mode: {
      ...mode,
      version: modeVersion,
      connectionEpoch: connection.connectionEpoch,
    },
    replay: false,
  };
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

function delegationCallFailure(
  input: SessionRealtimeInboundEntryInput,
): { code: "invalid_delegation_call"; message: string } | null {
  if (!input.delegationItemId?.trim()) {
    return {
      code: "invalid_delegation_call",
      message: "Realtime delegation call is missing its provider item identity",
    };
  }
  if (!input.text?.trim()) {
    return {
      code: "invalid_delegation_call",
      message: "Realtime delegation call is missing ordinary work instructions",
    };
  }
  return null;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

function inboundReplayMatches(
  row: EntryRow,
  input: SessionRealtimeInboundEntryInput,
  role: "user" | "assistant" | null,
  text: string | null,
  payload: Record<string, unknown>,
): boolean {
  const storedText =
    row.text === null ? null : fromPostgresLosslessText(row.text, row.textCodecVersion);
  const storedPayload = fromPostgresLosslessJson(row.payload, row.payloadCodecVersion);
  return (
    row.direction === "provider_in" &&
    row.kind === input.kind &&
    row.role === role &&
    row.providerEventId === (input.providerEventId ?? null) &&
    row.delegationItemId === (input.delegationItemId ?? null) &&
    row.sourceUpdateId === null &&
    storedText === text &&
    JSON.stringify(canonicalJsonValue(storedPayload)) ===
      JSON.stringify(canonicalJsonValue(payload))
  );
}

async function appendInvalidDelegationFailure(
  db: Database,
  input: Pick<
    SyncSessionRealtimeLedgerInput,
    "workspaceId" | "sessionId" | "realtimeId" | "connectionEpoch"
  >,
  accountId: string,
  incoming: SessionRealtimeInboundEntryInput,
  failure: NonNullable<ReturnType<typeof delegationCallFailure>>,
  sequence: number,
  now: Date,
): Promise<void> {
  await db.insert(schema.sessionRealtimeEntries).values({
    accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    realtimeId: input.realtimeId,
    operationId: crypto.randomUUID(),
    connectionEpoch: input.connectionEpoch,
    sequence,
    direction: "provider_out",
    kind: "error",
    delegationItemId: incoming.delegationItemId ?? null,
    text: failure.message,
    textCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
    payload: {
      code: failure.code,
      callOperationId: incoming.operationId,
    },
    payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
    createdAt: now,
    updatedAt: now,
  });
}

async function admitRealtimeDelegationInTransaction(
  db: Database,
  input: Pick<
    SyncSessionRealtimeLedgerInput,
    "workspaceId" | "sessionId" | "realtimeId" | "connectionEpoch" | "ownerSubjectId"
  >,
  accountId: string,
  incoming: SessionRealtimeInboundEntryInput,
  entryId: string,
): Promise<{ turnId: string; eventIds: string[]; wakeRevision: number }> {
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    )
    .limit(1);
  if (!session || session.accountId !== accountId || session.status === "cancelled") {
    throw new SessionRealtimeConflictError("REALTIME_NOT_FOUND", "Session not found");
  }
  const reasoning = ReasoningEffort.safeParse(session.metadata.reasoningEffort);
  const [latestStarted] = await db
    .select({
      model: schema.sessionTurns.model,
      reasoningEffort: schema.sessionTurns.reasoningEffort,
      latencyMode: schema.sessionTurns.latencyMode,
    })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        sql`${schema.sessionTurns.startedAt} is not null`,
      ),
    )
    .orderBy(desc(schema.sessionTurns.startedAt), desc(schema.sessionTurns.createdAt))
    .limit(1);
  const latestReasoning = ReasoningEffort.safeParse(latestStarted?.reasoningEffort);
  const latestLatency = LatencyMode.safeParse(latestStarted?.latencyMode);
  const provenance = {
    source: "realtime_provider_delegation",
    realtimeId: input.realtimeId,
    connectionEpoch: input.connectionEpoch,
    delegationItemId: incoming.delegationItemId!,
    ledgerEntryId: entryId,
  };
  const inputTranscript = incoming.payload?.inputTranscript;
  if (typeof inputTranscript !== "string" || inputTranscript.trim().length === 0) {
    throw new Error("Realtime delegation input transcript is required");
  }
  const admitted = await submitHumanPromptInTransaction(db, {
    accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    subjectId: input.ownerSubjectId,
    subjectLabel: "Realtime",
    actor: {
      type: "service",
      subjectId: input.ownerSubjectId,
      subjectLabel: "Realtime",
      context: provenance,
    },
    operationKey: incoming.operationId,
    delivery: "steer",
    text: incoming.text!,
    messagePresentation: {
      kind: "realtime_voice",
      text: inputTranscript,
      context: incoming.text!,
    },
    resources: [],
    model: latestStarted?.model ?? session.model,
    reasoningEffort: latestReasoning.success
      ? latestReasoning.data
      : reasoning.success
        ? reasoning.data
        : "medium",
    latencyMode: latestLatency.success ? latestLatency.data : "standard",
    reasoningEffortFallback: reasoning.success ? reasoning.data : "medium",
    turnMetadata: {
      realtimeDelegation: { ...provenance, inputTranscript },
    },
    source: "api",
  });
  return {
    turnId: admitted.turnId,
    eventIds: admitted.eventIds,
    wakeRevision: admitted.wakeRevision,
  };
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
  const rows = await db
    .select({ update: schema.sessionSystemUpdates })
    .from(schema.sessionSystemUpdates)
    .leftJoin(
      schema.sessionRealtimeEntries,
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeEntries.sourceUpdateId, schema.sessionSystemUpdates.id),
      ),
    )
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, input.workspaceId),
        eq(schema.sessionSystemUpdates.sessionId, input.sessionId),
        inArray(schema.sessionSystemUpdates.state, ["pending", "deferred"]),
        inArray(schema.sessionSystemUpdates.kind, ["agent_message", "child_terminal_result"]),
        isNull(schema.sessionRealtimeEntries.id),
      ),
    )
    .orderBy(asc(schema.sessionSystemUpdates.createdAt), asc(schema.sessionSystemUpdates.id))
    .limit(SESSION_REALTIME_LEDGER_MAX_OUTBOUND);
  const updates = rows.map(({ update }) => ({
    ...update,
    summary: fromPostgresLosslessText(update.summary, update.summaryCodecVersion),
    payload: fromPostgresLosslessJson(update.payload, update.payloadCodecVersion),
  }));
  if (updates.length === 0) return;
  await db.insert(schema.sessionRealtimeEntries).values(
    updates.map((update) => ({
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
      textCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
      payload: boundedPayload({
        updateId: update.id,
        kind: update.kind,
        classification: update.classification,
        sourceId: update.sourceId,
        summary: update.summary,
        payload: update.payload,
        lineage: update.lineage,
      }),
      payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
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

function assertProviderAckSequences(values: number[] | undefined, maximum: number): number[] {
  if (!values || values.length === 0) return [];
  if (values.length > SESSION_REALTIME_LEDGER_MAX_OUTBOUND) {
    throw new SessionRealtimeConflictError(
      "REALTIME_ACK_INVALID",
      "Realtime provider acknowledgment batch exceeds the server limit",
    );
  }
  const unique = [...new Set(values)].sort((left, right) => left - right);
  if (
    unique.length !== values.length ||
    unique.some((value) => !Number.isSafeInteger(value) || value < 1 || value > maximum)
  ) {
    throw new SessionRealtimeConflictError(
      "REALTIME_ACK_INVALID",
      "Realtime provider acknowledgment is outside the durable ledger",
    );
  }
  return unique;
}

export async function syncSessionRealtimeLedgerInTransaction(
  db: Database,
  input: SyncSessionRealtimeLedgerInput,
  hooks: SyncSessionRealtimeLedgerHooks = {},
): Promise<SyncSessionRealtimeLedgerResult> {
  assertConnectionEpoch(input.connectionEpoch);
  if ((input.entries?.length ?? 0) > SESSION_REALTIME_LEDGER_MAX_BATCH) {
    throw new Error("Realtime ledger batch exceeds the server limit");
  }
  // Realtime sync may admit canonical Steer work. Preserve the global lock
  // order before owner proof locks the session row.
  await lockWorkspaceInferenceControl(db, input.workspaceId, "update");
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
  let providerStartupAcknowledged = connection.startupAcknowledgedAt !== null;
  const eventIds: string[] = [];
  let workflowWakeRevision: number | null = null;
  const now = input.now ?? new Date();
  if (input.providerStarted) {
    assertBoundedString(
      input.providerStarted.providerSessionId,
      1024,
      "Realtime provider session id",
    );
    assertBoundedString(input.providerStarted.providerEventId, 1024, "Realtime startup event id");
    if (connection.startupAcknowledgedAt) {
      if (
        connection.providerSessionId !== input.providerStarted.providerSessionId ||
        connection.startupEventId !== (input.providerStarted.providerEventId ?? null)
      ) {
        throw new SessionRealtimeConflictError(
          "REALTIME_CONNECTION_STATE_CHANGED",
          "Realtime provider startup was already acknowledged with different proof",
        );
      }
    } else {
      const [acknowledged] = await db
        .update(schema.sessionRealtimeConnections)
        .set({
          providerSessionId: input.providerStarted.providerSessionId,
          startupEventId: input.providerStarted.providerEventId ?? null,
          startupAcknowledgedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessionRealtimeConnections.id, connection.id),
            isNull(schema.sessionRealtimeConnections.startupAcknowledgedAt),
          ),
        )
        .returning({ id: schema.sessionRealtimeConnections.id });
      if (!acknowledged) {
        throw new SessionRealtimeConflictError(
          "REALTIME_CONNECTION_STATE_CHANGED",
          "Realtime provider startup changed while acknowledging it",
        );
      }
    }
    providerStartupAcknowledged = true;
  }
  const accepted: SyncSessionRealtimeLedgerResult["accepted"] = [];
  for (const incoming of input.entries ?? []) {
    if (incoming.kind === "delegation_call" && !providerStartupAcknowledged) {
      throw new SessionRealtimeConflictError(
        "REALTIME_PROVIDER_NOT_STARTED",
        "Realtime provider startup proof is required before delegation",
      );
    }
    const payload = boundedPayload(incoming.payload);
    const role = expectedRole(incoming);
    const text = incoming.text ?? null;
    assertBoundedString(text, SESSION_REALTIME_LEDGER_MAX_TEXT_BYTES, "Realtime text");
    if (
      (incoming.kind === "user_transcript" || incoming.kind === "assistant_transcript") &&
      !text
    ) {
      throw new Error("Finalized realtime transcript text is required");
    }
    if (incoming.kind === "user_transcript" || incoming.kind === "assistant_transcript") {
      const turnId = payload.turnId;
      if (typeof turnId !== "string" || turnId.length === 0) {
        throw new Error("Finalized realtime transcript turn id is required");
      }
      assertBoundedString(turnId, 1_024, "Realtime transcript turn id");
    }
    const [existing] = await db
      .select()
      .from(schema.sessionRealtimeEntries)
      .where(
        and(
          eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
          incoming.kind === "delegation_call" && incoming.delegationItemId
            ? or(
                eq(schema.sessionRealtimeEntries.operationId, incoming.operationId),
                and(
                  eq(schema.sessionRealtimeEntries.kind, "delegation_call"),
                  eq(schema.sessionRealtimeEntries.delegationItemId, incoming.delegationItemId),
                ),
              )
            : eq(schema.sessionRealtimeEntries.operationId, incoming.operationId),
        ),
      )
      .limit(1);
    if (existing) {
      if (!inboundReplayMatches(existing, incoming, role, text, payload)) {
        throw new SessionRealtimeConflictError(
          incoming.kind === "delegation_call"
            ? "REALTIME_DELEGATION_CHANGED"
            : "REALTIME_ENTRY_CHANGED",
          "Realtime ledger operation was already used with different input",
        );
      }
      accepted.push({ entry: mapEntry(existing), replay: true });
      continue;
    }
    let [entry] = await db
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
        historyItemId: null,
        text,
        textCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
        payload,
        payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!entry) throw new Error("Failed to append realtime ledger entry");
    if (incoming.kind === "delegation_call") {
      const failure = delegationCallFailure(incoming);
      if (failure) {
        await appendInvalidDelegationFailure(
          db,
          input,
          modeRow.accountId,
          incoming,
          failure,
          nextSequence++,
          now,
        );
      } else {
        const admission = await admitRealtimeDelegationInTransaction(
          db,
          input,
          modeRow.accountId,
          incoming,
          entry.id,
        );
        const [linked] = await db
          .update(schema.sessionRealtimeEntries)
          .set({ turnId: admission.turnId, updatedAt: now })
          .where(eq(schema.sessionRealtimeEntries.id, entry.id))
          .returning();
        if (!linked) throw new Error("Failed to link realtime delegation turn");
        entry = linked;
        eventIds.push(...admission.eventIds);
        workflowWakeRevision = Math.max(workflowWakeRevision ?? 0, admission.wakeRevision);
        await hooks.afterDelegationAdmission?.({ entryId: entry.id, turnId: admission.turnId });
      }
    }
    accepted.push({ entry: mapEntry(entry), replay: false });
  }

  await materializeRealtimeUpdates(db, input, modeRow.accountId, () => nextSequence++, now);
  const maximum = nextSequence - 1;
  const clientAck = assertAck(input.clientAckThroughSequence, maximum);
  if (clientAck !== null && clientAck > 0) {
    await db
      .update(schema.sessionRealtimeEntries)
      .set({ clientAckedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.sessionRealtimeEntries.workspaceId, input.workspaceId),
          eq(schema.sessionRealtimeEntries.sessionId, input.sessionId),
          eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
          eq(schema.sessionRealtimeEntries.direction, "provider_out"),
          isNull(schema.sessionRealtimeEntries.clientAckedAt),
          sql`${schema.sessionRealtimeEntries.sequence} <= ${clientAck}`,
        ),
      );
  }
  const providerAckSequences = assertProviderAckSequences(input.providerAckSequences, maximum);
  if (providerAckSequences.length > 0) {
    const ackable = await db
      .select({
        id: schema.sessionRealtimeEntries.id,
        sequence: schema.sessionRealtimeEntries.sequence,
      })
      .from(schema.sessionRealtimeEntries)
      .where(
        and(
          eq(schema.sessionRealtimeEntries.workspaceId, input.workspaceId),
          eq(schema.sessionRealtimeEntries.sessionId, input.sessionId),
          eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
          eq(schema.sessionRealtimeEntries.direction, "provider_out"),
          inArray(schema.sessionRealtimeEntries.sequence, providerAckSequences),
          sql`${schema.sessionRealtimeEntries.clientAckedAt} is not null`,
        ),
      )
      .for("update");
    if (
      ackable.length !== providerAckSequences.length ||
      ackable.some((entry) => !providerAckSequences.includes(entry.sequence))
    ) {
      throw new SessionRealtimeConflictError(
        "REALTIME_ACK_INVALID",
        "Realtime provider acknowledgment does not match client-received outbound entries",
      );
    }
    await db
      .update(schema.sessionRealtimeEntries)
      .set({ providerAckedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.sessionRealtimeEntries.workspaceId, input.workspaceId),
          eq(schema.sessionRealtimeEntries.sessionId, input.sessionId),
          eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
          inArray(
            schema.sessionRealtimeEntries.id,
            ackable.map((entry) => entry.id),
          ),
          isNull(schema.sessionRealtimeEntries.providerAckedAt),
        ),
      );
  }
  const outbound = await db
    .select()
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeEntries.sessionId, input.sessionId),
        eq(schema.sessionRealtimeEntries.realtimeId, input.realtimeId),
        eq(schema.sessionRealtimeEntries.direction, "provider_out"),
        isNull(schema.sessionRealtimeEntries.providerAckedAt),
      ),
    )
    .orderBy(
      sql`case when ${schema.sessionRealtimeEntries.clientAckedAt} is null then 0 else 1 end`,
      asc(schema.sessionRealtimeEntries.sequence),
    )
    .limit(SESSION_REALTIME_LEDGER_MAX_OUTBOUND);
  return {
    accepted,
    outbound: outbound.map(mapEntry),
    eventIds,
    workflowWakeRevision,
  };
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
      textCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
      payload,
      payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!entry) throw new Error("Failed to append realtime outbound entry");
  return { entry: mapEntry(entry), replay: false };
}

/**
 * Under the caller's canonical session/turn fence, mirror accepted assistant
 * text deltas into the active delegation's durable provider-out stream. One
 * append batch becomes one or more bounded progress rows, preserving the
 * ordinary event order without making the browser's live SSE authoritative.
 */
export async function projectSessionRealtimeDelegationProgressInTransaction(
  db: Database,
  input: ProjectSessionRealtimeDelegationProgressInput,
): Promise<ProjectSessionRealtimeDelegationProgressResult> {
  const progressEvents = input.events.flatMap((event) => {
    if (
      event.type !== "agent.message.delta" ||
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    ) {
      return [];
    }
    const text = (event.payload as Record<string, unknown>).text;
    return typeof text === "string" && text.length > 0 ? [{ ...event, text }] : [];
  });
  if (progressEvents.length === 0) return { entries: [] };

  const [call] = await db
    .select()
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.accountId, input.accountId),
        eq(schema.sessionRealtimeEntries.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeEntries.sessionId, input.sessionId),
        eq(schema.sessionRealtimeEntries.turnId, input.turnId),
        eq(schema.sessionRealtimeEntries.direction, "provider_in"),
        eq(schema.sessionRealtimeEntries.kind, "delegation_call"),
      ),
    )
    .for("update")
    .limit(1);
  const text = progressEvents.map((event) => event.text).join("");
  const source = sourceEventProvenance(progressEvents.map((event) => event.id));
  const sourceEventIds = source.ids;
  const sourceEventSequences = progressEvents.map((event) => event.sequence);
  const now = input.now ?? new Date();
  if (!call) {
    const mirrored = await mirrorSessionRealtimeContextInTransaction(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceKind: "assistant_progress",
      sourceId: source.identity,
      turnId: input.turnId,
      channel: "commentary",
      text,
      payload: {
        route: "session_context",
        status: "running",
        sourceEventIds,
        sourceEventCount: source.count,
        sourceEventIdsTruncated: source.truncated,
        firstSourceEventSequence: sourceEventSequences[0],
        lastSourceEventSequence: sourceEventSequences.at(-1),
      },
      now,
    });
    return { entries: mirrored ? [mapEntry(mirrored.entry)] : [] };
  }
  if (!call.delegationItemId) {
    throw new Error(`Delegation turn ${input.turnId} has no provider item identity`);
  }

  const [mode] = await db
    .select({
      connectionEpoch: schema.sessionRealtimeModes.connectionEpoch,
      state: schema.sessionRealtimeModes.state,
      leaseExpiresAt: schema.sessionRealtimeModes.leaseExpiresAt,
    })
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.id, call.realtimeId),
        eq(schema.sessionRealtimeModes.accountId, input.accountId),
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
      ),
    )
    .limit(1);
  if (!mode) {
    throw new Error(`Delegation turn ${input.turnId} lost its realtime mode ownership`);
  }
  if (mode.state !== "active" || mode.leaseExpiresAt <= now) {
    const mirrored = await mirrorSessionRealtimeContextInTransaction(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceKind: "assistant_progress",
      sourceId: source.identity,
      turnId: input.turnId,
      channel: "commentary",
      text,
      payload: {
        route: "session_context",
        status: "running",
        priorRealtimeId: call.realtimeId,
        sourceEventIds,
        sourceEventCount: source.count,
        sourceEventIdsTruncated: source.truncated,
        firstSourceEventSequence: sourceEventSequences[0],
        lastSourceEventSequence: sourceEventSequences.at(-1),
      },
      now,
    });
    return { entries: mirrored ? [mapEntry(mirrored.entry)] : [] };
  }

  const chunks = utf8Chunks(text, SESSION_REALTIME_LEDGER_MAX_TEXT_BYTES);
  const operationSeed = source.identity;
  let nextSequence = await nextLedgerSequence(db, call.realtimeId);
  const inserted = await db
    .insert(schema.sessionRealtimeEntries)
    .values(
      chunks.map((chunk, chunkIndex) => ({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        realtimeId: call.realtimeId,
        operationId: deterministicUuid(
          `opengeni:session-realtime-delegation-progress:${input.turnId}:${operationSeed}:${chunkIndex}`,
        ),
        connectionEpoch: mode.connectionEpoch,
        sequence: nextSequence++,
        direction: "provider_out" as const,
        kind: "delegation_progress" as const,
        delegationItemId: call.delegationItemId,
        turnId: input.turnId,
        text: chunk,
        textCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
        payload: boundedPayload({
          route: "delegation_context",
          channel: "commentary",
          status: "running",
          turnId: input.turnId,
          callOperationId: call.operationId,
          callLedgerEntryId: call.id,
          sourceEventIds,
          sourceEventCount: source.count,
          sourceEventIdsTruncated: source.truncated,
          firstSourceEventSequence: sourceEventSequences[0],
          lastSourceEventSequence: sourceEventSequences.at(-1),
          chunkIndex,
          chunkCount: chunks.length,
        }),
        payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning();
  return { entries: inserted.map(mapEntry) };
}

/**
 * Project the authoritative terminal event of an accepted same-session
 * delegation into exactly one outbound ledger row. The caller already owns the
 * canonical session/turn settlement locks; this helper deliberately does not
 * require the original provider connection (or even the mode) to remain
 * active. A later valid rotation may therefore replay the same durable row,
 * while the immutable realtime id prevents projection into another mode.
 */
