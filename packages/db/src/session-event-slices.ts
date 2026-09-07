import { and, asc, desc, eq, gt, inArray, lt, notInArray, sql, type SQL } from "drizzle-orm";
import { resolveSessionEventTypeFilters, type SessionEvent } from "@opengeni/contracts";
import { rawRows, withWorkspaceRls, type Database } from "./database";
type ListSessionEventPageOptions = import("./index").ListSessionEventPageOptions;
type SessionEventPage = import("./index").SessionEventPage;
import { fromPostgresLosslessJson, LOSSLESS_JSON_STRING_PREFIX } from "./lossless-json";
import * as schema from "./schema";

export type SessionEventSliceOptions = ListSessionEventPageOptions & {
  sourceSequence?: number;
  sourceOffset?: number;
  view?: "conversation" | "results" | "tools";
  includeArguments?: boolean;
  includeOutput?: boolean;
  legacyUtf16?: boolean;
};
export type SessionEventSlice = {
  offset: number;
  total: number;
  unit: "codepoint" | "utf16";
  text: string;
  omitted: boolean;
};
export type SessionEventSlicePage = SessionEventPage & {
  slices?: Record<number, SessionEventSlice>;
};
const WINDOW = 8192;
const STRUCTURED_BYTES = 1024 * 1024;

/** Bounded transfer over retained scalar truth. JSONB extraction/detoasting still
 * costs PostgreSQL work proportional to the individual source value, not history.
 * This is a read projection, not authorization: the MCP caller must authorize the
 * target on every request. Both metadata and scalar reads retain workspace RLS.
 */
export async function listSessionEventSlices(
  db: Database,
  workspaceId: string,
  sessionId: string,
  options: SessionEventSliceOptions,
  legacyRead?: (options: ListSessionEventPageOptions) => Promise<SessionEventPage>,
): Promise<SessionEventSlicePage> {
  // Finish an already-issued UTF-16 cursor using its original bounded reader.
  // New messages use source slices; no cursor offset is silently reinterpreted.
  if (options.legacyUtf16) {
    if (!legacyRead) throw new Error("Legacy continuation requires its original bounded reader");
    return legacyRead({
      ...options,
      limit: 1,
      maxBytes: 1024 * 1024,
    });
  }
  const offset = options.sourceOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_647)
    throw new Error("Invalid message continuation offset");
  const direction = options.direction ?? (options.before === undefined ? "after" : "before");
  const limit = options.sourceSequence ? 1 : Math.max(1, Math.min(options.limit ?? 8, 8));
  const filters = resolveSessionEventTypeFilters(options);
  const predicates: SQL[] = [
    eq(schema.sessionEvents.workspaceId, workspaceId),
    eq(schema.sessionEvents.sessionId, sessionId),
    gt(schema.sessionEvents.sequence, Math.min(options.after ?? 0, 2_147_483_647)),
    // Same indexed exclusion as the audit/discovery reader. Do not substitute
    // turn status: terminal-before-claim prompts must remain excluded too.
    sql`(${schema.sessionEvents.type} <> 'user.message' or not exists (
      select 1 from ${schema.sessionTurns} unclaimed_prompt_turn
      where unclaimed_prompt_turn.workspace_id = ${workspaceId}
        and unclaimed_prompt_turn.workspace_id = ${schema.sessionEvents.workspaceId}
        and unclaimed_prompt_turn.session_id = ${schema.sessionEvents.sessionId}
        and unclaimed_prompt_turn.trigger_event_id = ${schema.sessionEvents.id}
        and unclaimed_prompt_turn.source in ('user', 'api')
        and unclaimed_prompt_turn.started_at is null
    ))`,
  ];
  if (options.before !== undefined && options.before <= 2_147_483_647)
    predicates.push(lt(schema.sessionEvents.sequence, options.before));
  if (filters.includeTypes.length)
    predicates.push(inArray(schema.sessionEvents.type, filters.includeTypes));
  if (filters.excludeTypes.length)
    predicates.push(notInArray(schema.sessionEvents.type, filters.excludeTypes));
  // Unlike audit `none` mode, this identity query does not compute a payload
  // projection merely to report its size. Only the selected scalar is extracted.
  const identities = await withWorkspaceRls(db, workspaceId, (tx) =>
    tx
      .select({
        id: schema.sessionEvents.id,
        sequence: schema.sessionEvents.sequence,
        type: sql<string>`case when octet_length(${schema.sessionEvents.type}) <= 256 then ${schema.sessionEvents.type} else 'session.event.envelope_omitted' end`,
        turnId: schema.sessionEvents.turnId,
        turnAssociation: sql<
          string | null
        >`case when ${schema.sessionEvents.turnAssociation} is null then null when ${schema.sessionEvents.turnAssociation} = 'current' then 'current' else 'late_rejected' end`,
        duplicateOfEventId: schema.sessionEvents.duplicateOfEventId,
      })
      .from(schema.sessionEvents)
      .where(and(...predicates))
      .orderBy(
        direction === "before"
          ? desc(schema.sessionEvents.sequence)
          : asc(schema.sessionEvents.sequence),
      )
      .limit(limit + 1),
  );
  const ordered = identities.slice(0, limit).map(
    (identity) =>
      ({
        ...identity,
        workspaceId,
        sessionId,
        payload: {},
        occurredAt: "",
      }) as SessionEvent,
  );
  const page: SessionEventPage = {
    events: [],
    hasMore: identities.length > limit,
    bytes: 2,
    fullPayloadsExact: true,
    direction,
    coveredSequence: null,
    nextAfter: null,
    nextBefore: null,
    truncatedBy: identities.length > limit ? "count" : null,
  };
  const slices: Record<number, SessionEventSlice> = {};
  const events: SessionEvent[] = [];
  let consumed = 0;
  await withWorkspaceRls(db, workspaceId, async (tx) => {
    for (const event of ordered) {
      consumed++;
      if (
        event.duplicateOfEventId ||
        (event.turnAssociation && event.turnAssociation !== "current")
      )
        continue;
      const p = schema.sessionEvents.payload;
      const output = event.type === "agent.toolCall.output";
      let value: SQL = sql`${p}->'text'`;
      if (options.view === "tools")
        value = output
          ? sql`${p}->'output'`
          : sql`coalesce(nullif(${p}->'arguments', 'null'::jsonb), ${p}->'args')`;
      else if (options.view === "results")
        value =
          event.type === "turn.completed"
            ? sql`coalesce(nullif(${p}->'output', 'null'::jsonb), ${p}->'result')`
            : sql`${p}`;
      const include =
        options.view !== "tools" || (output ? options.includeOutput : options.includeArguments);
      if (!include) value = sql`null::jsonb`;
      const start = options.sourceSequence === event.sequence ? offset : 0;
      const prefix = LOSSLESS_JSON_STRING_PREFIX;
      const raw = sql`raw`;
      const encoded = sql`encoded`;
      // Match exactly the JS codec's canonical-base64/even-byte acceptance.
      // A malformed active marker remains literal, just like the shared codec.
      const tagged = sql`case when version = 1
        and left(${raw}, ${prefix.length}) = ${prefix}
        and length(${encoded}) > 0
        and ${encoded} ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
        then (length(${encoded}) / 4 * 3 - case when right(${encoded}, 2) = '==' then 2 when right(${encoded}, 1) = '=' then 1 else 0 end) % 2 = 0
          and encode(decode(right(${encoded}, 4), 'base64'), 'base64') = right(${encoded}, 4)
        else false end`;
      // Aligned base64 windows represent groups of three UTF-16 units. Include
      // one preceding and one following unit to validate/avoid pair splits.
      const group = Math.floor(Math.max(0, start - 1) / 3);
      const safeMetadata = (key: string) =>
        sql`case when octet_length((${p}->${key})::text) <= 4096 then ${p}->${key} else null end`;
      const callId = sql`coalesce(nullif(${p}->'callId', 'null'::jsonb), nullif(${p}->'call_id', 'null'::jsonb), ${p}->'id')`;
      const metadataSql =
        options.view === "tools"
          ? sql`jsonb_strip_nulls(jsonb_build_object(
          'callId', case when octet_length((${callId})::text) <= 4096 then ${callId} else null end,
          'identityOmitted', case when octet_length((${callId})::text) > 4096 or octet_length((${p}->'name')::text) > 4096 then true else null end,
          'name', ${safeMetadata("name")}, 'isError', case when ${p}->'isError' = 'true'::jsonb or (${output} and ${p}->'output'->'isError' = 'true'::jsonb) then true else null end,
          'maintenance', case when ${p} ? 'maintenance' then true else null end,
          'segmentLimit', case when ${p} ? 'segmentLimit' then true else null end))`
          : options.view === "results" && event.type === "turn.completed"
            ? sql`jsonb_strip_nulls(jsonb_build_object(
            'maintenance', case when ${p} ? 'maintenance' then true else null end,
            'segmentLimit', case when ${p} ? 'segmentLimit' then true else null end))`
            : sql`'{}'::jsonb`;
      const [row] = await rawRows<{
        metadata: unknown;
        version: number | null;
        kind: string | null;
        tagged: boolean;
        total: number;
        window: string | null;
        structured: unknown;
        omitted: boolean;
      }>(
        tx,
        sql`with source as (
        select ${value} as value, ${metadataSql} as metadata,
          ${schema.sessionEvents.payloadCodecVersion} as version
        from ${schema.sessionEvents}
        where ${schema.sessionEvents.workspaceId} = ${workspaceId}
          and ${schema.sessionEvents.sessionId} = ${sessionId}
          and ${schema.sessionEvents.id} = ${event.id}
          and (${schema.sessionEvents.turnAssociation} is null or ${schema.sessionEvents.turnAssociation} = 'current')
          and ${schema.sessionEvents.duplicateOfEventId} is null
        limit 1
      ), scalar as (
        select *, jsonb_typeof(value) as kind,
          case when jsonb_typeof(value) = 'string' then value #>> '{}' else null end as raw,
          case when jsonb_typeof(value) <> 'string' then octet_length(value::text) else 0 end as structured_bytes
        from source offset 0
      ), encoding as (
        select *, case when version = 1 and left(raw, ${prefix.length}) = ${prefix}
          then substring(raw from ${prefix.length + 1}::integer) else null end as encoded
        from scalar offset 0
      ), validated as (
        select *, ${tagged} as tagged from encoding offset 0
      )
      select metadata, version, kind, tagged,
        case when kind = 'string' then
          case when tagged then (length(encoded) / 4 * 3 - case when right(encoded, 2) = '==' then 2 when right(encoded, 1) = '=' then 1 else 0 end) / 2
          else length(raw) end else 0 end as total,
        case when kind = 'string' then
          case when tagged then substring(encoded from ${Math.min(group * 8 + 1, 2_147_483_647)}::integer for ${Math.ceil((WINDOW + 6) / 3) * 8}::integer)
          else substring(raw from ${Math.min(start + 1, 2_147_483_647)}::integer for ${WINDOW}::integer) end else null end as window,
        case when kind <> 'string' and structured_bytes <= ${STRUCTURED_BYTES} then value else null end as structured,
        coalesce(kind <> 'string' and structured_bytes > ${STRUCTURED_BYTES}, false) as omitted
      from validated`,
      );
      if (!row) continue;
      const metadata = fromPostgresLosslessJson(row.metadata, row.version) as Record<
        string,
        unknown
      >;
      // Codec decoding can expand JSON escaping (notably NUL/lone surrogates).
      // Keep identities bounded too, without falling back to a different alias.
      for (const [key, budget] of [
        ["callId", 4096],
        ["name", 1024],
      ] as const) {
        if (
          metadata[key] !== undefined &&
          Buffer.byteLength(JSON.stringify(metadata[key]), "utf8") > budget
        ) {
          delete metadata[key];
          metadata.identityOmitted = true;
        }
      }
      let text = row.window ?? "";
      if (row.tagged) {
        // Window lengths are multiples of eight, so each partial block is also
        // a complete canonical encoding accepted by the existing lossless codec.
        text = fromPostgresLosslessJson(prefix + text, 1);
        const local = start - group * 3;
        if (
          local > 0 &&
          /[\uD800-\uDBFF]/.test(text[local - 1]!) &&
          /[\uDC00-\uDFFF]/.test(text[local] ?? "")
        )
          throw new Error("Invalid message continuation offset: splits a surrogate pair");
        text = text.slice(local, local + WINDOW);
        if (start + text.length < row.total && /[\uD800-\uDBFF]/.test(text.at(-1)!))
          text = text.slice(0, -1);
      }
      if (start > row.total && row.kind === "string")
        throw new Error("Invalid message continuation offset");
      const logical = row.omitted
        ? {}
        : row.kind === "string"
          ? text
          : fromPostgresLosslessJson(row.structured, row.version);
      let payload: Record<string, unknown> = { ...metadata };
      if (options.view === "tools") {
        if (row.kind !== null) payload[output ? "output" : "arguments"] = logical;
      } else if (options.view === "results") {
        if (event.type === "turn.completed") payload.output = logical;
        else payload = (logical as Record<string, unknown>) ?? {};
      } else payload.text = logical;
      if (row.omitted) payload = { ...payload, sourceOmitted: true };
      if (row.kind === "string" || row.omitted)
        slices[event.sequence] = {
          offset: start,
          total: row.total,
          unit: row.tagged ? "utf16" : "codepoint",
          text,
          omitted: row.omitted,
        };
      events.push({ ...event, payload });
      // One large structured value preserves the previous bounded JSON path,
      // without accumulating several megabyte-sized values in one source page.
      if (row.kind !== "string" && Buffer.byteLength(JSON.stringify(payload)) > WINDOW) break;
      if (
        row.kind === "string" &&
        start + (row.tagged ? text.length : Array.from(text).length) < row.total
      )
        break;
    }
  });
  // Preserve scan advancement even when every identity was excluded above.
  return {
    ...page,
    events: events.sort((a, b) => a.sequence - b.sequence),
    hasMore: page.hasMore || consumed < ordered.length,
    coveredSequence: consumed
      ? {
          first: Math.min(ordered[0]!.sequence, ordered[consumed - 1]!.sequence),
          last: Math.max(ordered[0]!.sequence, ordered[consumed - 1]!.sequence),
        }
      : null,
    bytes: Buffer.byteLength(JSON.stringify(events), "utf8"),
    fullPayloadsExact: !Object.values(slices).some((slice) => slice.omitted),
    slices,
  };
}
