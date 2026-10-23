import { createHash } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type {
  SessionMessageSearchRequest,
  SessionMessageSearchMatch,
  SessionMessageSearchResponse,
} from "@opengeni/contracts";
import type { Database } from "./database";
import * as schema from "./schema";
import { excludeUnclaimedHumanPromptEventFilter } from "./session-prompt-visibility";
import { readSessionMessageSliceInScope } from "./session-event-slices";
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
    skipSession: z.boolean().optional(),
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
type CandidateRow = {
  visited: number;
  lastSessionId: string | null;
  lastSequence: number | null;
  rank: number | null;
  sessionId: string | null;
  eventId: string | null;
  sequence: number | null;
  turnId: string | null;
  type: "user.message" | "agent.message.completed" | null;
  sessionTitle: string | null;
  messageId: unknown;
  codec: number | null;
  smallText: unknown;
};

/** Eligible messages one search statement reads, in key order. Small enough
 * that a cold window stays far below the request's statement timeout. */
export const SESSION_MESSAGE_SEARCH_WINDOW = 2_000;

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

// Highest code point with a Unicode case mapping (Adlam ends at U+1E943).
const LAST_CASED_CODE_POINT = 0x1ffff;
let caseClasses: ReadonlyMap<number, readonly number[]> | undefined;

/** Every code point that `sessionMessageLiteralPattern` treats as the same
 * character, keyed by each member. Characters absent from the map only match
 * themselves. Built once from the runtime's own case mappings and verified
 * against its `iu` matching, so the database filter agrees with the exact
 * JavaScript matcher (including K/k/U+212A, s/S/U+017F and the Greek sigmas).
 */
export function sessionMessageCaseClasses(): ReadonlyMap<number, readonly number[]> {
  if (caseClasses) return caseClasses;
  const edges = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    let set = edges.get(a);
    if (!set) edges.set(a, (set = new Set()));
    set.add(b);
  };
  for (let cp = 0; cp <= LAST_CASED_CODE_POINT; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const char = String.fromCodePoint(cp);
    for (const mapped of [char.toLowerCase(), char.toUpperCase()]) {
      if (mapped === char) continue;
      const target = mapped.codePointAt(0)!;
      if (String.fromCodePoint(target) !== mapped) continue;
      if (!sessionMessageLiteralPattern(char).test(mapped)) continue;
      link(cp, target);
      link(target, cp);
    }
  }
  const classes = new Map<number, readonly number[]>();
  for (const start of edges.keys()) {
    if (classes.has(start)) continue;
    const members = new Set([start]);
    for (const member of members) for (const next of edges.get(member) ?? []) members.add(next);
    const sorted = [...members].sort((a, b) => a - b);
    for (const member of sorted) classes.set(member, sorted);
  }
  return (caseClasses = classes);
}

/** A PostgreSQL advanced regular expression matching exactly the strings that
 * contain `query` under `sessionMessageLiteralPattern`. Every character is a
 * \u/\U escape, so no character is special and the database collation plays
 * no part. Null when the query holds a character PostgreSQL text cannot store
 * (NUL or a lone surrogate): only losslessly encoded text can contain it.
 */
export function sessionMessagePostgresPattern(query: string): string | null {
  const escape = (cp: number) =>
    cp <= 0xffff
      ? `\\u${cp.toString(16).padStart(4, "0")}`
      : `\\U${cp.toString(16).padStart(8, "0")}`;
  let pattern = "";
  for (const char of query) {
    const cp = char.codePointAt(0)!;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    const members = sessionMessageCaseClasses().get(cp);
    pattern += members ? `[${members.map(escape).join("")}]` : escape(cp);
  }
  return pattern;
}

/** Database tests over stored message text: `matched` is exact for ordinary
 * text; `encoded` marks losslessly encoded strings, which only the decoding
 * reader can inspect and so always remain candidates. */
export function sessionMessageTextMatchSql(
  query: string,
  text: SQL,
): { matched: SQL; encoded: SQL } {
  const pattern = sessionMessagePostgresPattern(query);
  return {
    matched: pattern === null ? sql`false` : sql`(${text} ~ ${pattern})`,
    encoded: sql`(left(${text}, ${LOSSLESS_JSON_STRING_PREFIX.length}) = ${LOSSLESS_JSON_STRING_PREFIX})`,
  };
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
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        workspaceId,
        authorityIdentity,
        request.query,
        request.sessionId ?? null,
        request.archiveStatus ?? "active",
        ...(request.groupBy ? [{ groupBy: request.groupBy }] : []),
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
        cursor.matched > cursor.occurrences ||
        (cursor.position.skipSession &&
          (request.groupBy !== "session" || !cursor.position.done || !cursor.position.matched))
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
  const c = schema.sessionMessageSearchTexts;
  // Candidates come from session_message_search_texts. Under row-level
  // security PostgreSQL only uses an index for a leakproof qualifier or one
  // that belongs to the row-security policy, and no text pattern operator is
  // leakproof, so the pattern is that table's restrictive policy: set here,
  // transaction-locally, it lets the trigram index find exactly the messages
  // whose text can contain the literal (plus losslessly encoded text, which
  // only the decoding reader can test). A query PostgreSQL text cannot hold
  // (NUL or a lone surrogate) leaves the pattern empty: only encoded text.
  await db.execute(
    sql`select pg_catalog.set_config('opengeni.session_message_search_pattern', ${
      sessionMessagePostgresPattern(request.query) ?? ""
    }, true)`,
  );
  // Bounded candidate windows in key order. Each statement reads at most
  // SESSION_MESSAGE_SEARCH_WINDOW eligible candidates, each joined to its
  // canonical event under that table's own policies and the list filters;
  // later windows run while the request budget lasts. Large scalar
  // continuations alone use the lossless slice reader.
  const limit = request.limit ?? 20;
  const budgetStarted = performance.now();
  let slots = 0;
  for (;;) {
    signal?.throwIfAborted();
    const boundary = position
      ? position.skipSession
        ? sql`${c.sessionId} > ${position.sessionId}::uuid`
        : sql`(${c.sessionId}, ${c.sequence}) ${position.done ? sql`>` : sql`>=`} (${position.sessionId}::uuid, ${position.sequence}::int)`
      : sql`true`;
    // One statement checks the next window's text in PostgreSQL and returns
    // only the first candidates that contain the literal. The cheap
    // list/visibility predicates and the text test run once per message; the
    // correlated canonical-copy and unclaimed-prompt checks run only for
    // candidates, lazily in key order, until the batch is full.
    //
    // Correlate the exact durable message identity, not turn status or latest
    // model context. The latest full completion for a provider message wins,
    // so an earlier shorter completion cannot hide later retained text. Same-
    // text distinct provider messages remain distinct; the id-less final
    // settlement copy is suppressed against its earlier complete text.
    // Suppression requires the competing copy to retain searchable string text
    // itself: a later text-less completion (failed/empty retry sharing the
    // provider message id) must never hide the earlier complete text.
    const textMatch = sessionMessageTextMatchSql(request.query, sql`${e.payload}->>'text'`);
    const rows: CandidateRow[] = await db.execute<CandidateRow>(sql`
      with eligible as materialized (
        select ${e.id} as id, ${e.sessionId} as session_id, ${e.sequence} as sequence,
          ${textMatch.matched} as matched, ${textMatch.encoded} as encoded
        from ${c}
        inner join ${e} on ${e.workspaceId} = ${c.workspaceId}
          and ${e.sessionId} = ${c.sessionId} and ${e.sequence} = ${c.sequence}
        inner join ${schema.sessions}
          on ${schema.sessions.workspaceId} = ${e.workspaceId} and ${schema.sessions.id} = ${e.sessionId}
        where ${and(
          eq(c.workspaceId, workspaceId),
          eq(e.workspaceId, workspaceId),
          ...filters,
          boundary,
          request.sessionId ? eq(c.sessionId, request.sessionId) : sql`true`,
          sql`${e.type} in ('user.message', 'agent.message.completed')`,
          sql`(${e.turnAssociation} is null or ${e.turnAssociation} = 'current')`,
          sql`${e.duplicateOfEventId} is null`,
          sql`jsonb_typeof(${e.payload}->'text') = 'string'`,
        )}
        order by ${c.sessionId}, ${c.sequence}
        limit ${sql.raw(String(SESSION_MESSAGE_SEARCH_WINDOW))}
      ), visited as (
        select count(*)::int as visited from eligible
      ), last_visited as (
        select eligible.session_id as "lastSessionId", eligible.sequence as "lastSequence"
        from eligible
        order by eligible.session_id desc, eligible.sequence desc
        limit 1
      )
      select visited.visited, last_visited.*, candidate.*
      from visited
      left join last_visited on true
      left join lateral (
        select * from (
          select valid.*${
            request.groupBy === "session"
              ? sql`, (count(*) filter (where valid.definite) over (partition by valid."sessionId"
                  order by valid.sequence rows between unbounded preceding and 1 preceding))::int as earlier`
              : sql``
          }
          from (
        select ranked.rank, ranked.session_id as "sessionId", ${e.id} as "eventId",
          ranked.sequence as sequence, ${e.turnId} as "turnId", ${e.type} as type,
          ranked.matched and not ranked.encoded as definite,
          case when octet_length(${schema.sessions.title}) <= 2048 then ${schema.sessions.title} else null end as "sessionTitle",
          case when octet_length((${e.payload}->'messageId')::text) <= 2048 then ${e.payload}->'messageId' else null end as "messageId",
          ${e.payloadCodecVersion} as codec,
          case when octet_length(${e.payload}->>'text') <= 8192 then ${e.payload}->'text' else null end as "smallText"
        from (
          select eligible.id, eligible.session_id, eligible.sequence, eligible.matched, eligible.encoded,
            (row_number() over (order by eligible.session_id, eligible.sequence))::int as rank
          from eligible
          order by eligible.session_id, eligible.sequence
          offset 0
        ) ranked
        inner join ${e} on ${e.workspaceId} = ${workspaceId} and ${e.id} = ranked.id
        inner join ${schema.sessions}
          on ${schema.sessions.workspaceId} = ${e.workspaceId} and ${schema.sessions.id} = ${e.sessionId}
        where (ranked.matched or ranked.encoded)
          and ${excludeUnclaimedHumanPromptEventFilter(workspaceId)}
          and (${e.type} <> 'agent.message.completed' or not exists (
        select 1 from ${schema.sessionEvents} other_message
        where other_message.workspace_id = ${workspaceId} and other_message.session_id = ${e.sessionId}
          and other_message.turn_id = ${e.turnId}
          and other_message.type = 'agent.message.completed' and other_message.duplicate_of_event_id is null
          and (other_message.turn_association is null or other_message.turn_association = 'current')
          and jsonb_typeof(other_message.payload->'text') = 'string'
          and ((jsonb_typeof(${e.payload}->'messageId') = 'string'
              and other_message.sequence > ${e.sequence}
              and other_message.payload->'messageId' = ${e.payload}->'messageId'
              and (other_message.payload_codec_version is not distinct from ${e.payloadCodecVersion}
                or left(${e.payload}->>'messageId', ${LOSSLESS_JSON_STRING_PREFIX.length}) <> ${LOSSLESS_JSON_STRING_PREFIX}))
            or (coalesce(${e.payload}->>'messageId', '') = ''
              and other_message.sequence < ${e.sequence}
              and other_message.payload->'text' = ${e.payload}->'text'
              and (other_message.payload_codec_version is not distinct from ${e.payloadCodecVersion}
                or left(${e.payload}->>'text', ${LOSSLESS_JSON_STRING_PREFIX.length}) <> ${LOSSLESS_JSON_STRING_PREFIX})))))
        order by ranked.session_id, ranked.sequence
        offset 0
          ) valid
        ) grouped
        -- Grouping needs only each session's first certain hit. Encoded text
        -- stays a candidate because only the decoding reader can confirm it.
        where ${request.groupBy === "session" ? sql`grouped.earlier = 0` : sql`true`}
        order by grouped."sessionId", grouped.sequence
        limit 33
      ) candidate on true
      order by candidate.rank
    `);
    const visited = rows[0]?.visited ?? 0;
    const lastSessionId = rows[0]?.lastSessionId ?? null;
    const lastSequence = rows[0]?.lastSequence ?? null;
    const identities = rows.flatMap((row: CandidateRow) =>
      row.rank === null ||
      row.sessionId === null ||
      row.eventId === null ||
      row.sequence === null ||
      row.type === null
        ? []
        : [
            {
              ...row,
              rank: row.rank,
              sessionId: row.sessionId,
              eventId: row.eventId,
              sequence: row.sequence,
              type: row.type,
            },
          ],
    );
    // The cursor's message being resumed mid-text is the first visited row
    // again; it was already counted by the request that started it.
    const visitedBefore = scanned - (position && !position.done ? 1 : 0);
    let identityIndex = 0;
    let interrupted = false;
    for (; matches.length < limit; slots++) {
      signal?.throwIfAborted();
      if (slots >= 32 || (slots > 0 && performance.now() - budgetStarted >= 1_500)) {
        interrupted = true;
        break;
      }
      const identity = identities[identityIndex];
      if (!identity) break;
      const continuing =
        position &&
        !position.done &&
        position.sessionId === identity.sessionId &&
        position.sequence === identity.sequence;
      if (!continuing) {
        scanned = visitedBefore + identity.rank;
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
      // Amortize full-source detoasting/codec validation over adjacent windows,
      // not a larger request budget. A four-window read consumes four of the
      // original 32 slots, even if a match/short source ends it early.
      const scalarWindows = typeof smallText === "string" ? 1 : Math.min(4, 32 - slots);
      const slice =
        typeof smallText === "string"
          ? {
              offset: 0,
              total: smallText.length,
              unit: "utf16" as const,
              text: smallText,
              omitted: false,
            }
          : await readSessionMessageSliceInScope(
              db,
              workspaceId,
              identity.sessionId,
              {
                id: identity.eventId,
                sequence: identity.sequence,
                type: identity.type,
                turnId: identity.turnId,
                turnAssociation: null,
                duplicateOfEventId: null,
              },
              offset,
              scalarWindows,
            );
      slots += scalarWindows - 1;
      if (!slice || slice.omitted) {
        // Deletion/visibility changes never turn into a fabricated message.
        position = { ...position!, done: true };
        identityIndex++;
        continue;
      }
      pattern.lastIndex = Math.max(0, position!.minimumMatchOffset - utf16Offset);
      let found: RegExpExecArray | null;
      const messageId = fromPostgresLosslessJson(identity.messageId, identity.codec);
      while (matches.length < limit && (found = pattern.exec(slice.text))) {
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
        if (request.groupBy === "session") {
          position = { ...position, done: true, skipSession: true };
          break;
        }
      }
      if (position!.skipSession) {
        // Skip both buffered messages and all unbuffered history of this
        // matching session. The next cursor carries a strict session boundary,
        // so a prolific message cannot flood the workspace picker with pages.
        do {
          identityIndex++;
        } while (identities[identityIndex]?.sessionId === identity.sessionId);
        continue;
      }
      const units = slice.unit === "utf16" ? slice.text.length : Array.from(slice.text).length;
      if (matches.length >= limit) {
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
    // Every candidate of a short final window is done: the search is complete.
    const drained = identityIndex >= identities.length && identities.length < 33;
    if (drained && (visited < SESSION_MESSAGE_SEARCH_WINDOW || lastSessionId === null)) {
      scanned = visitedBefore + visited;
      exhausted = true;
      break;
    }
    if (matches.length >= limit || interrupted) break;
    // The buffered candidates are done. A full candidate batch may leave later
    // candidates in this window: the next statement resumes after the last.
    if (drained && lastSessionId !== null && lastSequence !== null) {
      scanned = visitedBefore + visited;
      // Nothing else in this window contains the literal: resume after it.
      // A session that already gave its grouped hit stays skipped.
      if (!(position?.skipSession && position.sessionId === lastSessionId))
        position = {
          sessionId: lastSessionId,
          sequence: lastSequence,
          offset: 0,
          utf16Offset: 0,
          minimumMatchOffset: 0,
          matched: false,
          done: true,
        };
    }
    if (performance.now() - budgetStarted >= 1_500) break;
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
            JSON.stringify({
              version: 1,
              binding,
              position,
              scanned,
              matched,
              occurrences,
            }),
          ).toString("base64url"),
  };
}
