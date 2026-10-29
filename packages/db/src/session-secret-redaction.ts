import { createHash } from "node:crypto";
import type { ModelContextSnapshot } from "@opengeni/contracts";
import { sql, type SQL } from "drizzle-orm";
import { rawRows, withRlsContext, withSessionActivityRlsContext, type Database } from "./database";
import {
  encodeModelContextSnapshotContent,
  hydrateStoredModelContextSnapshot,
  writeSessionContentBlobs,
} from "./session-content-blobs";
import { fromPostgresLosslessJson, LOSSLESS_CONTENT_CODEC_VERSION } from "./lossless-json";
import { lockSessionEventWriteRows } from "./session-control";
import {
  redactJsonText,
  redactJsonValue,
  redactStoredText,
  type SecretRedactionMatcher,
} from "./session-secret-redaction-text";

export * from "./session-secret-redaction-text";

/**
 * The secret history scrub (docs/secrets.md, "Removing secrets from stored
 * history"): find every stored copy of a secret in chosen sessions and rewrite
 * it to a `[redacted: ...]` marker, or only count the copies (dry run).
 *
 * Every table is read in bounded pages, each page in its own transaction
 * under the caller's row-level security and the workspace's shared tenancy
 * fence, like any other session writer. A cell is rewritten only while it
 * still holds the text that was read (compare and swap on its md5), so a
 * concurrent writer is never overwritten; whatever it wrote is caught by the
 * next run. Matching is done here, never in SQL, and nothing in the report or
 * an error is ever text from a row.
 *
 * Cells the runtime role may not read or change (goal text, goal revisions, a
 * turn's frozen goal, task notes, the message search mirror, content blobs,
 * MCP results, the host export outbox and the repair audit) go through the two
 * 1091 owner routines. Their runtime EXECUTE is withheld for one release; until
 * it is granted those tables are reported as pending and what can be read is
 * still counted.
 */

export type SecretRedactionCounts = {
  /** Rows holding at least one match when read. */
  rowsMatched: number;
  /** Rows rewritten (or blobs deleted). Always 0 in a dry run. */
  rowsChanged: number;
  /** Matches found when read. */
  matches: number;
};

export type SessionSecretRedactionFailure = {
  sessionId: string | null;
  table: string;
  /** An error class or SQLSTATE; never a message, which could carry text. */
  code: string;
};

export type SessionSecretRedactionReport = {
  dryRun: boolean;
  sessions: Array<{
    sessionId: string;
    archived: boolean;
    tables: Record<string, SecretRedactionCounts>;
  }>;
  tables: Record<string, SecretRedactionCounts>;
  /** Tables that need the 1091 routines, whose runtime grant is still pending. */
  pending: string[];
  failures: SessionSecretRedactionFailure[];
  /**
   * Per session, content blobs a rewritten snapshot no longer refers to that
   * this run could not delete (the cell writer is not granted yet). Digests
   * only; never returned by the API.
   */
  orphanedBlobs: Record<string, string[]>;
};

export type SessionSecretRedactionScope = { accountId: string; workspaceId: string };

export type SessionSecretRedactionOptions = {
  sessionIds: readonly string[];
  matchers: readonly SecretRedactionMatcher[];
  dryRun: boolean;
  /** Rows per page and transaction. Default 50. */
  pageRows?: number;
  /**
   * Rewrite model-context snapshots whose content lives in blobs even before
   * the 1091 cell writer is granted. Their old blobs then stay until an owner
   * deletes them (`orphanedBlobs` in the report). Only for an operator's
   * one-off run; the API leaves such snapshots pending instead.
   */
  rewriteReferencedSnapshotsWhilePending?: boolean;
};

/** Most sessions one run accepts, descendants included. */
export const SESSION_SECRET_REDACTION_MAX_SESSIONS = 200;

const DEFAULT_PAGE_ROWS = 50;
const PRIVATE_CELL_BATCH = 200;
const REDACT_CELLS_ROUTINE = "opengeni_private.redact_session_secret_cells_v1(uuid, text, jsonb)";
const READ_ROWS_ROUTINE =
  "opengeni_private.session_secret_redaction_rows_v1(uuid, uuid[], text, uuid, integer)";

type CellKind = "text" | "jsonb" | "json";

type CellSpec = {
  column: string;
  kind: CellKind;
  /** Lossless codec version column, when the column has one. */
  codec?: string;
  /**
   * An order-preserving `json` twin the table keeps in sync by trigger. When
   * present and not null, the twin is rewritten and the trigger derives the
   * `jsonb` column from it, so both copies change together.
   */
  ordered?: string;
  /** Written through the 1091 owner routine instead of directly. */
  private?: boolean;
};

type DirectTableSpec = {
  table: string;
  key: string;
  keyType: "uuid" | "integer";
  /** How a session's rows are found. */
  session: { column: string } | { arrayColumn: string };
  cells: CellSpec[];
  /** The sessions row is written through the session-activity writer. */
  activityWriter?: boolean;
  /** Rows to leave alone (a static SQL predicate, never input). */
  skipRows?: string;
};

/**
 * Every table the runtime role can read, with the columns that hold session
 * content. Identifiers here are static and never come from input.
 */
const DIRECT_TABLES: readonly DirectTableSpec[] = [
  {
    table: "sessions",
    key: "id",
    keyType: "uuid",
    session: { column: "id" },
    activityWriter: true,
    cells: [
      { column: "title", kind: "text" },
      { column: "initial_message", kind: "text", codec: "initial_message_codec_version" },
      { column: "instructions", kind: "text" },
      { column: "initial_model_context", kind: "text" },
      { column: "metadata", kind: "jsonb" },
    ],
  },
  {
    table: "session_turns",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "prompt", kind: "text", codec: "prompt_codec_version" },
      { column: "model_context", kind: "text" },
      { column: "metadata", kind: "jsonb" },
      { column: "goal_snapshot", kind: "jsonb", private: true },
    ],
  },
  {
    table: "session_events",
    key: "sequence",
    keyType: "integer",
    session: { column: "session_id" },
    cells: [{ column: "payload", kind: "jsonb", codec: "payload_codec_version" }],
  },
  {
    table: "session_history_items",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "item", kind: "jsonb", codec: "item_codec_version", ordered: "item_ordered" },
    ],
  },
  {
    table: "session_pending_tool_calls",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      {
        column: "call_item",
        kind: "jsonb",
        codec: "call_item_codec_version",
        ordered: "call_item_ordered",
      },
      {
        column: "result_item",
        kind: "jsonb",
        codec: "result_item_codec_version",
        ordered: "result_item_ordered",
      },
      {
        column: "tied_reasoning_items",
        kind: "jsonb",
        codec: "tied_reasoning_items_codec_version",
        ordered: "tied_reasoning_items_ordered",
      },
      { column: "event_output", kind: "jsonb", codec: "event_output_codec_version" },
    ],
  },
  {
    table: "session_realtime_entries",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "text", kind: "text", codec: "text_codec_version" },
      { column: "payload", kind: "jsonb", codec: "payload_codec_version" },
      { column: "model_context", kind: "text" },
    ],
  },
  {
    table: "session_realtime_context_projections",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [{ column: "context", kind: "text" }],
  },
  {
    table: "session_attempt_codemode_calls",
    key: "operation_id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "arguments", kind: "jsonb" },
      { column: "result", kind: "jsonb" },
      { column: "error_message", kind: "text" },
    ],
  },
  {
    table: "session_background_commands",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "command_preview", kind: "text" },
      { column: "command_text", kind: "text" },
      { column: "runner_failure", kind: "jsonb" },
    ],
  },
  {
    // Machine inputs. An accepted scheduled occurrence is immutable (0275)
    // except to the 1091 cell writer, so all of them go through it.
    table: "session_system_updates",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "summary", kind: "text", codec: "summary_codec_version", private: true },
      { column: "payload", kind: "jsonb", codec: "payload_codec_version", private: true },
    ],
  },
  {
    table: "session_system_update_outbox",
    key: "id",
    keyType: "uuid",
    session: { column: "target_session_id" },
    cells: [
      { column: "summary", kind: "text", codec: "summary_codec_version" },
      { column: "payload", kind: "jsonb", codec: "payload_codec_version" },
    ],
  },
  {
    table: "session_human_input_requests",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "questions", kind: "jsonb" },
      { column: "response", kind: "jsonb" },
    ],
  },
  {
    table: "agent_run_states",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      {
        column: "serialized_run_state",
        kind: "text",
        codec: "serialized_run_state_codec_version",
      },
      { column: "pending_approvals", kind: "jsonb", codec: "pending_approvals_codec_version" },
    ],
  },
  {
    table: "session_command_receipts",
    key: "id",
    keyType: "uuid",
    session: { column: "target_session_id" },
    // Native document inspection receipts are immutable proof (0474) and hold
    // inspection metadata, not session text.
    skipRows: "action = 'artifact.document.inspect'",
    cells: [{ column: "result", kind: "jsonb" }],
  },
  {
    table: "composer_drafts",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [{ column: "text", kind: "text" }],
  },
  {
    table: "connector_action_requests",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "review_arguments", kind: "text" },
      { column: "review_context", kind: "jsonb" },
    ],
  },
  {
    table: "feedback_submissions",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: [
      { column: "comment", kind: "text" },
      { column: "context", kind: "jsonb" },
    ],
  },
  {
    table: "session_list_snapshots",
    key: "id",
    keyType: "uuid",
    session: { arrayColumn: "ordinary_session_ids" },
    cells: [{ column: "search", kind: "text" }],
  },
  {
    table: "session_goals",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: ["text", "success_criteria", "evidence", "rationale", "paused_reason"].map((column) => ({
      column,
      kind: "text" as const,
      private: true,
    })),
  },
  {
    table: "session_goal_revisions",
    key: "id",
    keyType: "uuid",
    session: { column: "session_id" },
    cells: ["text", "success_criteria", "rationale"].map((column) => ({
      column,
      kind: "text" as const,
      private: true,
    })),
  },
];

/** Tables only the 1091 reader can read. Cells are named by the routine. */
const PRIVATE_READ_TABLES = [
  "task_notes",
  "host_export_outbox",
  "mcp_operations",
  "session_history_items_repair_audit",
] as const;

const PRIVATE_READ_TEXT_CELLS: Readonly<Record<string, readonly string[]>> = {
  task_notes: ["text"],
};

const SNAPSHOT_TABLE = "session_attempt_model_context_snapshots";
const BLOB_TABLE = "session_content_blobs";
const SEARCH_TABLE = "session_message_search_texts";

/** Every table a run reports, in report order. */
export const SESSION_SECRET_REDACTION_TABLES: readonly string[] = [
  ...DIRECT_TABLES.map((spec) => spec.table),
  SNAPSHOT_TABLE,
  BLOB_TABLE,
  SEARCH_TABLE,
  ...PRIVATE_READ_TABLES,
];

const TEXT_COLUMNS = new Map<string, Set<string>>();
for (const spec of DIRECT_TABLES) {
  for (const cell of spec.cells) {
    if (cell.kind !== "text") continue;
    let columns = TEXT_COLUMNS.get(spec.table);
    if (!columns) {
      columns = new Set();
      TEXT_COLUMNS.set(spec.table, columns);
    }
    columns.add(cell.column);
  }
}
const NO_TEXT_COLUMNS: ReadonlySet<string> = new Set();

/**
 * A table's content columns stored as text rather than JSON, so a row read
 * back as JSON (the archive bundle) uses the text form of the lossless codec.
 */
export function sessionSecretRedactionTextColumns(table: string): ReadonlySet<string> {
  return TEXT_COLUMNS.get(table) ?? NO_TEXT_COLUMNS;
}

/** Tables whose rewrite (or read) needs the 1091 routines. */
const PRIVATE_TABLES = new Set<string>([
  "session_goals",
  "session_goal_revisions",
  "session_system_updates",
  SNAPSHOT_TABLE,
  BLOB_TABLE,
  SEARCH_TABLE,
  ...PRIVATE_READ_TABLES,
]);

/** Goal text limits the goal guards enforce (UTF-8 bytes). */
const GOAL_TEXT_MAX_BYTES = 8192;
const GOAL_LIMITED_CELLS: Readonly<Record<string, readonly string[]>> = {
  session_goals: ["text", "success_criteria"],
  session_goal_revisions: ["text", "success_criteria"],
};

function emptyCounts(): SecretRedactionCounts {
  return { rowsMatched: 0, rowsChanged: 0, matches: 0 };
}

function errorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    // A SQLSTATE, or one of this module's own codes (never free text).
    if (typeof code === "string" && /^(?:[A-Z0-9]{5}|[a-z][a-z0-9_]{2,63})$/u.test(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.name.slice(0, 80) : "unknown";
}

function identifier(name: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error("invalid identifier");
  return sql.raw(`"${name}"`);
}

/** A PostgreSQL array literal, bound as one parameter and cast at the call site. */
function arrayLiteral(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/[\\"]/gu, (char) => `\\${char}`)}"`).join(",")}}`;
}

function castFor(kind: CellKind): SQL {
  return sql.raw(kind === "text" ? "text" : kind);
}

function redactCell(
  kind: CellKind,
  stored: string,
  codec: number | null,
  matchers: readonly SecretRedactionMatcher[],
) {
  return kind === "text"
    ? redactStoredText(stored, codec, matchers)
    : redactJsonText(stored, codec, matchers);
}

class Tally {
  readonly bySession = new Map<string, Map<string, SecretRedactionCounts>>();
  readonly failures: SessionSecretRedactionFailure[] = [];

  counts(sessionId: string, table: string): SecretRedactionCounts {
    let tables = this.bySession.get(sessionId);
    if (!tables) {
      tables = new Map();
      this.bySession.set(sessionId, tables);
    }
    let counts = tables.get(table);
    if (!counts) {
      counts = emptyCounts();
      tables.set(table, counts);
    }
    return counts;
  }

  fail(sessionId: string | null, table: string, error: unknown) {
    if (this.failures.length < 200)
      this.failures.push({ sessionId, table, code: errorCode(error) });
  }
}

/** Whether the runtime may call both 1091 routines yet. A separate statement. */
export async function sessionSecretRedactionRoutinesGranted(
  db: Pick<Database, "execute">,
): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select coalesce(
      has_function_privilege(to_regprocedure(${REDACT_CELLS_ROUTINE})::oid, 'EXECUTE')
      and has_function_privilege(to_regprocedure(${READ_ROWS_ROUTINE})::oid, 'EXECUTE'),
      false) as granted`,
  );
  return row?.granted === true;
}

/**
 * The given sessions plus every descendant visible to the caller, in
 * discovery order, at most `limit`. Unknown or invisible IDs are dropped.
 */
export async function listSessionsForSecretRedaction(
  db: Database,
  scope: SessionSecretRedactionScope,
  input: { sessionIds: readonly string[]; includeDescendants: boolean; limit?: number },
): Promise<Array<{ id: string; archived: boolean; active: boolean; archiving: boolean }>> {
  const limit = Math.max(1, Math.min(input.limit ?? SESSION_SECRET_REDACTION_MAX_SESSIONS, 1000));
  const roots = [...new Set(input.sessionIds)];
  if (roots.length === 0) return [];
  return await withRlsContext(db, scope, async (tx) => {
    const rows = input.includeDescendants
      ? await rawRows<{ id: string; archived: boolean; active: boolean; archiving: boolean }>(
          tx,
          sql`with recursive tree(id, depth) as (
              select s.id, 0 from sessions s
              where s.workspace_id = ${scope.workspaceId}::uuid
                and s.id = any(${arrayLiteral(roots)}::uuid[])
              union
              select child.id, tree.depth + 1 from sessions child
              join tree on child.parent_session_id = tree.id
              where child.workspace_id = ${scope.workspaceId}::uuid and tree.depth < 64
            )
            select s.id::text as id, (s.content_archive_state = 'archived') as archived,
              (s.active_turn_id is not null) as active,
              (s.content_archive_state = 'archiving') as archiving
            from (select distinct on (id) id, depth from tree order by id, depth) found
            join sessions s on s.workspace_id = ${scope.workspaceId}::uuid and s.id = found.id
            order by found.depth, s.created_at, s.id
            limit ${limit + 1}`,
        )
      : await rawRows<{ id: string; archived: boolean; active: boolean; archiving: boolean }>(
          tx,
          sql`select s.id::text as id, (s.content_archive_state = 'archived') as archived,
              (s.active_turn_id is not null) as active,
              (s.content_archive_state = 'archiving') as archiving
            from sessions s
            where s.workspace_id = ${scope.workspaceId}::uuid and s.id = any(${arrayLiteral(roots)}::uuid[])
            order by s.created_at, s.id`,
        );
    if (rows.length > limit) throw new SessionSecretRedactionTooManySessionsError(limit);
    return rows.map((row) => ({
      id: row.id,
      archived: row.archived === true,
      active: row.active === true,
      archiving: row.archiving === true,
    }));
  });
}

export class SessionSecretRedactionTooManySessionsError extends Error {
  readonly code = "secret_redaction_too_many_sessions";
  constructor(readonly limit: number) {
    super(`A secret scrub covers at most ${limit} sessions; choose fewer`);
    this.name = "SessionSecretRedactionTooManySessionsError";
  }
}

/**
 * An archived session's manifest and the md5 of its stored JSON, which the
 * swap below compares before it writes. Null when the session is not archived.
 */
export async function readSessionArchiveManifestForRedaction(
  db: Database,
  scope: SessionSecretRedactionScope,
  sessionId: string,
): Promise<{ manifest: Record<string, unknown>; before: string } | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<{ manifest: unknown; before: string }>(
      tx,
      sql`select content_archive as manifest, md5(content_archive::text) as before
        from sessions
        where workspace_id = ${scope.workspaceId}::uuid and id = ${sessionId}::uuid
          and content_archive_state = 'archived'`,
    );
    if (!row || typeof row.manifest !== "object" || row.manifest === null) return null;
    return { manifest: row.manifest as Record<string, unknown>, before: row.before };
  });
}

/**
 * Point an archived session at rewritten archive objects, only while its
 * manifest is still the one read (`before`). The replaced objects are queued
 * for deletion in the same transaction. Needs the 1091 cell writer.
 */
export async function replaceSessionArchiveManifestForRedaction(
  db: Database,
  scope: SessionSecretRedactionScope,
  input: { sessionId: string; before: string; manifest: Record<string, unknown> },
): Promise<boolean> {
  return await withRlsContext(
    db,
    scope,
    async (tx) =>
      (await callRedactCells(tx, scope.workspaceId, "sessions", [
        { key: input.sessionId, before: input.before, value: JSON.stringify(input.manifest) },
      ])) > 0,
  );
}

async function markRedactionWriter(tx: Pick<Database, "execute">) {
  // The read-only guard of archived and imported sessions lets these updates
  // through (1091); everything else still applies.
  await tx.execute(sql`select set_config('opengeni.session_secret_redaction', 'v1', true)`);
}

async function callRedactCells(
  tx: Pick<Database, "execute">,
  workspaceId: string,
  table: string,
  cells: readonly Record<string, unknown>[],
): Promise<number> {
  let changed = 0;
  for (let offset = 0; offset < cells.length; offset += PRIVATE_CELL_BATCH) {
    const batch = cells.slice(offset, offset + PRIVATE_CELL_BATCH);
    const [row] = await rawRows<{ changed: number }>(
      tx,
      sql`select opengeni_private.redact_session_secret_cells_v1(
        ${workspaceId}::uuid, ${table}, ${JSON.stringify(batch)}::jsonb) as changed`,
    );
    changed += Number(row?.changed ?? 0);
  }
  return changed;
}

function sessionFilter(spec: DirectTableSpec, sessionId: string): SQL {
  const filter =
    "arrayColumn" in spec.session
      ? sql`${identifier(spec.session.arrayColumn)} && array[${sessionId}::uuid]`
      : sql`${identifier(spec.session.column)} = ${sessionId}::uuid`;
  return spec.skipRows ? sql`${filter} and not (${sql.raw(spec.skipRows)})` : filter;
}

type Context = {
  db: Database;
  scope: SessionSecretRedactionScope;
  matchers: readonly SecretRedactionMatcher[];
  dryRun: boolean;
  pageRows: number;
  privateGranted: boolean;
  rewriteReferencedSnapshots: boolean;
  tally: Tally;
  /**
   * Per session, blobs a snapshot referred to before this run rewrote it and
   * no longer does. A secret split across two body chunks matches neither
   * chunk alone, so these are deleted whether or not they match by
   * themselves (the cell writer still refuses one anything refers to).
   */
  replacedBlobs: Map<string, Set<string>>;
};

/** A matched cell whose write changed nothing: the copy is still stored. */
const NOT_REWRITTEN = { code: "cell_not_rewritten" };

/**
 * Unreferenced blobs at least this old are deleted too: a chunk a rewritten
 * snapshot replaced may hold part of a secret split across two chunks, and a
 * run that failed between the snapshot and blob passes leaves it behind
 * unreferenced. Younger ones may belong to a write still in flight.
 */
const UNREFERENCED_BLOB_MIN_AGE = "10 minutes";

function failShortfall(context: Context, sessionId: string, table: string, missing: number) {
  for (let index = 0; index < Math.min(missing, 20); index += 1) {
    context.tally.fail(sessionId, table, NOT_REWRITTEN);
  }
}

class SessionActiveError extends Error {
  readonly code = "session_active";

  constructor() {
    super("The session has a turn in progress");
    this.name = "SessionActiveError";
  }
}

class SessionArchivingError extends Error {
  readonly code = "session_archiving";

  constructor() {
    super("The session is being moved to long-term storage");
    this.name = "SessionArchivingError";
  }
}

/**
 * Take the canonical session-writer prefix (workspace KEY SHARE, then the
 * session FOR NO KEY UPDATE) before rewriting a session's rows, so the scrub
 * orders its locks like every other writer. A session with a turn in progress
 * is left alone: the turn could write the text again from memory.
 */
async function lockSessionForRedaction(
  tx: Database,
  scope: SessionSecretRedactionScope,
  sessionId: string,
): Promise<void> {
  const locks = await lockSessionEventWriteRows(tx, {
    workspaceId: scope.workspaceId,
    sessionIds: [sessionId],
    controlLock: "none",
    rowProjection: "event",
  });
  if (locks.sessions[0]?.activeTurnId) throw new SessionActiveError();
  // The archive marks a session `archiving` under this same lock, then
  // exports its rows and purges them; a write during the export would leave
  // the old copy in the archive. Run again once it is archived.
  const [state] = await rawRows<{ archiving: boolean }>(
    tx,
    sql`select (content_archive_state = 'archiving') as archiving from sessions
      where workspace_id = ${scope.workspaceId}::uuid and id = ${sessionId}::uuid`,
  );
  if (state?.archiving === true) throw new SessionArchivingError();
}

function snapshotRefDigests(refs: unknown): string[] {
  if (typeof refs !== "object" || refs === null) return [];
  const value = refs as Record<string, unknown>;
  const digests: string[] = [];
  for (const key of ["instructions", "layers", "tools", "skills"]) {
    if (typeof value[key] === "string") digests.push(value[key]);
  }
  if (Array.isArray(value.body)) {
    for (const digest of value.body) if (typeof digest === "string") digests.push(digest);
  }
  return digests;
}

async function inScope<T>(
  context: Context,
  activityWriter: boolean,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return activityWriter
    ? await withSessionActivityRlsContext(context.db, context.scope, (tx) =>
        fn(tx as unknown as Database),
      )
    : await withRlsContext(context.db, context.scope, fn);
}

async function scrubDirectTable(context: Context, spec: DirectTableSpec, sessionId: string) {
  const { scope } = context;
  const counts = context.tally.counts(sessionId, spec.table);
  const keyCast = sql.raw(spec.keyType === "uuid" ? "uuid" : "integer");
  const keys = await withRlsContext(context.db, scope, async (tx) =>
    (
      await rawRows<{ key: string }>(
        tx,
        sql`select ${identifier(spec.key)}::text as key from ${identifier(spec.table)}
          where workspace_id = ${scope.workspaceId}::uuid and ${sessionFilter(spec, sessionId)}
          order by ${identifier(spec.key)}`,
      )
    ).map((row) => row.key),
  );
  const selected: SQL[] = [sql`${identifier(spec.key)}::text as "k"`];
  spec.cells.forEach((cell, index) => {
    const source = cell.ordered
      ? sql`coalesce(${identifier(cell.ordered)}::text, ${identifier(cell.column)}::text)`
      : sql`${identifier(cell.column)}::text`;
    selected.push(sql`${source} as ${sql.raw(`"v${index}"`)}`);
    selected.push(
      sql`(${identifier(cell.ordered ?? cell.column)} is not null) as ${sql.raw(`"o${index}"`)}`,
    );
    selected.push(
      cell.codec
        ? sql`${identifier(cell.codec)} as ${sql.raw(`"c${index}"`)}`
        : sql`null::integer as ${sql.raw(`"c${index}"`)}`,
    );
  });
  for (let offset = 0; offset < keys.length; offset += context.pageRows) {
    const page = keys.slice(offset, offset + context.pageRows);
    // Counted once the page's transaction commits, never before.
    let pageChanged = 0;
    try {
      await inScope(context, spec.activityWriter === true, async (tx) => {
        const rows = await rawRows<Record<string, unknown>>(
          tx,
          sql`select ${sql.join(selected, sql`, `)} from ${identifier(spec.table)}
            where workspace_id = ${scope.workspaceId}::uuid and ${sessionFilter(spec, sessionId)}
              and ${identifier(spec.key)} = any(${arrayLiteral(page)}::${keyCast}[])`,
        );
        const privateCells = new Map<string, Record<string, unknown>[]>();
        // A row counts once, however many of its cells were rewritten.
        const changedRows = new Set<string>();
        let marked = false;
        let locked = false;
        const lockOnce = async () => {
          if (locked) return;
          await lockSessionForRedaction(tx, scope, sessionId);
          locked = true;
        };
        for (const row of rows) {
          let rowMatches = 0;
          for (const [index, cell] of spec.cells.entries()) {
            const stored = row[`v${index}`];
            if (typeof stored !== "string") continue;
            const codec = row[`c${index}`] === null ? null : Number(row[`c${index}`]);
            const result = redactCell(cell.kind, stored, codec, context.matchers);
            if (result.matches === 0) continue;
            rowMatches += result.matches;
            if (context.dryRun) continue;
            // Write the ordered twin when the row has one; its trigger
            // derives the jsonb column. Otherwise write the column itself.
            const target = cell.ordered && row[`o${index}`] === true ? cell.ordered : cell.column;
            const targetKind: CellKind = target === cell.ordered ? "json" : cell.kind;
            if (cell.private) {
              if (
                GOAL_LIMITED_CELLS[spec.table]?.includes(cell.column) &&
                Buffer.byteLength(result.text, "utf8") > GOAL_TEXT_MAX_BYTES
              ) {
                // The marker would push the goal past its limit; leave it and say so.
                context.tally.fail(sessionId, spec.table, { code: "goal_text_too_long" });
                continue;
              }
              const cells = privateCells.get(row.k as string) ?? [];
              cells.push({
                key: row.k,
                session: sessionId,
                column: cell.column,
                before: md5Hex(stored),
                value: result.text,
              });
              privateCells.set(row.k as string, cells);
              continue;
            }
            await lockOnce();
            if (!marked) {
              await markRedactionWriter(tx);
              marked = true;
            }
            const updated = await rawRows<{ k: string }>(
              tx,
              sql`update ${identifier(spec.table)} set ${identifier(target)} = ${result.text}::${castFor(targetKind)}
                where workspace_id = ${scope.workspaceId}::uuid
                  and ${identifier(spec.key)} = ${row.k as string}::${keyCast}
                  and md5(${identifier(target)}::text) = ${md5Hex(stored)}
                returning ${identifier(spec.key)}::text as k`,
            );
            if (updated.length > 0) changedRows.add(row.k as string);
            // Changed under us, or refused by a check: the copy is still there.
            else context.tally.fail(sessionId, spec.table, NOT_REWRITTEN);
          }
          if (rowMatches > 0) {
            counts.rowsMatched += 1;
            counts.matches += rowMatches;
          }
        }
        if (context.privateGranted && privateCells.size > 0) {
          await lockOnce();
          for (const [key, cells] of privateCells) {
            const changed = await callRedactCells(tx, scope.workspaceId, spec.table, cells);
            if (changed > 0) changedRows.add(key);
            // The writer counts cells: each one short is a copy still stored.
            failShortfall(context, sessionId, spec.table, cells.length - changed);
          }
        }
        pageChanged = changedRows.size;
      });
      counts.rowsChanged += pageChanged;
    } catch (error) {
      context.tally.fail(sessionId, spec.table, error);
    }
  }
}

async function scrubSnapshots(context: Context, sessionId: string) {
  const { scope } = context;
  const counts = context.tally.counts(sessionId, SNAPSHOT_TABLE);
  const contentScope = { ...scope, sessionId };
  const keys = await withRlsContext(context.db, scope, async (tx) =>
    (
      await rawRows<{ key: string }>(
        tx,
        sql`select attempt_id::text as key from session_attempt_model_context_snapshots
          where workspace_id = ${scope.workspaceId}::uuid and session_id = ${sessionId}::uuid
          order by attempt_id`,
      )
    ).map((row) => row.key),
  );
  // Snapshots are large; a few per transaction.
  const pageRows = Math.max(1, Math.min(context.pageRows, 10));
  for (let offset = 0; offset < keys.length; offset += pageRows) {
    const page = keys.slice(offset, offset + pageRows);
    let pageChanged = 0;
    // Digests the page's rewritten snapshots no longer refer to; queued for
    // deletion only once the page has committed.
    const pageReplaced = new Set<string>();
    try {
      await withRlsContext(context.db, scope, async (tx) => {
        const rows = await rawRows<{
          key: string;
          snapshot: unknown;
          content_refs: unknown;
          snapshot_md5: string;
          refs_md5: string;
        }>(
          tx,
          sql`select attempt_id::text as key, snapshot, content_refs,
              md5(snapshot::text) as snapshot_md5, md5(coalesce(content_refs::text, '')) as refs_md5
            from session_attempt_model_context_snapshots
            where workspace_id = ${scope.workspaceId}::uuid and session_id = ${sessionId}::uuid
              and attempt_id = any(${arrayLiteral(page)}::uuid[])`,
        );
        for (const row of rows) {
          const hydrated = await hydrateStoredModelContextSnapshot(tx, contentScope, {
            snapshot: row.snapshot,
            contentRefs: row.content_refs,
          });
          const result = redactJsonValue(hydrated, context.matchers);
          if (result.matches === 0) continue;
          counts.rowsMatched += 1;
          counts.matches += result.matches;
          if (context.dryRun) continue;
          const referenced = row.content_refs !== null && row.content_refs !== undefined;
          // Until the cell writer may delete the old blobs, rewriting a
          // snapshot that keeps its content in them would only add copies.
          if (referenced && !context.privateGranted && !context.rewriteReferencedSnapshots)
            continue;
          await lockSessionForRedaction(tx, scope, sessionId);
          let stored: unknown = result.value;
          let refs: unknown = null;
          if (row.content_refs !== null && row.content_refs !== undefined) {
            const encoded = encodeModelContextSnapshotContent(result.value as ModelContextSnapshot);
            await writeSessionContentBlobs(tx, contentScope, encoded.blobs);
            stored = encoded.stored;
            refs = encoded.refs;
          }
          const updated = await rawRows<{ key: string }>(
            tx,
            sql`update session_attempt_model_context_snapshots
              set snapshot = ${JSON.stringify(stored)}::jsonb,
                content_refs = ${refs === null ? null : JSON.stringify(refs)}::jsonb
              where workspace_id = ${scope.workspaceId}::uuid
                and attempt_id = ${row.key}::uuid
                and md5(snapshot::text) = ${row.snapshot_md5}
                and md5(coalesce(content_refs::text, '')) = ${row.refs_md5}
              returning attempt_id::text as key`,
          );
          if (updated.length === 0) {
            context.tally.fail(sessionId, SNAPSHOT_TABLE, NOT_REWRITTEN);
          } else {
            pageChanged += 1;
            const kept = new Set(snapshotRefDigests(refs));
            for (const digest of snapshotRefDigests(row.content_refs)) {
              if (!kept.has(digest)) pageReplaced.add(digest);
            }
          }
        }
      });
      counts.rowsChanged += pageChanged;
      if (pageReplaced.size > 0) {
        let replaced = context.replacedBlobs.get(sessionId);
        if (!replaced) {
          replaced = new Set();
          context.replacedBlobs.set(sessionId, replaced);
        }
        for (const digest of pageReplaced) replaced.add(digest);
      }
    } catch (error) {
      context.tally.fail(sessionId, SNAPSHOT_TABLE, error);
    }
  }
}

async function scrubBlobs(context: Context, sessionId: string) {
  const { scope } = context;
  const counts = context.tally.counts(sessionId, BLOB_TABLE);
  const keys = await withRlsContext(context.db, scope, async (tx) =>
    (
      await rawRows<{ key: string }>(
        tx,
        sql`select digest as key from session_content_blobs
          where workspace_id = ${scope.workspaceId}::uuid and session_id = ${sessionId}::uuid
          order by digest`,
      )
    ).map((row) => row.key),
  );
  for (let offset = 0; offset < keys.length; offset += context.pageRows) {
    const page = keys.slice(offset, offset + context.pageRows);
    let pageChanged = 0;
    try {
      await withRlsContext(context.db, scope, async (tx) => {
        const rows = await rawRows<{ key: string; value: string; unreferenced: boolean }>(
          tx,
          sql`select blob.digest as key, blob.value::text as value,
              (blob.created_at < now() - ${UNREFERENCED_BLOB_MIN_AGE}::interval
                and not exists (
                  select 1 from session_attempt_model_context_snapshots snapshot_row
                  where snapshot_row.workspace_id = blob.workspace_id
                    and snapshot_row.session_id = blob.session_id
                    and strpos(snapshot_row.content_refs::text, '"' || blob.digest || '"') > 0)
                and not exists (
                  select 1 from session_attempt_tool_catalogs catalog_row
                  where catalog_row.workspace_id = blob.workspace_id
                    and catalog_row.session_id = blob.session_id
                    and strpos(catalog_row.content_refs::text, '"' || blob.digest || '"') > 0)
              ) as unreferenced
            from session_content_blobs blob
            where blob.workspace_id = ${scope.workspaceId}::uuid and blob.session_id = ${sessionId}::uuid
              and blob.digest = any(${arrayLiteral(page)}::text[])`,
        );
        const doomed: Record<string, unknown>[] = [];
        const matched: string[] = [];
        const replaced = context.replacedBlobs.get(sessionId);
        for (const row of rows) {
          const result = redactJsonText(row.value, null, context.matchers);
          if (result.matches > 0) {
            counts.rowsMatched += 1;
            counts.matches += result.matches;
            matched.push(row.key);
          } else if (!replaced?.has(row.key) && !row.unreferenced) {
            continue;
          }
          // A blob is content-addressed: rewriting it in place would break
          // its digest. The snapshot pass wrote rewritten blobs; the old one
          // (and every chunk nothing refers to any more, which may hold part
          // of a secret split across chunks) is deleted once nothing refers
          // to it.
          doomed.push({ key: row.key, session: sessionId, before: md5Hex(row.value) });
        }
        if (!context.dryRun && context.privateGranted && doomed.length > 0) {
          await lockSessionForRedaction(tx, scope, sessionId);
          const deleted = await callRedactCells(tx, scope.workspaceId, BLOB_TABLE, doomed);
          pageChanged = deleted;
          if (matched.length > 0) {
            // A matched blob something still refers to (a tool catalog, or a
            // snapshot whose rewrite failed) keeps its copy; say so.
            const kept = await rawRows<{ key: string }>(
              tx,
              sql`select digest as key from session_content_blobs
                where workspace_id = ${scope.workspaceId}::uuid and session_id = ${sessionId}::uuid
                  and digest = any(${arrayLiteral(matched)}::text[])`,
            );
            for (const _row of kept) context.tally.fail(sessionId, BLOB_TABLE, NOT_REWRITTEN);
          }
        }
      });
      counts.rowsChanged += pageChanged;
    } catch (error) {
      context.tally.fail(sessionId, BLOB_TABLE, error);
    }
  }
}

async function scrubSearchMirror(context: Context, sessionId: string) {
  const { scope } = context;
  const counts = context.tally.counts(sessionId, SEARCH_TABLE);
  let resynced = 0;
  try {
    await withRlsContext(context.db, scope, async (tx) => {
      // The mirror is readable only under a search pattern; match everything.
      const readMirror = async () => {
        await tx.execute(
          sql`select set_config('opengeni.session_message_search_pattern', '^', true)`,
        );
        const rows = await rawRows<{ text: string; encoded: boolean }>(
          tx,
          sql`select text, encoded from session_message_search_texts
            where workspace_id = ${scope.workspaceId}::uuid and session_id = ${sessionId}::uuid`,
        );
        await tx.execute(
          sql`select set_config('opengeni.session_message_search_pattern', '', true)`,
        );
        let matchedRows = 0;
        let matches = 0;
        let unreadable = 0;
        for (const row of rows) {
          // Mirrors hold the event's raw JSON string value; an `encoded` row
          // holds it as a lossless JSON string (prefix and base64).
          // The decoder returns a malformed value unchanged instead of
          // throwing, and an encoded row always changes when decoded.
          const text = row.encoded
            ? fromPostgresLosslessJson(row.text, LOSSLESS_CONTENT_CODEC_VERSION)
            : row.text;
          if (row.encoded && text === row.text) {
            unreadable += 1;
            continue;
          }
          const result = redactStoredText(text, null, context.matchers);
          if (result.matches === 0) continue;
          matchedRows += 1;
          matches += result.matches;
        }
        return { matchedRows, matches, unreadable };
      };
      const found = await readMirror();
      counts.rowsMatched += found.matchedRows;
      counts.matches += found.matches;
      const failUnreadable = (count: number) => {
        for (let index = 0; index < Math.min(count, 20); index += 1) {
          context.tally.fail(sessionId, SEARCH_TABLE, { code: "mirror_row_unreadable" });
        }
      };
      // The mirror is rebuilt from the (already scrubbed) events rather than
      // edited; a no-op for rows in sync. A run that changed the events but
      // could not resync leaves rows that still match, so a rerun resyncs.
      if (
        !context.dryRun &&
        context.privateGranted &&
        (found.matchedRows > 0 || found.unreadable > 0)
      ) {
        await lockSessionForRedaction(tx, scope, sessionId);
        resynced = await callRedactCells(tx, scope.workspaceId, SEARCH_TABLE, [{ key: sessionId }]);
        // A row the resync could not fix (its event still holds the copy).
        const left = await readMirror();
        failShortfall(context, sessionId, SEARCH_TABLE, left.matchedRows);
        failUnreadable(left.unreadable);
      } else {
        failUnreadable(found.unreadable);
      }
    });
    counts.rowsChanged += resynced;
  } catch (error) {
    context.tally.fail(sessionId, SEARCH_TABLE, error);
  }
}

async function scrubPrivateReadTable(
  context: Context,
  table: (typeof PRIVATE_READ_TABLES)[number],
  sessionIds: readonly string[],
) {
  const { scope } = context;
  const textCells = new Set(PRIVATE_READ_TEXT_CELLS[table] ?? []);
  let after: string | null = null;
  for (let page = 0; page < 100_000; page += 1) {
    type Found = { row_key: string; row_session_id: string; cells: unknown };
    let rows: Found[] = [];
    const cellsByRow = new Map<string, Record<string, unknown>[]>();
    try {
      rows = await withRlsContext(context.db, scope, async (tx) =>
        rawRows<Found>(
          tx,
          sql`select row_key::text as row_key, row_session_id::text as row_session_id, cells
            from opengeni_private.session_secret_redaction_rows_v1(
              ${scope.workspaceId}::uuid, ${arrayLiteral(sessionIds)}::uuid[], ${table},
              ${after}::uuid, ${context.pageRows})`,
        ),
      );
    } catch (error) {
      // Without this page there is no cursor to continue from.
      context.tally.fail(null, table, error);
      return;
    }
    for (const row of rows) {
      const counts = context.tally.counts(row.row_session_id, table);
      const cells = (row.cells ?? {}) as Record<string, { value?: unknown; codec?: unknown }>;
      let rowMatches = 0;
      for (const [column, cell] of Object.entries(cells)) {
        if (typeof cell?.value !== "string") continue;
        const codec = typeof cell.codec === "number" ? cell.codec : null;
        const result = redactCell(
          textCells.has(column) ? "text" : "jsonb",
          cell.value,
          codec,
          context.matchers,
        );
        if (result.matches === 0) continue;
        rowMatches += result.matches;
        const rowCells = cellsByRow.get(row.row_key) ?? [];
        rowCells.push({
          key: row.row_key,
          session: row.row_session_id,
          column,
          before: md5Hex(cell.value),
          value: result.text,
        });
        cellsByRow.set(row.row_key, rowCells);
      }
      if (rowMatches > 0) {
        counts.rowsMatched += 1;
        counts.matches += rowMatches;
      }
    }
    if (!context.dryRun) {
      // One row per transaction, under its own session's writer lock, so a
      // session that became busy (or one failed row) leaves the rest alone.
      for (const row of rows) {
        const rowCells = cellsByRow.get(row.row_key);
        if (!rowCells) continue;
        try {
          const changed = await withRlsContext(context.db, scope, async (tx) => {
            await lockSessionForRedaction(tx, scope, row.row_session_id);
            return await callRedactCells(tx, scope.workspaceId, table, rowCells);
          });
          if (changed > 0) context.tally.counts(row.row_session_id, table).rowsChanged += 1;
          failShortfall(context, row.row_session_id, table, rowCells.length - changed);
        } catch (error) {
          context.tally.fail(row.row_session_id, table, error);
        }
      }
    }
    if (rows.length < context.pageRows) return;
    after = rows.at(-1)!.row_key;
  }
}

function md5Hex(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

/**
 * Scrub (or, with `dryRun`, count) every stored copy the matchers find in the
 * given sessions. The caller authorizes the sessions; this never widens them.
 * Failures are recorded per table and session and never stop the run.
 */
export async function scrubSessionSecretHistory(
  db: Database,
  scope: SessionSecretRedactionScope,
  options: SessionSecretRedactionOptions,
): Promise<SessionSecretRedactionReport> {
  const sessions = await listSessionsForSecretRedaction(db, scope, {
    sessionIds: options.sessionIds,
    includeDescendants: false,
    limit: 1000,
  });
  const privateGranted = await sessionSecretRedactionRoutinesGranted(db);
  const context: Context = {
    db,
    scope,
    matchers: options.matchers,
    dryRun: options.dryRun,
    pageRows: Math.max(1, Math.min(options.pageRows ?? DEFAULT_PAGE_ROWS, 500)),
    privateGranted,
    rewriteReferencedSnapshots: options.rewriteReferencedSnapshotsWhilePending === true,
    tally: new Tally(),
    replacedBlobs: new Map(),
  };
  const skipped = new Set<string>();
  if (options.matchers.length > 0) {
    for (const session of sessions) {
      if ((session.active || session.archiving) && !options.dryRun) {
        // Checked again under the session lock before every write.
        context.tally.fail(
          session.id,
          "sessions",
          session.active ? new SessionActiveError() : new SessionArchivingError(),
        );
        skipped.add(session.id);
        continue;
      }
      for (const spec of DIRECT_TABLES) {
        try {
          await scrubDirectTable(context, spec, session.id);
        } catch (error) {
          context.tally.fail(session.id, spec.table, error);
        }
      }
      for (const [table, step] of [
        [SNAPSHOT_TABLE, scrubSnapshots],
        [BLOB_TABLE, scrubBlobs],
        [SEARCH_TABLE, scrubSearchMirror],
      ] as const) {
        try {
          await step(context, session.id);
        } catch (error) {
          context.tally.fail(session.id, table, error);
        }
      }
    }
    const resting = sessions.filter((session) => !skipped.has(session.id));
    if (privateGranted && resting.length > 0) {
      for (const table of PRIVATE_READ_TABLES) {
        await scrubPrivateReadTable(
          context,
          table,
          resting.map((session) => session.id),
        );
      }
    }
  }
  return buildReport(context, sessions);
}

function buildReport(
  context: Context,
  sessions: ReadonlyArray<{ id: string; archived: boolean }>,
): SessionSecretRedactionReport {
  const tables: Record<string, SecretRedactionCounts> = {};
  for (const table of SESSION_SECRET_REDACTION_TABLES) tables[table] = emptyCounts();
  const report: SessionSecretRedactionReport = {
    dryRun: context.dryRun,
    sessions: [],
    tables,
    pending: context.privateGranted ? [] : [...PRIVATE_TABLES, "session_turns.goal_snapshot"],
    failures: context.tally.failures,
    orphanedBlobs: {},
  };
  if (!context.privateGranted) {
    for (const [sessionId, digests] of context.replacedBlobs) {
      if (digests.size > 0) report.orphanedBlobs[sessionId] = [...digests].sort();
    }
  }
  for (const session of sessions) {
    const entry: Record<string, SecretRedactionCounts> = {};
    for (const [table, counts] of context.tally.bySession.get(session.id) ?? []) {
      if (counts.rowsMatched === 0 && counts.rowsChanged === 0) continue;
      entry[table] = { ...counts };
      const total = (tables[table] ??= emptyCounts());
      total.rowsMatched += counts.rowsMatched;
      total.rowsChanged += counts.rowsChanged;
      total.matches += counts.matches;
    }
    report.sessions.push({ sessionId: session.id, archived: session.archived, tables: entry });
  }
  return report;
}
