import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { sanitizeEventPayload } from "./event-payload-sanitizer";
import type { Database } from "./index";
import { mirrorSessionRealtimeContextInTransaction } from "./session-realtime-mirror";
import * as schema from "./schema";

const MAX_TEXT_BYTES = 131_072;
const MAX_PAYLOAD_BYTES = 131_072;

export type ProjectSessionRealtimeDelegationTerminalInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnStatus: "completed" | "failed" | "cancelled" | "superseded";
  terminalEvent: {
    type: "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.superseded";
    payload: Record<string, unknown>;
  };
  now?: Date;
};

export type SessionRealtimeTerminalEntry = {
  id: string;
  realtimeId: string;
  operationId: string;
  connectionEpoch: number;
  sequence: number;
  direction: "provider_in" | "provider_out";
  kind:
    | "user_transcript"
    | "assistant_transcript"
    | "delegation_call"
    | "delegation_progress"
    | "delegation_result"
    | "interruption"
    | "session_update"
    | "error";
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

export type ProjectSessionRealtimeDelegationTerminalResult = {
  entry: SessionRealtimeTerminalEntry;
  replay: boolean;
} | null;

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deterministicTerminalOperationId(turnId: string): string {
  return deterministicUuid(`opengeni:session-realtime-delegation-terminal:${turnId}`);
}

function boundedPayload(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const payload = sanitizeEventPayload(input ?? {});
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Realtime payload exceeds the durable ledger limit");
  }
  return payload;
}

function assertBoundedText(value: string, label: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`${label} exceeds the durable realtime ledger limit`);
  }
}

function terminalProjection(input: ProjectSessionRealtimeDelegationTerminalInput): {
  kind: "delegation_result" | "error";
  text: string;
  payload: Record<string, unknown>;
} {
  const expectedType = `turn.${input.turnStatus}`;
  if (input.terminalEvent.type !== expectedType) {
    throw new Error(
      `Realtime delegation terminal event ${input.terminalEvent.type} does not match ${input.turnStatus}`,
    );
  }
  const terminal = boundedPayload(input.terminalEvent.payload);
  if (input.turnStatus === "completed") {
    const output =
      typeof terminal.output === "string" ? terminal.output : "Delegated turn completed.";
    assertBoundedText(output, "Delegation result");
    return {
      kind: "delegation_result",
      text: output,
      payload: boundedPayload({
        status: input.turnStatus,
        turnId: input.turnId,
        terminalEventType: input.terminalEvent.type,
        terminal,
      }),
    };
  }
  const code =
    typeof terminal.code === "string" && terminal.code.length > 0
      ? terminal.code
      : `delegation_turn_${input.turnStatus}`;
  const message =
    typeof terminal.error === "string" && terminal.error.length > 0
      ? terminal.error
      : `Delegated turn ${input.turnStatus}.`;
  assertBoundedText(message, "Delegation error");
  return {
    kind: "error",
    text: message,
    payload: boundedPayload({
      code,
      status: input.turnStatus,
      turnId: input.turnId,
      terminalEventType: input.terminalEvent.type,
      terminal,
    }),
  };
}

function mapEntry(
  row: typeof schema.sessionRealtimeEntries.$inferSelect,
): SessionRealtimeTerminalEntry {
  return {
    id: row.id,
    realtimeId: row.realtimeId,
    operationId: row.operationId,
    connectionEpoch: row.connectionEpoch,
    sequence: row.sequence,
    direction: row.direction as "provider_in" | "provider_out",
    kind: row.kind as SessionRealtimeTerminalEntry["kind"],
    role: row.role as "user" | "assistant" | null,
    providerEventId: row.providerEventId,
    delegationItemId: row.delegationItemId,
    sourceUpdateId: row.sourceUpdateId,
    historyItemId: row.historyItemId,
    turnId: row.turnId,
    text: row.text,
    payload: row.payload,
    clientAckedAt: row.clientAckedAt?.toISOString() ?? null,
    providerAckedAt: row.providerAckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One terminal projection for every realtime-delegated durable turn. */
export async function projectSessionRealtimeDelegationTerminalInTransaction(
  db: Database,
  input: ProjectSessionRealtimeDelegationTerminalInput,
): Promise<ProjectSessionRealtimeDelegationTerminalResult> {
  // Steer is a continuing session interaction, not a failure to announce.
  // Realtime receives the accepted direction and subsequent agent stream from
  // the canonical session mirror, so emitting a synthetic terminal is wrong.
  if (input.turnStatus === "superseded") return null;

  const calls = await db
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
    .limit(2);
  if (calls.length > 1) {
    throw new Error(`Delegation turn ${input.turnId} has multiple accepted realtime calls`);
  }
  const projected = terminalProjection(input);
  const now = input.now ?? new Date();
  const call = calls[0] ?? null;
  const [mode] = call
    ? await db
        .select({
          id: schema.sessionRealtimeModes.id,
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
        .limit(1)
    : [];
  if (call && !mode) {
    throw new Error(`Delegation turn ${input.turnId} lost its realtime mode ownership`);
  }
  const routesToActiveDelegation =
    call !== null && mode?.state === "active" && mode.leaseExpiresAt > now;
  if (!routesToActiveDelegation) {
    const mirrored = await mirrorSessionRealtimeContextInTransaction(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceKind: "assistant_terminal",
      sourceId: `${input.turnId}:${input.terminalEvent.type}`,
      turnId: input.turnId,
      channel: "speakable",
      text: projected.text,
      payload: {
        route: "session_context",
        status: input.turnStatus,
        terminalEventType: input.terminalEvent.type,
        terminal: boundedPayload(input.terminalEvent.payload),
        ...(call ? { priorRealtimeId: call.realtimeId } : {}),
      },
      now,
    });
    return mirrored ? { entry: mapEntry(mirrored.entry), replay: mirrored.replay } : null;
  }
  if (!call || !mode) {
    throw new Error(`Delegation turn ${input.turnId} lost its active realtime route`);
  }
  if (!call.delegationItemId) {
    throw new Error(`Delegation turn ${input.turnId} has no provider item identity`);
  }
  const operationId = deterministicTerminalOperationId(input.turnId);
  const [existing] = await db
    .select()
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeEntries.sessionId, input.sessionId),
        eq(schema.sessionRealtimeEntries.turnId, input.turnId),
        eq(schema.sessionRealtimeEntries.direction, "provider_out"),
        inArray(schema.sessionRealtimeEntries.kind, ["delegation_result", "error"]),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.accountId !== input.accountId ||
      existing.realtimeId !== call.realtimeId ||
      existing.operationId !== operationId ||
      existing.kind !== projected.kind ||
      existing.delegationItemId !== call.delegationItemId
    ) {
      throw new Error(`Delegation turn ${input.turnId} has conflicting terminal projection`);
    }
    return { entry: mapEntry(existing), replay: true };
  }

  const [sequenceRow] = await db
    .select({
      next: sql<number>`coalesce(max(${schema.sessionRealtimeEntries.sequence}), 0) + 1`,
    })
    .from(schema.sessionRealtimeEntries)
    .where(eq(schema.sessionRealtimeEntries.realtimeId, call.realtimeId));
  const payload = boundedPayload({
    ...projected.payload,
    route: "delegation_context",
    channel: "speakable",
    callOperationId: call.operationId,
    callLedgerEntryId: call.id,
  });
  const [entry] = await db
    .insert(schema.sessionRealtimeEntries)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      realtimeId: call.realtimeId,
      operationId,
      connectionEpoch: mode.connectionEpoch,
      sequence: Number(sequenceRow?.next ?? 1),
      direction: "provider_out",
      kind: projected.kind,
      delegationItemId: call.delegationItemId,
      turnId: input.turnId,
      text: projected.text,
      payload,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!entry) throw new Error("Failed to project realtime delegation terminal result");
  return { entry: mapEntry(entry), replay: false };
}
