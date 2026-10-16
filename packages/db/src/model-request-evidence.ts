import {
  ModelRequestEvidenceSchema,
  type ModelRequestEvidence,
  type SessionModelEvidencePage,
} from "@opengeni/contracts";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import * as schema from "./schema";
import { fromPostgresLosslessJson } from "./lossless-json";
import {
  chunkTextByContent,
  digestContentValue,
  readSessionContentBlobs,
  writeSessionContentBlobs,
} from "./session-content-blobs";

type Scope = { accountId: string; workspaceId: string; sessionId: string };

export function encodeModelEvidenceContent(record: ModelRequestEvidence) {
  const blobs = new Map<string, unknown>();
  const contentRefs = chunkTextByContent(JSON.stringify(record.content)).map((chunk) => {
    // An object envelope avoids driver double-decoding of a JSON-valid string.
    // This is a new codec only; historical snapshot/blob bytes stay unchanged.
    const value = { text: chunk };
    const digest = digestContentValue(value);
    blobs.set(digest, value);
    return digest;
  });
  return { stored: { ...record, content: null, contentRefs }, blobs };
}

export function decodeModelEvidenceContent(
  record: ModelRequestEvidence,
  blobs: ReadonlyMap<string, unknown>,
): ModelRequestEvidence {
  if (!record.contentRefs) return record;
  const text = record.contentRefs
    .map((digest) => {
      const value = blobs.get(digest);
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as { text?: unknown }).text !== "string" ||
        digestContentValue(value) !== digest
      )
        throw new Error("Model evidence content missing or corrupt");
      return (value as { text: string }).text;
    })
    .join("");
  const { contentRefs: _refs, ...rest } = record;
  return { ...rest, content: JSON.parse(text) };
}

/** Event publication still uses the canonical attempt-fenced worker publisher.
 * A failed/stale publication may leave deduplicated blobs, never accepted evidence. */
export async function storeModelEvidenceContent(
  db: Database,
  input: Scope & {
    attemptId: string;
    turnId: string;
    executionGeneration: number;
    record: ModelRequestEvidence;
  },
): Promise<ModelRequestEvidence> {
  const encoded = encodeModelEvidenceContent(input.record);
  ModelRequestEvidenceSchema.parse(input.record);
  await withRlsContext(db, input, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(schema.sessionTurnAttempts)
        .where(
          and(
            eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
            eq(schema.sessionTurnAttempts.id, input.attemptId),
          ),
        )
        .limit(1);
      if (
        !attempt ||
        attempt.accountId !== input.accountId ||
        attempt.sessionId !== input.sessionId ||
        attempt.turnId !== input.turnId ||
        attempt.executionGeneration !== input.executionGeneration
      )
        throw new Error("Model evidence exact attempt mismatch");
      await writeSessionContentBlobs(tx, input, encoded.blobs);
    }),
  );
  return encoded.stored;
}

/** Authorized callers must first resolve session visibility. Children are separate pages.
 * Archived content is available in the existing verified archive bundle, not fabricated here. */
export async function getSessionModelEvidence(
  db: Database,
  input: Scope & {
    afterSequence?: number | undefined;
    throughSequence?: number | undefined;
    limit?: number | undefined;
  },
): Promise<SessionModelEvidencePage> {
  const after = input.afterSequence ?? 0;
  const limit = input.limit ?? 10;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    (input.throughSequence !== undefined &&
      (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < after))
  )
    throw new RangeError("Invalid model evidence page cursor");
  return withRlsContext(db, input, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [session] = await tx
        .select({ archive: schema.sessions.contentArchiveState })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        )
        .limit(1);
      if (!session) throw new Error("Session not found");
      const [cursor] = await tx
        .select({ last: schema.sessionEventCursors.lastSequence })
        .from(schema.sessionEventCursors)
        .where(
          and(
            eq(schema.sessionEventCursors.workspaceId, input.workspaceId),
            eq(schema.sessionEventCursors.sessionId, input.sessionId),
          ),
        )
        .limit(1);
      const through = input.throughSequence ?? cursor?.last ?? 0;
      if (after > through || through > (cursor?.last ?? 0))
        throw new RangeError("Model evidence watermark is in the future");
      const attempts = await tx
        .select({ id: schema.sessionTurnAttempts.id })
        .from(schema.sessionTurnAttempts)
        .where(
          and(
            eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
            eq(schema.sessionTurnAttempts.sessionId, input.sessionId),
          ),
        )
        .orderBy(asc(schema.sessionTurnAttempts.id))
        .limit(4097);
      const base = {
        sessionId: input.sessionId,
        scope: "session_only" as const,
        afterSequence: after,
        attemptInventory: {
          ids: attempts.slice(0, 4096).map((row) => row.id),
          truncated: attempts.length > 4096,
        },
        throughSequence: through,
        completeness: "requires_all_pages_and_scope_check" as const,
      };
      if (session.archive === "archived")
        return {
          ...base,
          availability: "archived",
          events: [],
          nextAfterSequence: after,
          hasMore: false,
        };
      const rows = await tx
        .select()
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.sessionId, input.sessionId),
            eq(schema.sessionEvents.type, "agent.model.evidence"),
            eq(schema.sessionEvents.turnAssociation, "current"),
            gt(schema.sessionEvents.sequence, after),
            lte(schema.sessionEvents.sequence, through),
          ),
        )
        .orderBy(asc(schema.sessionEvents.sequence))
        .limit(limit + 1);
      const selected = rows.slice(0, limit);
      const events = [] as SessionModelEvidencePage["events"];
      // Bound hydrated response bytes independently of event count. Always make progress.
      let bytes = 0;
      for (const row of selected) {
        const stored = fromPostgresLosslessJson(
          row.payload,
          row.payloadCodecVersion,
        ) as ModelRequestEvidence;
        ModelRequestEvidenceSchema.parse(stored);
        let record: ModelRequestEvidence;
        try {
          record = decodeModelEvidenceContent(
            stored,
            await readSessionContentBlobs(tx, input, stored.contentRefs ?? []),
          );
        } catch {
          record = {
            ...stored,
            status: "unavailable",
            reason: "stored_content_missing_or_corrupt",
            content: null,
          };
        }
        const size = Buffer.byteLength(JSON.stringify(record));
        if (events.length && bytes + size > 8 * 1024 * 1024) break;
        bytes += size;
        events.push({
          id: row.id,
          sequence: row.sequence,
          turnId: row.turnId,
          attemptId: row.turnAttemptId,
          record,
        });
      }
      return {
        ...base,
        availability: "live",
        events,
        nextAfterSequence: events.at(-1)?.sequence ?? after,
        hasMore: rows.length > events.length,
      };
    }),
  );
}
