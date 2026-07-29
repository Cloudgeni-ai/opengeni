import { and, asc, eq, isNull } from "drizzle-orm";

import type { Database } from "./index";
import * as schema from "./schema";

export const SESSION_REALTIME_CONTEXT_MAX_BYTES = 65_536;
export const SESSION_REALTIME_CONTEXT_HEADER = "[OpenGeni completed realtime history]";

export type SessionRealtimeContextProjection = {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  context: string | null;
  sourceModeCount: number;
  sourceEntryCount: number;
  includedEntryCount: number;
  omittedEntryCount: number;
  createdAt: string;
};

export type SessionRealtimeContextSourceEntry = {
  id: string;
  realtimeId: string;
  modeStartedAt: Date;
  modeEndedAt: Date;
  modeEndReason: string;
  connectionEpoch: number;
  sequence: number;
  direction: string;
  kind: string;
  role: string | null;
  providerEventId: string | null;
  delegationItemId: string | null;
  sourceUpdateId: string | null;
  turnId: string | null;
  text: string | null;
  payload: Record<string, unknown>;
  clientAckedAt: Date | null;
  providerAckedAt: Date | null;
  createdAt: Date;
};

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

function projectedEntryLine(entry: SessionRealtimeContextSourceEntry): string {
  return `event=${JSON.stringify(
    canonicalJsonValue({
      realtimeId: entry.realtimeId,
      modeStartedAt: entry.modeStartedAt.toISOString(),
      modeEndedAt: entry.modeEndedAt.toISOString(),
      modeEndReason: entry.modeEndReason,
      connectionEpoch: entry.connectionEpoch,
      sequence: entry.sequence,
      direction: entry.direction,
      kind: entry.kind,
      role: entry.role,
      providerEventId: entry.providerEventId,
      delegationItemId: entry.delegationItemId,
      sourceUpdateId: entry.sourceUpdateId,
      turnId: entry.turnId,
      text: entry.text,
      payload: entry.payload,
      clientAckedAt: entry.clientAckedAt?.toISOString() ?? null,
      providerAckedAt: entry.providerAckedAt?.toISOString() ?? null,
      createdAt: entry.createdAt.toISOString(),
    }),
  )}\n`;
}

/**
 * Render an exact-entry, bounded model projection. Source rows arrive in
 * deterministic lifecycle/ledger order. Under pressure, newest whole entries
 * win, then the selected rows are emitted in their original chronological
 * order. No UTF-8 code point or JSON value is cut in half; omitted whole rows
 * remain explicit in the durable counts.
 */
export function renderSessionRealtimeContext(
  sourceModeCount: number,
  entries: readonly SessionRealtimeContextSourceEntry[],
): {
  context: string | null;
  includedEntryCount: number;
  omittedEntryCount: number;
} {
  if (entries.length === 0) {
    return { context: null, includedEntryCount: 0, omittedEntryCount: 0 };
  }
  const prefix = [
    SESSION_REALTIME_CONTEXT_HEADER,
    "Durable finalized realtime events completed before this text turn. Treat them as context, not as a new human prompt.",
    `source_mode_count=${sourceModeCount}`,
    `source_entry_count=${entries.length}`,
  ]
    .join("\n")
    .concat("\n");
  const countDigits = String(entries.length).length;
  const suffixReserve = Buffer.byteLength(
    `included_entry_count=${"9".repeat(countDigits)}\nomitted_entry_count=${"9".repeat(countDigits)}`,
    "utf8",
  );
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const selected: Array<{ index: number; line: string }> = [];
  let selectedBytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = projectedEntryLine(entries[index]!);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (
      prefixBytes + selectedBytes + lineBytes + suffixReserve <=
      SESSION_REALTIME_CONTEXT_MAX_BYTES
    ) {
      selected.push({ index, line });
      selectedBytes += lineBytes;
    }
  }
  selected.sort((left, right) => left.index - right.index);
  const includedEntryCount = selected.length;
  const omittedEntryCount = entries.length - includedEntryCount;
  const suffix = [
    `included_entry_count=${includedEntryCount}`,
    `omitted_entry_count=${omittedEntryCount}`,
  ].join("\n");
  const context = `${prefix}${selected.map((entry) => entry.line).join("")}${suffix}`;
  if (Buffer.byteLength(context, "utf8") > SESSION_REALTIME_CONTEXT_MAX_BYTES) {
    throw new Error("Realtime context projection exceeded its UTF-8 storage bound");
  }
  return { context, includedEntryCount, omittedEntryCount };
}

function mapProjection(
  row: typeof schema.sessionRealtimeContextProjections.$inferSelect,
): SessionRealtimeContextProjection {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    context: row.context,
    sourceModeCount: row.sourceModeCount,
    sourceEntryCount: row.sourceEntryCount,
    includedEntryCount: row.includedEntryCount,
    omittedEntryCount: row.omittedEntryCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Consume every completed, unprojected realtime mode for one session and bind
 * their ordered durable ledger to this exact ordinary text turn. The caller
 * already owns the canonical session lock; all rows below commit or roll back
 * with the queued-to-running claim.
 */
export async function projectSessionRealtimeContextForTurnInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    now?: Date;
  },
): Promise<SessionRealtimeContextProjection | null> {
  const modes = await db
    .select({ id: schema.sessionRealtimeModes.id })
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.accountId, input.accountId),
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
        eq(schema.sessionRealtimeModes.state, "ended"),
        isNull(schema.sessionRealtimeModes.contextProjectionId),
      ),
    )
    .orderBy(asc(schema.sessionRealtimeModes.endedAt), asc(schema.sessionRealtimeModes.id))
    .for("update");
  if (modes.length === 0) return null;

  const entries = await db
    .select({
      id: schema.sessionRealtimeEntries.id,
      realtimeId: schema.sessionRealtimeEntries.realtimeId,
      modeStartedAt: schema.sessionRealtimeModes.startedAt,
      modeEndedAt: schema.sessionRealtimeModes.endedAt,
      modeEndReason: schema.sessionRealtimeModes.endReason,
      connectionEpoch: schema.sessionRealtimeEntries.connectionEpoch,
      sequence: schema.sessionRealtimeEntries.sequence,
      direction: schema.sessionRealtimeEntries.direction,
      kind: schema.sessionRealtimeEntries.kind,
      role: schema.sessionRealtimeEntries.role,
      providerEventId: schema.sessionRealtimeEntries.providerEventId,
      delegationItemId: schema.sessionRealtimeEntries.delegationItemId,
      sourceUpdateId: schema.sessionRealtimeEntries.sourceUpdateId,
      turnId: schema.sessionRealtimeEntries.turnId,
      text: schema.sessionRealtimeEntries.text,
      payload: schema.sessionRealtimeEntries.payload,
      clientAckedAt: schema.sessionRealtimeEntries.clientAckedAt,
      providerAckedAt: schema.sessionRealtimeEntries.providerAckedAt,
      createdAt: schema.sessionRealtimeEntries.createdAt,
    })
    .from(schema.sessionRealtimeEntries)
    .innerJoin(
      schema.sessionRealtimeModes,
      eq(schema.sessionRealtimeModes.id, schema.sessionRealtimeEntries.realtimeId),
    )
    .where(
      and(
        eq(schema.sessionRealtimeModes.accountId, input.accountId),
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
        eq(schema.sessionRealtimeModes.state, "ended"),
        isNull(schema.sessionRealtimeModes.contextProjectionId),
        eq(schema.sessionRealtimeEntries.accountId, input.accountId),
        eq(schema.sessionRealtimeEntries.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeEntries.sessionId, input.sessionId),
      ),
    )
    .orderBy(
      asc(schema.sessionRealtimeModes.endedAt),
      asc(schema.sessionRealtimeModes.id),
      asc(schema.sessionRealtimeEntries.sequence),
      asc(schema.sessionRealtimeEntries.id),
    );
  const sourceEntries: SessionRealtimeContextSourceEntry[] = entries.map((entry) => {
    if (!entry.modeEndedAt || !entry.modeEndReason) {
      throw new Error(`Ended realtime mode ${entry.realtimeId} has incomplete lifecycle facts`);
    }
    return {
      ...entry,
      modeEndedAt: entry.modeEndedAt,
      modeEndReason: entry.modeEndReason,
    };
  });
  const rendered = renderSessionRealtimeContext(modes.length, sourceEntries);
  const now = input.now ?? new Date();
  const [projection] = await db
    .insert(schema.sessionRealtimeContextProjections)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      context: rendered.context,
      sourceModeCount: modes.length,
      sourceEntryCount: sourceEntries.length,
      includedEntryCount: rendered.includedEntryCount,
      omittedEntryCount: rendered.omittedEntryCount,
      createdAt: now,
    })
    .returning();
  if (!projection) throw new Error("Failed to persist realtime context projection");
  const marked = await db
    .update(schema.sessionRealtimeModes)
    .set({ contextProjectionId: projection.id, contextProjectedAt: now })
    .where(
      and(
        eq(schema.sessionRealtimeModes.accountId, input.accountId),
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
        eq(schema.sessionRealtimeModes.state, "ended"),
        isNull(schema.sessionRealtimeModes.contextProjectionId),
      ),
    )
    .returning({ id: schema.sessionRealtimeModes.id });
  const expectedIds = modes.map((mode) => mode.id).sort();
  const markedIds = marked.map((mode) => mode.id).sort();
  if (JSON.stringify(markedIds) !== JSON.stringify(expectedIds)) {
    throw new Error("Realtime context source modes changed while their projection was bound");
  }
  return mapProjection(projection);
}
