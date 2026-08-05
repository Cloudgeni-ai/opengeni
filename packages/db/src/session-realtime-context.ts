import { createHash } from "node:crypto";

import { ReasoningEffort } from "@opengeni/contracts";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "./database";
import { fromPostgresLosslessJson, fromPostgresLosslessText } from "./lossless-json";
import * as schema from "./schema";
import { submitHumanPromptInTransaction } from "./session-queue-commands";

export const SESSION_REALTIME_CONTEXT_MAX_BYTES = 65_536;
export const SESSION_REALTIME_TAIL_SOURCE = "transcript_tail_flush";
export const SESSION_REALTIME_TAIL_INSTRUCTION =
  "The user just ended the realtime voice session but remains reachable by text. Ending voice changes only the communication mode; it does not stop, pause, or complete existing work. Treat the remaining transcript tail as additional context. If work was already underway, continue it from the current state. Change or stop that work only if the user explicitly requested it. If nothing was underway and the transcript contains no unhandled request, acknowledge briefly; otherwise handle any unhandled request.";

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
  sequence: number;
  role: string | null;
  text: string | null;
  payload: Record<string, unknown>;
};

export type SessionRealtimeContinuityEntry = {
  realtimeId: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  turnId: string;
  createdAt: string;
};

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function escapeXmlText(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function entryLine(entry: Pick<SessionRealtimeContextSourceEntry, "role" | "text">): string {
  const role = entry.role === "assistant" ? "assistant" : "user";
  return `${role}: ${entry.text ?? ""}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function takeUtf8Head(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedEscapedLine(
  entry: Pick<SessionRealtimeContextSourceEntry, "role" | "text">,
  maximumBytes: number,
): string {
  const role = entry.role === "assistant" ? "assistant" : "user";
  const marker = "…[turn truncated]";
  const raw = entry.text ?? "";
  let low = 0;
  let high = Buffer.byteLength(raw, "utf8");
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${role}: ${escapeXmlText(takeUtf8Head(raw, middle))}${marker}`;
    if (utf8Bytes(candidate) <= maximumBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** Render the exact finalized tail after the latest provider delegation fence. */
export function renderSessionRealtimeTail(entries: readonly SessionRealtimeContextSourceEntry[]): {
  context: string | null;
  includedEntryCount: number;
  omittedEntryCount: number;
} {
  if (entries.length === 0) {
    return { context: null, includedEntryCount: 0, omittedEntryCount: 0 };
  }
  const prefix = [
    "<realtime_delegation>",
    `  <source>${SESSION_REALTIME_TAIL_SOURCE}</source>`,
    `  <input>${escapeXmlText(SESSION_REALTIME_TAIL_INSTRUCTION)}</input>`,
    "  <transcript_delta>",
  ].join("\n");
  const suffix = "\n  </transcript_delta>\n</realtime_delegation>";
  const available = SESSION_REALTIME_CONTEXT_MAX_BYTES - utf8Bytes(prefix) - utf8Bytes(suffix) - 2;
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = escapeXmlText(entryLine(entries[index]!));
    const lineBytes = utf8Bytes(line) + (selected.length > 0 ? 1 : 0);
    if (selectedBytes + lineBytes > available) break;
    selected.unshift(line);
    selectedBytes += lineBytes;
  }
  if (selected.length === 0) {
    const truncated = boundedEscapedLine(entries.at(-1)!, available);
    if (!truncated) throw new Error("Realtime transcript tail cannot fit its durable wrapper");
    selected.push(truncated);
    selectedBytes = utf8Bytes(truncated);
  }
  let includedEntryCount = selected.length;
  while (includedEntryCount > 1) {
    const omitted = entries.length - includedEntryCount;
    const markerBytes =
      omitted > 0 ? utf8Bytes(`[${omitted} older transcript turns omitted]`) + 1 : 0;
    if (selectedBytes + markerBytes <= available) break;
    const removed = selected.shift()!;
    selectedBytes -= utf8Bytes(removed) + (selected.length > 0 ? 1 : 0);
    includedEntryCount -= 1;
  }
  const omittedEntryCount = entries.length - includedEntryCount;
  if (omittedEntryCount > 0) {
    const marker = `[${omittedEntryCount} older transcript turns omitted]`;
    const markerBytes = utf8Bytes(marker) + 1;
    if (selectedBytes + markerBytes > available) {
      const truncated = boundedEscapedLine(entries.at(-1)!, available - markerBytes);
      if (!truncated) throw new Error("Realtime transcript tail omission marker cannot fit");
      selected.splice(0, selected.length, truncated);
    }
    selected.unshift(marker);
  }
  const context = `${prefix}\n${selected.join("\n")}${suffix}`;
  if (utf8Bytes(context) > SESSION_REALTIME_CONTEXT_MAX_BYTES) {
    throw new Error("Realtime transcript tail exceeded its durable UTF-8 bound");
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
 * Codex-style end fence: route only finalized voice transcript after the last
 * delegation into the same canonical Steer-or-start path used by a human.
 */
export async function flushSessionRealtimeTranscriptTailInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    realtimeId: string;
    ownerSubjectId: string;
    now?: Date;
  },
): Promise<SessionRealtimeContextProjection | null> {
  const [mode] = await db
    .select()
    .from(schema.sessionRealtimeModes)
    .where(
      and(
        eq(schema.sessionRealtimeModes.accountId, input.accountId),
        eq(schema.sessionRealtimeModes.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeModes.sessionId, input.sessionId),
        eq(schema.sessionRealtimeModes.id, input.realtimeId),
      ),
    )
    .for("update")
    .limit(1);
  if (!mode || mode.state !== "ended") return null;
  if (mode.contextProjectionId) {
    const [existing] = await db
      .select()
      .from(schema.sessionRealtimeContextProjections)
      .where(eq(schema.sessionRealtimeContextProjections.id, mode.contextProjectionId))
      .limit(1);
    if (!existing) throw new Error(`Realtime mode ${mode.id} lost its tail projection`);
    return mapProjection(existing);
  }

  const [latestDelegation] = await db
    .select({
      sequence: schema.sessionRealtimeEntries.sequence,
      delegationItemId: schema.sessionRealtimeEntries.delegationItemId,
    })
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, mode.id),
        eq(schema.sessionRealtimeEntries.direction, "provider_in"),
        eq(schema.sessionRealtimeEntries.kind, "delegation_call"),
      ),
    )
    .orderBy(desc(schema.sessionRealtimeEntries.sequence))
    .limit(1);
  const rows = await db
    .select({
      id: schema.sessionRealtimeEntries.id,
      realtimeId: schema.sessionRealtimeEntries.realtimeId,
      sequence: schema.sessionRealtimeEntries.sequence,
      role: schema.sessionRealtimeEntries.role,
      text: schema.sessionRealtimeEntries.text,
      textCodecVersion: schema.sessionRealtimeEntries.textCodecVersion,
      payload: schema.sessionRealtimeEntries.payload,
      payloadCodecVersion: schema.sessionRealtimeEntries.payloadCodecVersion,
    })
    .from(schema.sessionRealtimeEntries)
    .where(
      and(
        eq(schema.sessionRealtimeEntries.realtimeId, mode.id),
        inArray(schema.sessionRealtimeEntries.kind, ["user_transcript", "assistant_transcript"]),
        sql`jsonb_typeof(${schema.sessionRealtimeEntries.payload} -> 'turnId') = 'string'`,
        latestDelegation
          ? sql`${schema.sessionRealtimeEntries.sequence} > ${latestDelegation.sequence}`
          : undefined,
        isNull(sql`${schema.sessionRealtimeEntries.payload} ->> 'coveredByDelegationItemId'`),
      ),
    )
    .orderBy(asc(schema.sessionRealtimeEntries.sequence), asc(schema.sessionRealtimeEntries.id));
  const decodedRows = rows.map((row) => ({
    ...row,
    text: row.text === null ? null : fromPostgresLosslessText(row.text, row.textCodecVersion),
    payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
  }));
  const rendered = renderSessionRealtimeTail(decodedRows);
  if (!rendered.context) return null;

  const [session] = await db
    .select({ metadata: schema.sessions.metadata })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    )
    .limit(1);
  if (!session) throw new Error(`Realtime tail session ${input.sessionId} disappeared`);
  const reasoning = ReasoningEffort.safeParse(session.metadata.reasoningEffort);
  const admitted = await submitHumanPromptInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    subjectId: input.ownerSubjectId,
    subjectLabel: "Realtime",
    actor: {
      type: "service",
      subjectId: input.ownerSubjectId,
      subjectLabel: "Realtime",
      context: { source: SESSION_REALTIME_TAIL_SOURCE, realtimeId: mode.id },
    },
    operationKey: deterministicUuid(`opengeni:session-realtime-tail-flush:${mode.id}`),
    delivery: "steer",
    text: rendered.context,
    messagePresentation: {
      kind: "realtime_voice_handoff",
      text: "Voice session ended. Remaining conversation context was sent to the agent.",
      context: rendered.context,
    },
    resources: [],
    reasoningEffortFallback: reasoning.success ? reasoning.data : "medium",
    turnMetadata: {
      realtimeTailFlush: {
        source: SESSION_REALTIME_TAIL_SOURCE,
        realtimeId: mode.id,
        lastDelegationItemId: latestDelegation?.delegationItemId ?? null,
        sourceEntryIds: decodedRows.map((entry) => entry.id),
      },
    },
    source: "api",
  });
  const now = input.now ?? new Date();
  const [projection] = await db
    .insert(schema.sessionRealtimeContextProjections)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: admitted.turnId,
      context: rendered.context,
      sourceModeCount: 1,
      sourceEntryCount: rows.length,
      includedEntryCount: rendered.includedEntryCount,
      omittedEntryCount: rendered.omittedEntryCount,
      createdAt: now,
    })
    .returning();
  if (!projection) throw new Error("Failed to persist realtime transcript tail projection");
  const [marked] = await db
    .update(schema.sessionRealtimeModes)
    .set({ contextProjectionId: projection.id, contextProjectedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.sessionRealtimeModes.id, mode.id),
        eq(schema.sessionRealtimeModes.state, "ended"),
        isNull(schema.sessionRealtimeModes.contextProjectionId),
      ),
    )
    .returning({ id: schema.sessionRealtimeModes.id });
  if (!marked) throw new Error("Realtime transcript tail projection lost its mode fence");
  return mapProjection(projection);
}

export async function listSessionRealtimeContinuityEntriesInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    maximumEntries?: number;
  },
): Promise<SessionRealtimeContinuityEntry[]> {
  const maximumEntries = input.maximumEntries ?? 20;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 128) {
    throw new Error("Realtime continuity entry bound is invalid");
  }
  const rows = await db
    .select({
      realtimeId: schema.sessionRealtimeEntries.realtimeId,
      sequence: schema.sessionRealtimeEntries.sequence,
      role: schema.sessionRealtimeEntries.role,
      text: schema.sessionRealtimeEntries.text,
      textCodecVersion: schema.sessionRealtimeEntries.textCodecVersion,
      payload: schema.sessionRealtimeEntries.payload,
      payloadCodecVersion: schema.sessionRealtimeEntries.payloadCodecVersion,
      createdAt: schema.sessionRealtimeEntries.createdAt,
      modeStartedAt: schema.sessionRealtimeModes.startedAt,
    })
    .from(schema.sessionRealtimeEntries)
    .innerJoin(
      schema.sessionRealtimeModes,
      eq(schema.sessionRealtimeModes.id, schema.sessionRealtimeEntries.realtimeId),
    )
    .where(
      and(
        eq(schema.sessionRealtimeEntries.accountId, input.accountId),
        eq(schema.sessionRealtimeEntries.workspaceId, input.workspaceId),
        eq(schema.sessionRealtimeEntries.sessionId, input.sessionId),
        inArray(schema.sessionRealtimeEntries.kind, ["user_transcript", "assistant_transcript"]),
        sql`jsonb_typeof(${schema.sessionRealtimeEntries.payload} -> 'turnId') = 'string'`,
      ),
    )
    .orderBy(
      desc(schema.sessionRealtimeModes.startedAt),
      desc(schema.sessionRealtimeEntries.sequence),
      desc(schema.sessionRealtimeEntries.id),
    )
    .limit(maximumEntries);
  return rows.reverse().flatMap((row) => {
    const text =
      row.text === null ? null : fromPostgresLosslessText(row.text, row.textCodecVersion);
    const payload = fromPostgresLosslessJson(row.payload, row.payloadCodecVersion);
    const turnId = payload.turnId;
    if (
      (row.role !== "user" && row.role !== "assistant") ||
      typeof text !== "string" ||
      typeof turnId !== "string"
    ) {
      return [];
    }
    return [
      {
        realtimeId: row.realtimeId,
        sequence: row.sequence,
        role: row.role,
        text: takeUtf8Head(text, 16_000),
        turnId,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });
}
