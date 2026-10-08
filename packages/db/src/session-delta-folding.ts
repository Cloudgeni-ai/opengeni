import type { SessionEvent } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import {
  fromPostgresLosslessJson,
  LOSSLESS_CONTENT_CODEC_VERSION,
  toPostgresLosslessJson,
} from "./lossless-json";

/**
 * Folding streamed text deltas after their turn settles (see
 * docs/session-storage-lifecycle.md).
 *
 * A run of adjacent `agent.message.delta` or `agent.reasoning.delta` rows of
 * one turn and producer becomes its first row with the whole text and
 * `coalescedUntil` (the shape live streams already deliver), plus `folded`, a
 * lossless record of every original row: sequence offset, occurred/created
 * offsets in microseconds, producer sequence, text length in UTF-16 code
 * units, and id. `unfoldSessionEventDeltas` rebuilds the original events.
 */

export const SESSION_DELTA_FOLD_TYPES = ["agent.message.delta", "agent.reasoning.delta"] as const;
/** Matches the live stream's coalescing bound, so a folded row never outgrows a live one. */
export const SESSION_DELTA_FOLD_TEXT_TARGET_BYTES = 48 * 1024;
export const SESSION_DELTA_FOLD_FORMAT_VERSION = 1 as const;
const FOLD_PAGE_ROWS = 2_000;

/** [sequenceOffset, occurredOffsetUs, createdOffsetUs, producerSeq, textLength, id] */
export type SessionDeltaFoldPart = [number, number, number, number | null, number, string];

export type FoldedDeltaPayload = {
  text: string;
  coalescedUntil: number;
  messageId?: string;
  phase?: string;
  folded: { v: typeof SESSION_DELTA_FOLD_FORMAT_VERSION; parts: SessionDeltaFoldPart[] };
};

export type SessionDeltaFoldCandidate = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
};

/** One stored row as the planner sees it. Non-delta rows carry no payload. */
export type SessionDeltaFoldRow = {
  id: string;
  sequence: number;
  type: string;
  turnId: string | null;
  producerId: string | null;
  producerSeq: number | null;
  turnGeneration: number | null;
  turnAttemptId: string | null;
  turnAssociation: string | null;
  clientEventId: string | null;
  duplicateOfEventId: string | null;
  occurredUs: bigint;
  createdUs: bigint;
  payload: Record<string, unknown> | null;
};

export type SessionDeltaFoldRun = {
  first: number;
  last: number;
  ids: string[];
  payload: FoldedDeltaPayload;
};

const encoder = new TextEncoder();

function foldableText(row: SessionDeltaFoldRow): string | null {
  if (!(SESSION_DELTA_FOLD_TYPES as readonly string[]).includes(row.type)) return null;
  if (row.clientEventId !== null || row.duplicateOfEventId !== null || row.turnId === null)
    return null;
  const payload = row.payload;
  if (!payload || typeof payload.text !== "string") return null;
  // Only the plain fragment shape: anything else would not survive folding.
  for (const key of Object.keys(payload)) {
    if (key !== "text" && key !== "messageId" && key !== "phase") return null;
  }
  if (payload.messageId !== undefined && typeof payload.messageId !== "string") return null;
  if (payload.phase !== undefined && typeof payload.phase !== "string") return null;
  if (row.type === "agent.reasoning.delta" && (payload.messageId ?? payload.phase) !== undefined)
    return null;
  return payload.text;
}

function sameRun(first: SessionDeltaFoldRow, next: SessionDeltaFoldRow): boolean {
  return (
    next.type === first.type &&
    next.turnId === first.turnId &&
    next.producerId === first.producerId &&
    next.turnGeneration === first.turnGeneration &&
    next.turnAttemptId === first.turnAttemptId &&
    next.turnAssociation === first.turnAssociation &&
    next.payload?.messageId === first.payload?.messageId &&
    next.payload?.phase === first.payload?.phase
  );
}

function buildRun(rows: SessionDeltaFoldRow[]): SessionDeltaFoldRun {
  const head = rows[0]!;
  const last = rows.at(-1)!;
  const text = rows.map((row) => row.payload!.text as string).join("");
  const payload: FoldedDeltaPayload = {
    text,
    coalescedUntil: last.sequence,
    ...(typeof head.payload?.messageId === "string" ? { messageId: head.payload.messageId } : {}),
    ...(typeof head.payload?.phase === "string" ? { phase: head.payload.phase } : {}),
    folded: {
      v: SESSION_DELTA_FOLD_FORMAT_VERSION,
      parts: rows.map((row) => [
        row.sequence - head.sequence,
        Number(row.occurredUs - head.occurredUs),
        Number(row.createdUs - head.createdUs),
        row.producerSeq,
        (row.payload!.text as string).length,
        row.id,
      ]),
    },
  };
  return { first: head.sequence, last: last.sequence, ids: rows.map((row) => row.id), payload };
}

/**
 * Streaming planner over rows in sequence order. Only rows with consecutive
 * sequences fold together, so no other event is ever reordered around them.
 */
export function createSessionDeltaFoldPlanner(onRun: (run: SessionDeltaFoldRun) => void) {
  let current: SessionDeltaFoldRow[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length >= 2) onRun(buildRun(current));
    current = [];
    bytes = 0;
  };
  return {
    push(row: SessionDeltaFoldRow) {
      const text = foldableText(row);
      if (text === null) {
        flush();
        return;
      }
      const size = encoder.encode(text).byteLength;
      const previous = current.at(-1);
      if (
        previous &&
        previous.sequence + 1 === row.sequence &&
        sameRun(current[0]!, row) &&
        bytes + size <= SESSION_DELTA_FOLD_TEXT_TARGET_BYTES
      ) {
        current.push(row);
        bytes += size;
        return;
      }
      flush();
      current = [row];
      bytes = size;
    },
    finish: flush,
  };
}

export function planSessionDeltaFoldRuns(rows: SessionDeltaFoldRow[]): SessionDeltaFoldRun[] {
  const runs: SessionDeltaFoldRun[] = [];
  const planner = createSessionDeltaFoldPlanner((run) => runs.push(run));
  for (const row of rows) planner.push(row);
  planner.finish();
  return runs;
}

function isFoldPart(value: unknown): value is SessionDeltaFoldPart {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    Number.isInteger(value[2]) &&
    (value[3] === null || Number.isInteger(value[3])) &&
    Number.isInteger(value[4]) &&
    typeof value[5] === "string"
  );
}

function shiftIso(iso: string, offsetUs: number): string {
  return new Date(Date.parse(iso) + Math.round(offsetUs / 1000)).toISOString();
}

/**
 * The original fragments of a folded delta, in order; any other event is
 * returned unchanged. Timestamps are rebuilt at millisecond precision (the
 * stored record keeps microseconds).
 */
export function unfoldSessionEventDeltas(event: SessionEvent): SessionEvent[] {
  const payload = event.payload as Partial<FoldedDeltaPayload> | null;
  const folded = payload && typeof payload === "object" ? payload.folded : undefined;
  if (
    !folded ||
    folded.v !== SESSION_DELTA_FOLD_FORMAT_VERSION ||
    !Array.isArray(folded.parts) ||
    typeof payload!.text !== "string" ||
    !folded.parts.every(isFoldPart)
  ) {
    return [event];
  }
  const text = payload!.text;
  const events: SessionEvent[] = [];
  let offset = 0;
  for (const [sequenceOffset, occurredUs, , , length, id] of folded.parts) {
    const fragment: Record<string, unknown> = { text: text.slice(offset, offset + length) };
    if (typeof payload!.messageId === "string") fragment.messageId = payload!.messageId;
    if (typeof payload!.phase === "string") fragment.phase = payload!.phase;
    offset += length;
    const { coveredThrough: _coveredThrough, ...base } = event as SessionEvent & {
      coveredThrough?: number;
    };
    events.push({
      ...base,
      id,
      sequence: event.sequence + sequenceOffset,
      occurredAt: shiftIso(event.occurredAt, occurredUs),
      payload: fragment,
    } as SessionEvent);
  }
  return offset === text.length ? events : [event];
}

export async function listSessionDeltaFoldCandidates(
  db: Database,
  input: { settleSeconds: number; limit: number },
): Promise<SessionDeltaFoldCandidate[]> {
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    session_id: string;
    turn_id: string;
  }>(
    db,
    sql`select account_id, workspace_id, session_id, turn_id
      from opengeni_private.session_delta_fold_candidates(
        ${Math.floor(input.settleSeconds)}, ${input.limit})`,
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
  }));
}

type RawFoldRow = {
  id: string;
  sequence: number;
  type: string;
  turn_id: string | null;
  producer_id: string | null;
  producer_seq: number | null;
  turn_generation: number | null;
  turn_attempt_id: string | null;
  turn_association: string | null;
  client_event_id: string | null;
  duplicate_of_event_id: string | null;
  occurred_us: string;
  created_us: string;
  payload: Record<string, unknown> | null;
  payload_codec_version: number | null;
};

/**
 * Fold every eligible run of one settled turn, then record the turn as done.
 * Each run is replaced by one definer call that re-checks the exact rows, so a
 * concurrent change only makes that run a no-op.
 */
export async function foldSessionTurnDeltas(
  db: Database,
  candidate: SessionDeltaFoldCandidate,
): Promise<{ runs: number; removedRows: number; refused: number }> {
  const scope = { accountId: candidate.accountId, workspaceId: candidate.workspaceId };
  const result = { runs: 0, removedRows: 0, refused: 0 };
  const [bounds] = await withRlsContext(db, scope, async (scoped) =>
    rawRows<{ first: number | null; last: number | null }>(
      scoped,
      sql`select min(sequence) as first, max(sequence) as last from session_events
        where workspace_id = ${candidate.workspaceId}::uuid
          and turn_id = ${candidate.turnId}::uuid
          and type in ('agent.message.delta', 'agent.reasoning.delta')`,
    ),
  );
  const first = bounds?.first === null || bounds?.first === undefined ? null : Number(bounds.first);
  const last = bounds?.last === null || bounds?.last === undefined ? null : Number(bounds.last);
  if (first !== null && last !== null && last > first) {
    const pending: SessionDeltaFoldRun[] = [];
    const planner = createSessionDeltaFoldPlanner((run) => pending.push(run));
    const applyPending = async () => {
      for (const run of pending.splice(0)) {
        const removed = await withRlsContext(db, scope, async (scoped) => {
          const [row] = await rawRows<{ removed: number }>(
            scoped,
            sql`select opengeni_private.fold_session_event_delta_run(
              ${candidate.workspaceId}::uuid, ${candidate.sessionId}::uuid,
              ${candidate.turnId}::uuid, ${run.first}::integer, ${run.last}::integer,
              ${`{${run.ids.join(",")}}`}::uuid[],
              ${JSON.stringify(toPostgresLosslessJson(run.payload))}::jsonb,
              ${LOSSLESS_CONTENT_CODEC_VERSION}::integer) as removed`,
          );
          return Number(row?.removed ?? -1);
        });
        if (removed < 0) {
          result.refused += 1;
        } else {
          result.runs += 1;
          result.removedRows += removed;
        }
      }
    };
    let after = first - 1;
    for (;;) {
      const rows = await withRlsContext(db, scope, async (scoped) =>
        rawRows<RawFoldRow>(
          scoped,
          sql`select e.id, e.sequence, e.type, e.turn_id, e.producer_id, e.producer_seq,
              e.turn_generation, e.turn_attempt_id, e.turn_association, e.client_event_id,
              e.duplicate_of_event_id,
              (extract(epoch from e.occurred_at) * 1000000)::bigint::text as occurred_us,
              (extract(epoch from e.created_at) * 1000000)::bigint::text as created_us,
              case when e.type in ('agent.message.delta', 'agent.reasoning.delta')
                then e.payload end as payload,
              e.payload_codec_version
            from session_events e
            where e.workspace_id = ${candidate.workspaceId}::uuid
              and e.session_id = ${candidate.sessionId}::uuid
              and e.sequence > ${after} and e.sequence <= ${last}
            order by e.sequence
            limit ${FOLD_PAGE_ROWS}`,
        ),
      );
      for (const row of rows) {
        planner.push({
          id: row.id,
          sequence: Number(row.sequence),
          type: row.type,
          turnId: row.turn_id,
          producerId: row.producer_id,
          producerSeq: row.producer_seq === null ? null : Number(row.producer_seq),
          turnGeneration: row.turn_generation === null ? null : Number(row.turn_generation),
          turnAttemptId: row.turn_attempt_id,
          turnAssociation: row.turn_association,
          clientEventId: row.client_event_id,
          duplicateOfEventId: row.duplicate_of_event_id,
          occurredUs: BigInt(row.occurred_us),
          createdUs: BigInt(row.created_us),
          payload:
            row.payload === null
              ? null
              : (fromPostgresLosslessJson(row.payload, row.payload_codec_version) as Record<
                  string,
                  unknown
                >),
        });
      }
      await applyPending();
      if (rows.length < FOLD_PAGE_ROWS) break;
      after = Number(rows.at(-1)!.sequence);
    }
    planner.finish();
    await applyPending();
  }
  await withRlsContext(db, scope, async (scoped) =>
    rawRows(
      scoped,
      sql`select opengeni_private.mark_session_turn_deltas_folded(
        ${candidate.workspaceId}::uuid, ${candidate.turnId}::uuid,
        ${result.runs}::integer, ${result.removedRows}::integer)`,
    ),
  );
  return result;
}
