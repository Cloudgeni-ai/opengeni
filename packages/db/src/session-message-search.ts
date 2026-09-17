import { createHash } from "node:crypto";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type {
  SessionMessageSearchRequest,
  SessionMessageSearchMatch,
  SessionMessageSearchResponse,
} from "@opengeni/contracts";
import type { Database } from "./database";
import * as schema from "./schema";
import { listSessionEventSlices } from "./session-event-slices";
import { fromPostgresLosslessJson, LOSSLESS_JSON_STRING_PREFIX } from "./lossless-json";

const Position = z
  .object({
    sessionId: z.string().uuid(),
    sequence: z.number().int().min(1).max(2_147_483_647),
    offset: z.number().int().min(0).max(2_147_483_647),
    utf16Offset: z.number().int().min(0).max(4_294_967_294),
    minimumMatchOffset: z.number().int().min(0).max(4_294_967_294),
    matched: z.boolean(),
    done: z.boolean(),
  })
  .strict();
const Cursor = z
  .object({
    version: z.literal(1),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    position: Position,
    scanned: z.number().int().nonnegative().safe(),
    matched: z.number().int().nonnegative().safe(),
    occurrences: z.number().int().nonnegative().safe(),
  })
  .strict();
type Position = z.infer<typeof Position>;

export class SessionMessageSearchCursorError extends Error {
  constructor() {
    super("Invalid session message search cursor or changed search scope");
  }
}

/** ECMAScript Unicode simple case folding, not locale-sensitive lowercasing.
 * Escaping every regexp metacharacter makes %, _, backslash, etc. literal too.
 * RegExp indices refer to original UTF-16 text (no lowercased-offset drift).
 */
export function sessionMessageLiteralPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
}

export function sessionMessageSearchSnippet(text: string, start: number, length: number) {
  let left = Math.max(0, start - 120);
  let right = Math.min(text.length, start + length + 120);
  if (left > 0 && /[\uDC00-\uDFFF]/.test(text[left]!)) left--;
  if (right < text.length && /[\uDC00-\uDFFF]/.test(text[right]!)) right++;
  return {
    text: text.slice(left, right),
    matchStart: start - left,
    matchEnd: start + length - left,
  };
}

/** Internal executor: caller holds subject RLS, session-tenancy and membership
 * fences and supplies the ordinary session list filters. Never call as auth.
 * Work/transfer is bounded by 32 scalar windows per request. No history cutoff:
 * an unfinished scan ALWAYS returns an advancing cursor, even with zero hits.
 */
export async function scanSessionMessages(
  db: Database,
  workspaceId: string,
  request: SessionMessageSearchRequest,
  filters: SQL[],
  authorityIdentity: unknown,
  signal?: AbortSignal,
): Promise<SessionMessageSearchResponse> {
  signal?.throwIfAborted();
  const started = performance.now();
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        workspaceId,
        authorityIdentity,
        request.query,
        request.sessionId ?? null,
        request.archiveStatus ?? "active",
      ]),
    )
    .digest("hex");
  let position: Position | null = null;
  let scanned = 0;
  let matched = 0;
  let occurrences = 0;
  if (request.cursor) {
    try {
      const cursor = Cursor.parse(
        JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.binding !== binding ||
        cursor.matched > cursor.scanned ||
        cursor.matched > cursor.occurrences
      )
        throw new Error();
      position = cursor.position;
      scanned = cursor.scanned;
      matched = cursor.matched;
      occurrences = cursor.occurrences;
    } catch {
      throw new SessionMessageSearchCursorError();
    }
  }
  const pattern = new RegExp(sessionMessageLiteralPattern(request.query), "giu");
  const matches: SessionMessageSearchMatch[] = [];
  let exhausted = false;
  const e = schema.sessionEvents;
  // One bounded batch for ordinary complete messages. Large scalar continuations
  // alone use the existing lossless slice reader. There is no per-message SQL
  // round trip for the common small-message/no-hit path.
  {
    const boundary = position
      ? sql`(${e.sessionId} > ${position.sessionId}::uuid or (${e.sessionId} = ${position.sessionId}::uuid and ${position.done ? sql`${e.sequence} > ${position.sequence}` : sql`${e.sequence} >= ${position.sequence}`}))`
      : sql`true`;
    // Correlate the exact durable message identity, not turn status or latest
    // model context. The latest full completion for a provider message wins,
    // so an earlier shorter completion cannot hide later retained text. Same-
    // text distinct provider messages remain distinct; the id-less final
    // settlement copy is suppressed against its earlier complete text.
    const identities = await db
      .select({
        sessionId: e.sessionId,
        eventId: e.id,
        sequence: e.sequence,
        turnId: e.turnId,
        type: e.type,
        sessionTitle: sql<
          string | null
        >`case when octet_length(${schema.sessions.title}) <= 2048 then ${schema.sessions.title} else null end`,
        messageId: sql<unknown>`case when octet_length((${e.payload}->'messageId')::text) <= 2048 then ${e.payload}->'messageId' else null end`,
        codec: e.payloadCodecVersion,
        smallText: sql<unknown>`case when octet_length(${e.payload}->>'text') <= 8192 then ${e.payload}->'text' else null end`,
      })
      .from(e)
      .innerJoin(
        schema.sessions,
        and(eq(schema.sessions.workspaceId, e.workspaceId), eq(schema.sessions.id, e.sessionId)),
      )
      .where(
        and(
          eq(e.workspaceId, workspaceId),
          ...filters,
          boundary,
          request.sessionId ? eq(e.sessionId, request.sessionId) : sql`true`,
          sql`${e.type} in ('user.message', 'agent.message.completed')`,
          sql`(${e.turnAssociation} is null or ${e.turnAssociation} = 'current')`,
          sql`${e.duplicateOfEventId} is null`,
          sql`jsonb_typeof(${e.payload}->'text') = 'string'`,
          sql`(${e.type} <> 'user.message' or not exists (
        select 1 from ${schema.sessionTurns} unclaimed
        where unclaimed.workspace_id = ${workspaceId} and unclaimed.session_id = ${e.sessionId}
          and unclaimed.trigger_event_id = ${e.id} and unclaimed.source in ('user', 'api')
          and unclaimed.started_at is null))`,
          sql`(${e.type} <> 'agent.message.completed' or not exists (
        select 1 from ${schema.sessionEvents} other_message
        where other_message.workspace_id = ${workspaceId} and other_message.session_id = ${e.sessionId}
          and other_message.turn_id = ${e.turnId}
          and other_message.type = 'agent.message.completed' and other_message.duplicate_of_event_id is null
          and (other_message.turn_association is null or other_message.turn_association = 'current')
          and ((jsonb_typeof(${e.payload}->'messageId') = 'string'
              and other_message.sequence > ${e.sequence}
              and other_message.payload->'messageId' = ${e.payload}->'messageId'
              and (other_message.payload_codec_version is not distinct from ${e.payloadCodecVersion}
                or left(${e.payload}->>'messageId', ${LOSSLESS_JSON_STRING_PREFIX.length}) <> ${LOSSLESS_JSON_STRING_PREFIX}))
            or (coalesce(${e.payload}->>'messageId', '') = ''
              and other_message.sequence < ${e.sequence}
              and other_message.payload->'text' = ${e.payload}->'text'
              and (other_message.payload_codec_version is not distinct from ${e.payloadCodecVersion}
                or left(${e.payload}->>'text', ${LOSSLESS_JSON_STRING_PREFIX.length}) <> ${LOSSLESS_JSON_STRING_PREFIX})))))`,
        ),
      )
      .orderBy(asc(e.sessionId), asc(e.sequence))
      .limit(33);
    let identityIndex = 0;
    for (let window = 0; window < 32 && matches.length < (request.limit ?? 20); window++) {
      signal?.throwIfAborted();
      if (window > 0 && performance.now() - started >= 1_500) break;
      const identity = identities[identityIndex];
      if (!identity) {
        exhausted = true;
        break;
      }
      const continuing =
        position &&
        !position.done &&
        position.sessionId === identity.sessionId &&
        position.sequence === identity.sequence;
      if (!continuing) {
        scanned++;
        position = {
          sessionId: identity.sessionId,
          sequence: identity.sequence,
          offset: 0,
          utf16Offset: 0,
          minimumMatchOffset: 0,
          matched: false,
          done: false,
        };
      }
      const offset = position!.offset;
      const utf16Offset = position!.utf16Offset;
      const smallText = fromPostgresLosslessJson(identity.smallText, identity.codec);
      const slice =
        typeof smallText === "string"
          ? {
              offset: 0,
              total: smallText.length,
              unit: "utf16" as const,
              text: smallText,
              omitted: false,
            }
          : (
              await listSessionEventSlices(db, workspaceId, identity.sessionId, {
                sourceSequence: identity.sequence,
                sourceOffset: offset,
                after: identity.sequence - 1,
                before: identity.sequence + 1,
                includeTypes: ["user.message", "agent.message.completed"],
                view: "conversation",
              })
            ).slices?.[identity.sequence];
      if (!slice || slice.omitted) {
        // Deletion/visibility changes never turn into a fabricated message.
        position = { ...position!, done: true };
        identityIndex++;
        continue;
      }
      pattern.lastIndex = Math.max(0, position!.minimumMatchOffset - utf16Offset);
      let found: RegExpExecArray | null;
      const messageId = fromPostgresLosslessJson(identity.messageId, identity.codec);
      while (matches.length < (request.limit ?? 20) && (found = pattern.exec(slice.text))) {
        matches.push({
          sessionId: identity.sessionId,
          sessionTitle: identity.sessionTitle,
          eventId: identity.eventId,
          sequence: identity.sequence,
          turnId: identity.turnId,
          role: identity.type === "user.message" ? "user" : "assistant",
          messageId: typeof messageId === "string" ? messageId : null,
          messageMatchOffset: utf16Offset + found.index,
          snippet: sessionMessageSearchSnippet(slice.text, found.index, found[0].length),
        });
        if (!position!.matched) matched++;
        occurrences++;
        position = {
          ...position!,
          matched: true,
          minimumMatchOffset: utf16Offset + found.index + found[0].length,
        };
      }
      const units = slice.unit === "utf16" ? slice.text.length : Array.from(slice.text).length;
      if (matches.length >= (request.limit ?? 20)) {
        if (
          offset + units >= slice.total &&
          position!.minimumMatchOffset >= utf16Offset + slice.text.length
        ) {
          position = { ...position!, done: true };
          identityIndex++;
        }
        break;
      }
      if (offset + units >= slice.total) {
        position = { ...position!, done: true };
        identityIndex++;
        continue;
      }
      // Overlap enough complete scalars for every literal crossing a window.
      // Retain additional preceding snippet context; resume offset is absolute
      // UTF-16 so supplementary characters and lossless code units cannot drift.
      const overlap = request.query.length * 2 + 122;
      let advance = Math.max(1, units - overlap);
      let prefix =
        slice.unit === "utf16"
          ? slice.text.slice(0, advance)
          : Array.from(slice.text).slice(0, advance).join("");
      if (slice.unit === "utf16" && /[\uD800-\uDBFF]/.test(prefix.at(-1)!)) {
        advance--;
        prefix = prefix.slice(0, -1);
      }
      position = {
        ...position!,
        offset: offset + advance,
        utf16Offset: utf16Offset + prefix.length,
        minimumMatchOffset: Math.max(position!.minimumMatchOffset, utf16Offset + prefix.length),
        done: false,
      };
    }
    if (identityIndex >= identities.length && identities.length < 33) exhausted = true;
  }
  signal?.throwIfAborted();
  return {
    matches,
    hasMore: !exhausted,
    countIsExact: exhausted,
    scannedMessages: scanned,
    matchedMessageCount: matched,
    matchedOccurrenceCount: occurrences,
    nextCursor:
      exhausted || !position
        ? null
        : Buffer.from(
            JSON.stringify({ version: 1, binding, position, scanned, matched, occurrences }),
          ).toString("base64url"),
  };
}
