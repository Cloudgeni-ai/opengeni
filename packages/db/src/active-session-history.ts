import { MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL } from "@opengeni/codex";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";
import * as schema from "./schema";

/**
 * Profiled upper envelope for one session's complete active, model-facing
 * transcript. Bytes alone do not bound the decoded object graph, so rows, JSON
 * nodes, and object properties are independently limited. Provider-token
 * compaction alone does not keep history below these boundaries: inline
 * screenshots cost far more stored bytes than provider tokens. Automatic
 * compaction therefore also runs once the stored footprint reaches
 * {@link ACTIVE_SESSION_HISTORY_COMPACTION_RATIO} of any limit. The limits stay
 * the final materialization guard: a corrupt/imported/pathological transcript
 * fails deterministically before a Postgres driver decodes it instead of
 * using the pod OOM killer as admission, and an over-limit history is read
 * only in the bounded recovery form below.
 */
export const ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES = 15 * 1024 * 1024;
export const ACTIVE_SESSION_HISTORY_MAX_ROWS = 8_192;
export const ACTIVE_SESSION_HISTORY_MAX_JSON_NODES = 131_072;
export const ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES = 65_536;

/**
 * Share of each materialization limit at which automatic compaction runs.
 *
 * At 60% of 15 MiB (9 MiB) the guard still has 6 MiB of headroom: roughly 30
 * further 200 KB screenshots, which covers the one model step of tool results
 * appended between two compaction checks, while the checkpoint request reads
 * and serializes the same history below the guard. A single tool result can
 * carry more (up to 8 MiB of inline payload), so no ratio can rule out a jump
 * past the guard; the bounded recovery read handles that case.
 */
export const ACTIVE_SESSION_HISTORY_COMPACTION_RATIO = 0.6;

export type ActiveSessionHistoryLimitKind =
  | "json_bytes"
  | "rows"
  | "json_nodes"
  | "json_properties";

/**
 * Stored size of active history in the units the guard measures. `jsonBytes`
 * is the UTF-8 size of the history as one JSON array.
 */
export type ActiveSessionHistoryFootprint = {
  jsonBytes: number;
  rows: number;
  jsonNodes: number;
  jsonProperties: number;
};

export const ACTIVE_SESSION_HISTORY_LIMITS: Readonly<ActiveSessionHistoryFootprint> = Object.freeze(
  {
    jsonBytes: ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
    rows: ACTIVE_SESSION_HISTORY_MAX_ROWS,
    jsonNodes: ACTIVE_SESSION_HISTORY_MAX_JSON_NODES,
    jsonProperties: ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES,
  },
);

const LIMIT_DIMENSIONS: ReadonlyArray<
  readonly [ActiveSessionHistoryLimitKind, keyof ActiveSessionHistoryFootprint]
> = [
  ["json_bytes", "jsonBytes"],
  ["rows", "rows"],
  ["json_nodes", "jsonNodes"],
  ["json_properties", "jsonProperties"],
];

export class ActiveSessionHistoryLimitExceededError extends Error {
  readonly code = "active_history_too_large";

  constructor(
    readonly actualBytes: number,
    readonly maximumBytes: number,
    readonly limitKind: ActiveSessionHistoryLimitKind = "json_bytes",
    readonly actual: number = actualBytes,
    readonly maximum: number = maximumBytes,
  ) {
    super(activeSessionHistoryLimitMessage(limitKind, actual, maximum));
    this.name = "ActiveSessionHistoryLimitExceededError";
  }
}

function activeSessionHistoryLimitMessage(
  kind: ActiveSessionHistoryLimitKind,
  actual: number,
  maximum: number,
): string {
  if (kind === "json_bytes") {
    return `Active session history is ${actual} UTF-8 JSON bytes, exceeding the ${maximum}-byte materialization limit.`;
  }
  const label =
    kind === "rows"
      ? "rows"
      : kind === "json_nodes"
        ? "decoded JSON nodes"
        : "decoded JSON object properties";
  return `Active session history has ${actual} ${label}; the materialization limit is ${maximum}.`;
}

export function addActiveSessionHistoryFootprint(
  base: ActiveSessionHistoryFootprint,
  delta: ActiveSessionHistoryFootprint,
): ActiveSessionHistoryFootprint {
  return {
    jsonBytes: base.jsonBytes + delta.jsonBytes,
    rows: base.rows + delta.rows,
    jsonNodes: base.jsonNodes + delta.jsonNodes,
    jsonProperties: base.jsonProperties + delta.jsonProperties,
  };
}

/** The stored dimension that calls for compaction, preferring one already over its limit. */
export type ActiveSessionHistoryPressure = {
  limitKind: ActiveSessionHistoryLimitKind;
  actual: number;
  threshold: number;
  maximum: number;
  exceeded: boolean;
};

export function activeSessionHistoryCompactionPressure(
  footprint: ActiveSessionHistoryFootprint,
  limits: Readonly<ActiveSessionHistoryFootprint> = ACTIVE_SESSION_HISTORY_LIMITS,
  ratio = ACTIVE_SESSION_HISTORY_COMPACTION_RATIO,
): ActiveSessionHistoryPressure | null {
  let pressure: ActiveSessionHistoryPressure | null = null;
  for (const [limitKind, key] of LIMIT_DIMENSIONS) {
    const maximum = limits[key];
    const threshold = Math.max(1, Math.floor(maximum * ratio));
    const actual = footprint[key];
    if (actual < threshold) continue;
    const candidate = { limitKind, actual, threshold, maximum, exceeded: actual > maximum };
    if (!pressure || (candidate.exceeded && !pressure.exceeded)) pressure = candidate;
  }
  return pressure;
}

export type ActiveSessionHistoryRow = {
  id: string;
  position: number;
  /** The turn that wrote this row; null for rows a compaction rewrote without one. */
  turnId: string | null;
  item: Record<string, unknown>;
  providerArtifactInvalidatedAt: Date | null;
};

/** How an over-limit history was bounded for compaction. */
export type ActiveSessionHistoryRecovery = {
  limitKind: ActiveSessionHistoryLimitKind;
  actual: number;
  maximum: number;
  /** Oldest active rows left out of the bounded view entirely. */
  omittedRows: number;
  /** Rows whose inline base64 data-URL payloads were replaced by an omission note. */
  elidedRows: number;
};

export type ActiveSessionHistoryRead = {
  items: ActiveSessionHistoryRow[];
  /** Measured stored footprint of the complete active history. */
  footprint: ActiveSessionHistoryFootprint;
  /** Set only when the history exceeded a limit and was read in bounded recovery form. */
  recovery: ActiveSessionHistoryRecovery | null;
};

export type ActiveSessionHistoryReadOptions = {
  pageSize?: number;
  limits?: Partial<ActiveSessionHistoryFootprint>;
  /**
   * `throw` (default) rejects an over-limit history. `bounded_recovery` instead
   * returns a view that fits {@link ACTIVE_SESSION_HISTORY_COMPACTION_RATIO} of
   * every limit, for compaction only: inline data-URL payloads are left out of
   * the oldest items first (tool results before messages), then the oldest
   * rows are left out. Payloads are removed in PostgreSQL, so they are never
   * decoded by the worker. It still throws when not even the newest row fits.
   */
  overLimit?: "throw" | "bounded_recovery";
};

/**
 * Model-facing note that replaces an inline image or file left out of a
 * bounded recovery view. Content-free and identical for every payload.
 */
export const ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION =
  "[Opengeni left out an inline image or file from this older item to keep context compaction within its memory limit]";

// Stored verbatim by the lossless codec (plain ASCII, no codec prefix).
const INLINE_PAYLOAD_SENTINEL = "opengeni-omitted-inline-payload-v1-4f1c9a";
// Base64 data URLs only. Raw base64 strings are deliberately not matched:
// encrypted reasoning and provider signatures look the same and must survive.
const INLINE_PAYLOAD_PATTERN = "data:[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+";

/** Size of one stored row as the guard measures it. */
export type ActiveSessionHistoryRowMeasure = {
  position: number;
  jsonBytes: number;
  /** `jsonBytes` after inline data-URL payloads are replaced. */
  elidedJsonBytes: number;
  jsonNodes: number;
  jsonProperties: number;
  message: boolean;
};

export type ActiveSessionHistoryRecoveryPlan = {
  startPosition: number;
  omittedRows: number;
  /** Non-message rows at or before this position have payloads elided. */
  elideOtherThrough: number | null;
  /** Message rows at or before this position have payloads elided. */
  elideMessagesThrough: number | null;
  elidedRows: number;
};

/**
 * Keep as many of the newest rows as fit `budget` when all of their inline
 * payloads are elided, then elide only as much as the byte budget needs:
 * tool results and other non-message items oldest-first, then messages
 * oldest-first. When older rows must be left out, the view starts at a
 * message where one is available, so no kept tool result loses its call.
 * Null when not even the newest row fits.
 */
export function planActiveSessionHistoryRecovery(
  rows: readonly ActiveSessionHistoryRowMeasure[],
  budget: Readonly<ActiveSessionHistoryFootprint>,
): ActiveSessionHistoryRecoveryPlan | null {
  let start = rows.length;
  let minimumBytes = 1;
  let count = 0;
  let nodes = 0;
  let properties = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const nextBytes = minimumBytes + row.elidedJsonBytes + 1;
    const nextNodes = nodes + row.jsonNodes;
    const nextProperties = properties + row.jsonProperties;
    if (
      nextBytes > budget.jsonBytes ||
      count + 1 > budget.rows ||
      nextNodes > budget.jsonNodes ||
      nextProperties > budget.jsonProperties
    ) {
      break;
    }
    minimumBytes = nextBytes;
    count += 1;
    nodes = nextNodes;
    properties = nextProperties;
    start = index;
  }
  if (start === rows.length) return null;
  if (start > 0) {
    let boundary = start;
    while (boundary < rows.length && !rows[boundary]!.message) boundary += 1;
    if (boundary < rows.length) start = boundary;
  }
  const kept = rows.slice(start);
  let bytes = 1 + kept.reduce((total, row) => total + row.jsonBytes + 1, 0);
  let elideOtherThrough: number | null = null;
  let elideMessagesThrough: number | null = null;
  let elidedRows = 0;
  for (const message of [false, true]) {
    for (const row of kept) {
      if (bytes <= budget.jsonBytes) break;
      if (row.message !== message) continue;
      if (message) elideMessagesThrough = row.position;
      else elideOtherThrough = row.position;
      if (row.elidedJsonBytes < row.jsonBytes) {
        bytes -= row.jsonBytes - row.elidedJsonBytes;
        elidedRows += 1;
      }
    }
  }
  return {
    startPosition: kept[0]!.position,
    omittedRows: start,
    elideOtherThrough,
    elideMessagesThrough,
    elidedRows,
  };
}

const TEXT_PART_FOR_ELIDED_PART: Readonly<Record<string, string>> = {
  input_image: "input_text",
  input_file: "input_text",
  image: "text",
  image_url: "text",
  file: "text",
};

function holdsSentinel(value: unknown): boolean {
  if (value === INLINE_PAYLOAD_SENTINEL) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((entry) => entry === INLINE_PAYLOAD_SENTINEL);
}

/**
 * Turn PostgreSQL's sentinel back into protocol-valid content: an image or
 * file part becomes a text part carrying the omission note, a computer
 * screenshot keeps its shape with the existing omission card image, and any
 * other occurrence (for example inside a text output) becomes the note.
 */
export function restoreElidedInlinePayloads(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes(INLINE_PAYLOAD_SENTINEL)
      ? value.replaceAll(INLINE_PAYLOAD_SENTINEL, ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION)
      : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const restored = restoreElidedInlinePayloads(entry);
      if (restored !== entry) changed = true;
      return restored;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (Object.values(record).some(holdsSentinel)) {
    if (type === "computer_screenshot") {
      return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [
          key,
          entry === INLINE_PAYLOAD_SENTINEL
            ? MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL
            : entry,
        ]),
      );
    }
    const textType = TEXT_PART_FOR_ELIDED_PART[type];
    if (textType) return { type: textType, text: ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const restored = restoreElidedInlinePayloads(entry);
    if (restored !== entry) changed = true;
    next[key] = restored;
  }
  return changed ? next : value;
}

function safeCount(value: unknown, label: string): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Active session history ${label} is not a safe integer: ${String(value)}`);
  }
  return count;
}

/**
 * Memory-bounded active-history read for model input and compaction. PostgreSQL
 * first measures the complete logical window without returning any JSONB item,
 * then keyset-pages the admitted rows on the same repeatable-read snapshot.
 */
export async function readActiveSessionHistory(
  db: Database,
  workspaceId: string,
  sessionId: string,
  options: ActiveSessionHistoryReadOptions = {},
): Promise<ActiveSessionHistoryRead> {
  const pageSize = options.pageSize ?? ACTIVE_SESSION_HISTORY_MAX_ROWS;
  const limits: ActiveSessionHistoryFootprint = {
    ...ACTIVE_SESSION_HISTORY_LIMITS,
    ...options.limits,
  };
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > ACTIVE_SESSION_HISTORY_MAX_ROWS
  ) {
    throw new Error(
      `active session history page size must be an integer between 1 and ${ACTIVE_SESSION_HISTORY_MAX_ROWS}`,
    );
  }
  if (!Number.isSafeInteger(limits.jsonBytes) || limits.jsonBytes < 1) {
    throw new Error("active session history JSON limit must be a positive safe integer");
  }
  for (const [name, value] of [
    ["row", limits.rows],
    ["JSON node", limits.jsonNodes],
    ["JSON property", limits.jsonProperties],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`active session history ${name} limit must be a positive safe integer`);
    }
  }
  const recoverable = options.overLimit === "bounded_recovery";

  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) => {
      const footprint: ActiveSessionHistoryFootprint = {
        jsonBytes: 0,
        rows: 0,
        jsonNodes: 0,
        jsonProperties: 0,
      };
      let exceeded: ActiveSessionHistoryLimitExceededError | null = null;
      const check = (kind: ActiveSessionHistoryLimitKind, actual: number, maximum: number) => {
        if (actual <= maximum || exceeded) return;
        exceeded = new ActiveSessionHistoryLimitExceededError(
          footprint.jsonBytes,
          limits.jsonBytes,
          kind,
          actual,
          maximum,
        );
        if (!recoverable) throw exceeded;
      };

      // Measure one logical JSON array. pg_column_size(jsonb) is deliberately
      // insufficient because TOAST/compression could hide the decoded size.
      const [size] = await scopedDb
        .select({
          bytes: sql<string>`case
            when count(*) = 0 then 2
            else sum(octet_length((${schema.sessionHistoryItems.item})::text)) + count(*) + 1
          end`,
          rows: sql<string>`count(*)`,
        })
        .from(schema.sessionHistoryItems)
        .where(
          and(
            eq(schema.sessionHistoryItems.workspaceId, workspaceId),
            eq(schema.sessionHistoryItems.sessionId, sessionId),
            eq(schema.sessionHistoryItems.active, true),
          ),
        );
      footprint.jsonBytes = safeCount(size?.bytes, "size");
      check("json_bytes", footprint.jsonBytes, limits.jsonBytes);
      footprint.rows = safeCount(size?.rows, "row count");
      check("rows", footprint.rows, limits.rows);

      // Bound decoded shape independently from bytes. LIMIT maximum+1 keeps
      // rejection work proportional to the admitted envelope.
      const [nodeCount] = await rawRows<{ nodes: string }>(
        scopedDb,
        sql`
          select count(*)::text as nodes
          from (
            select node
            from session_history_items history
            cross join lateral jsonb_path_query(history.item, 'strict $.**') as node
            where history.workspace_id = ${workspaceId}
              and history.session_id = ${sessionId}
              and history.active = true
            limit ${limits.jsonNodes + 1}
          ) bounded_nodes
        `,
      );
      footprint.jsonNodes = safeCount(nodeCount?.nodes, "JSON node count");
      check("json_nodes", footprint.jsonNodes, limits.jsonNodes);

      const [propertyCount] = await rawRows<{ properties: string }>(
        scopedDb,
        sql`
          select count(*)::text as properties
          from (
            select property
            from session_history_items history
            cross join lateral jsonb_path_query(
              history.item,
              'strict $.** ? (@.type() == "object")'
            ) as object_value
            cross join lateral jsonb_object_keys(object_value) as property
            where history.workspace_id = ${workspaceId}
              and history.session_id = ${sessionId}
              and history.active = true
            limit ${limits.jsonProperties + 1}
          ) bounded_properties
        `,
      );
      footprint.jsonProperties = safeCount(propertyCount?.properties, "JSON property count");
      check("json_properties", footprint.jsonProperties, limits.jsonProperties);

      const over = exceeded as ActiveSessionHistoryLimitExceededError | null;
      if (!over) {
        return {
          items: await pageActiveHistory(scopedDb, workspaceId, sessionId, pageSize, null),
          footprint,
          recovery: null,
        };
      }

      const budget = activeSessionHistoryRecoveryBudget(limits);
      const plan = planActiveSessionHistoryRecovery(
        await measureActiveHistoryRows(scopedDb, workspaceId, sessionId),
        budget,
      );
      if (!plan) throw over;
      return {
        items: await pageActiveHistory(scopedDb, workspaceId, sessionId, pageSize, plan),
        footprint,
        recovery: {
          limitKind: over.limitKind,
          actual: over.actual,
          maximum: over.maximum,
          omittedRows: plan.omittedRows,
          elidedRows: plan.elidedRows,
        },
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

/** The footprint a bounded recovery view must fit. */
export function activeSessionHistoryRecoveryBudget(
  limits: Readonly<ActiveSessionHistoryFootprint> = ACTIVE_SESSION_HISTORY_LIMITS,
): ActiveSessionHistoryFootprint {
  const share = (value: number) =>
    Math.max(1, Math.floor(value * ACTIVE_SESSION_HISTORY_COMPACTION_RATIO));
  return {
    jsonBytes: share(limits.jsonBytes),
    rows: share(limits.rows),
    jsonNodes: share(limits.jsonNodes),
    jsonProperties: share(limits.jsonProperties),
  };
}

type ScopedDatabase = Parameters<Parameters<typeof withWorkspaceRls>[2]>[0];

async function measureActiveHistoryRows(
  scopedDb: ScopedDatabase,
  workspaceId: string,
  sessionId: string,
): Promise<ActiveSessionHistoryRowMeasure[]> {
  // Recovery only: one content-free measurement row per active item.
  const rows = await rawRows<{
    position: number | string;
    bytes: string;
    elided_bytes: string;
    nodes: string;
    properties: string;
    message: boolean;
  }>(
    scopedDb,
    sql`
      select
        history.position,
        octet_length(history.item_ordered::text)::text as bytes,
        -- Measured with the note the worker restores, so the plan bounds the
        -- decoded view rather than the shorter transport sentinel.
        octet_length(
          regexp_replace(
            history.item_ordered::text,
            ${INLINE_PAYLOAD_PATTERN},
            ${ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION},
            'g'
          )
        )::text as elided_bytes,
        (
          select count(*) from jsonb_path_query(history.item, 'strict $.**')
        )::text as nodes,
        (
          select count(*)
          from jsonb_path_query(
            history.item,
            'strict $.** ? (@.type() == "object")'
          ) as object_value
          cross join lateral jsonb_object_keys(object_value) as property
        )::text as properties,
        coalesce(history.item->>'type' = 'message', false) as message
      from session_history_items history
      where history.workspace_id = ${workspaceId}
        and history.session_id = ${sessionId}
        and history.active = true
      order by history.position
    `,
  );
  return rows.map((row) => ({
    position: Number(row.position),
    jsonBytes: safeCount(row.bytes, "row size"),
    elidedJsonBytes: safeCount(row.elided_bytes, "row size"),
    jsonNodes: safeCount(row.nodes, "row JSON node count"),
    jsonProperties: safeCount(row.properties, "row JSON property count"),
    message: row.message === true,
  }));
}

async function pageActiveHistory(
  scopedDb: ScopedDatabase,
  workspaceId: string,
  sessionId: string,
  pageSize: number,
  plan: ActiveSessionHistoryRecoveryPlan | null,
): Promise<ActiveSessionHistoryRow[]> {
  const history = schema.sessionHistoryItems;
  const elided = plan
    ? sql<boolean>`(
        (coalesce(${history.item}->>'type' = 'message', false) = false
          and ${history.position} <= ${plan.elideOtherThrough ?? -1})
        or (coalesce(${history.item}->>'type' = 'message', false) = true
          and ${history.position} <= ${plan.elideMessagesThrough ?? -1})
      )`
    : sql<boolean>`false`;
  const item = plan
    ? sql<Record<string, unknown>>`case when ${elided}
        then regexp_replace(
          ${history.item}::text,
          ${INLINE_PAYLOAD_PATTERN},
          ${INLINE_PAYLOAD_SENTINEL},
          'g'
        )::json
        else ${history.item} end`.mapWith(history.item)
    : history.item;
  const rows: ActiveSessionHistoryRow[] = [];
  let afterPosition: number | null = null;
  for (;;) {
    const page: Array<{
      id: string;
      position: number;
      turnId: string | null;
      item: Record<string, unknown>;
      elided: boolean;
      itemCodecVersion: number | null;
      providerArtifactInvalidatedAt: Date | null;
    }> = await scopedDb
      .select({
        id: history.id,
        position: history.position,
        turnId: history.turnId,
        item,
        elided,
        itemCodecVersion: history.itemCodecVersion,
        providerArtifactInvalidatedAt: history.providerArtifactInvalidatedAt,
      })
      .from(history)
      .where(
        and(
          eq(history.workspaceId, workspaceId),
          eq(history.sessionId, sessionId),
          eq(history.active, true),
          ...(plan ? [gte(history.position, plan.startPosition)] : []),
          ...(afterPosition === null ? [] : [gt(history.position, afterPosition)]),
        ),
      )
      .orderBy(history.position)
      .limit(pageSize);
    for (const { itemCodecVersion, elided: rowElided, ...row } of page) {
      const decoded = fromPostgresLosslessJson(row.item, itemCodecVersion);
      rows.push({
        ...row,
        item: rowElided
          ? (restoreElidedInlinePayloads(decoded) as Record<string, unknown>)
          : decoded,
      });
    }
    if (page.length < pageSize) return rows;
    const nextPosition = page.at(-1)!.position;
    if (afterPosition !== null && nextPosition <= afterPosition) {
      throw new Error("active session history keyset did not advance");
    }
    afterPosition = nextPosition;
  }
}

/** Complete active history, or {@link ActiveSessionHistoryLimitExceededError}. */
export async function getActiveSessionHistoryItemsPaged(
  db: Database,
  workspaceId: string,
  sessionId: string,
  pageSize = ACTIVE_SESSION_HISTORY_MAX_ROWS,
  maximumJsonBytes = ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
  maximumRows = ACTIVE_SESSION_HISTORY_MAX_ROWS,
  maximumJsonNodes = ACTIVE_SESSION_HISTORY_MAX_JSON_NODES,
  maximumJsonProperties = ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES,
): Promise<ActiveSessionHistoryRow[]> {
  const read = await readActiveSessionHistory(db, workspaceId, sessionId, {
    pageSize,
    limits: {
      jsonBytes: maximumJsonBytes,
      rows: maximumRows,
      jsonNodes: maximumJsonNodes,
      jsonProperties: maximumJsonProperties,
    },
  });
  return read.items;
}
