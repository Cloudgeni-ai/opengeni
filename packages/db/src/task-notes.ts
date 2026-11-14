import {
  TASK_NOTE_LIST_DEFAULT_LIMIT,
  TASK_NOTE_LIST_MAX_LIMIT,
  TASK_NOTE_MAX_LIFETIME_DAYS,
  TaskNote,
  TaskNoteKind,
  TaskNoteListResponse,
  TaskNoteMutationResult,
  TaskNoteReason,
  TaskNoteReplacementResult,
  TaskNoteText,
  type TaskNoteKind as TaskNoteKindType,
} from "@opengeni/contracts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext } from "./database";
import {
  isDatabaseConnectionLoss,
  isRetryableDatabaseTransportFailure,
  nestedPostgresMessage,
  nestedPostgresSqlState,
} from "./persistence-errors";

export type TaskNoteAttemptClaims = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

export type CreateTaskNoteInput = TaskNoteAttemptClaims & {
  operationId: string;
  kind: TaskNoteKindType;
  text: string;
  expiresInDays: number;
};

export type ArchiveTaskNoteInput = TaskNoteAttemptClaims & {
  operationId: string;
  noteId: string;
  expectedVersion: number;
  reason: string;
};

export type ReplaceTaskNoteInput = TaskNoteAttemptClaims & {
  operationId: string;
  replacedNoteId: string;
  expectedReplacedVersion: number;
  replacementKind: TaskNoteKindType;
  replacementText: string;
  replacementExpiresInDays: number;
  reason: string;
};

export type ListTaskNotesInput = TaskNoteAttemptClaims & {
  includeArchived?: boolean;
  limit?: number;
};

export type TaskNoteOperation = "save" | "archive" | "replace" | "list";

/**
 * Why the task-note routines refused a call, from the SQLSTATE and fixed
 * message they raise:
 * - `active_note_limit`: the root task tree already holds the most active notes (54000).
 * - `invalid_input`: the routine's own input check failed (22023).
 * - `operation_conflict`: the operation ID was already used with other input or
 *   by another attempt (23505 raised by the routine).
 * - `note_not_found`: the note is not in this task tree (P0002).
 * - `note_not_active`: the note was already archived, replaced or expired (40001
 *   raised by the lifecycle check).
 * - `attempt_not_authorized`: the caller is not the exact current attempt of a
 *   visible session in the tree (42501).
 * - `transient`: the database briefly could not answer (lost connection,
 *   deadlock, serialization or lock timeout, or a concurrent duplicate insert).
 */
export type TaskNoteRefusalReason =
  | "active_note_limit"
  | "invalid_input"
  | "operation_conflict"
  | "note_not_found"
  | "note_not_active"
  | "attempt_not_authorized"
  | "transient";

/**
 * A task-note call the database refused, classified so callers can explain it
 * without the driver error. The message is fixed and never carries SQL,
 * parameters or note text; the original failure stays only as `cause`.
 */
export class TaskNoteRefusedError extends Error {
  override name = "TaskNoteRefusedError";

  constructor(
    readonly operation: TaskNoteOperation,
    readonly reason: TaskNoteRefusalReason,
    readonly sqlState: string | null,
    options?: { cause?: unknown },
  ) {
    super(`Task note ${operation} refused: ${reason}`, options);
  }
}

// The fixed messages the task-note routines raise, by refusal. Matching the
// message as well as the SQLSTATE keeps a generic driver failure with the same
// code (a unique violation, a serialization victim) from being misreported.
const TASK_NOTE_RAISED_MESSAGES: ReadonlyMap<string, TaskNoteRefusalReason> = new Map([
  ["54000:task note active-record limit reached", "active_note_limit"],
  ["22023:task note input is invalid", "invalid_input"],
  ["22023:task note archive input is invalid", "invalid_input"],
  ["22023:task note list input is invalid", "invalid_input"],
  ["22023:Task-note replacement input is invalid", "invalid_input"],
  ["23505:task note operation conflicts with another input or attempt", "operation_conflict"],
  [
    "23505:task note archive operation conflicts with another input or attempt",
    "operation_conflict",
  ],
  [
    "23505:Task-note replacement operation conflicts with another input or attempt",
    "operation_conflict",
  ],
  ["P0002:task note is unavailable", "note_not_found"],
  ["P0002:Task note is unavailable for replacement", "note_not_found"],
  ["40001:task note archive version conflict", "note_not_active"],
  ["40001:Task-note replacement version or lifecycle conflict", "note_not_active"],
]);

// Contention the transaction rolled back from, and a unique violation the
// routine did not raise itself (two exact retries racing on one operation ID).
const TRANSIENT_TASK_NOTE_SQLSTATES = new Set(["40001", "40P01", "55P03", "23505"]);

/**
 * Classify a failed task-note call, or null when it is not a refusal these
 * routines are known to raise. Unknown failures keep their original error.
 */
export function classifyTaskNoteFailure(
  operation: TaskNoteOperation,
  error: unknown,
): TaskNoteRefusedError | null {
  if (error instanceof TaskNoteRefusedError) return error;
  const sqlState = nestedPostgresSqlState(error);
  let reason: TaskNoteRefusalReason | null = null;
  if (sqlState !== null) {
    reason = TASK_NOTE_RAISED_MESSAGES.get(`${sqlState}:${nestedPostgresMessage(error)}`) ?? null;
    if (!reason && sqlState === "42501") reason = "attempt_not_authorized";
    if (!reason && TRANSIENT_TASK_NOTE_SQLSTATES.has(sqlState)) reason = "transient";
  }
  if (!reason && (isDatabaseConnectionLoss(error) || isRetryableDatabaseTransportFailure(error))) {
    reason = "transient";
  }
  return reason ? new TaskNoteRefusedError(operation, reason, sqlState, { cause: error }) : null;
}

function refusingTaskNoteFailure(operation: TaskNoteOperation) {
  return (error: unknown): never => {
    throw classifyTaskNoteFailure(operation, error) ?? error;
  };
}

type TaskNoteRow = {
  note_id: string;
  root_session_id: string;
  kind: string;
  note_text: string;
  status: string;
  version: number;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  actor_kind: string;
  source_session_id: string;
  source_turn_id: string;
  replayed?: boolean;
};

type TaskNoteReplacementRow = {
  operation_id: string;
  input_hash: string;
  replaced_note_id: string;
  replaced_note_version: number;
  replacement_note_id: string;
  root_session_id: string;
  replacement_kind: string;
  replacement_text: string;
  replacement_status: string;
  replacement_version: number;
  replacement_expires_at: Date | string;
  replacement_created_at: Date | string;
  replacement_updated_at: Date | string;
  replacement_archived_at: Date | string | null;
  replacement_actor_kind: string;
  replacement_source_session_id: string;
  replacement_source_turn_id: string;
  replayed: boolean;
};

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function noteFromRow(row: TaskNoteRow) {
  return TaskNote.parse({
    id: row.note_id,
    rootSessionId: row.root_session_id,
    kind: row.kind,
    text: row.note_text,
    status: row.status,
    version: row.version,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: row.archived_at === null ? null : iso(row.archived_at),
    provenance: {
      actorKind: row.actor_kind,
      sourceSessionId: row.source_session_id,
      sourceTurnId: row.source_turn_id,
    },
  });
}

function assertAttemptClaims(claims: TaskNoteAttemptClaims): void {
  if (!Number.isSafeInteger(claims.executionGeneration) || claims.executionGeneration < 1) {
    throw new Error("Task notes require a positive exact execution generation");
  }
}

function derivedTaskNoteOperationId(operationId: string, label: "archive" | "create"): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`task-note-replacement:v1:${operationId}:${label}`, "utf8")
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createTaskNote(db: Database, input: CreateTaskNoteInput) {
  assertAttemptClaims(input);
  TaskNoteKind.parse(input.kind);
  TaskNoteText.parse(input.text);
  if (
    !Number.isSafeInteger(input.expiresInDays) ||
    input.expiresInDays < 1 ||
    input.expiresInDays > TASK_NOTE_MAX_LIFETIME_DAYS
  ) {
    throw new Error(`Task note expiry must be 1-${TASK_NOTE_MAX_LIFETIME_DAYS} whole days`);
  }
  const rows = await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) =>
      await rawRows<TaskNoteRow>(
        tx,
        sql`SELECT * FROM create_task_note_for_attempt(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid,
          ${input.turnId}::uuid,
          ${input.attemptId}::uuid,
          ${input.executionGeneration}::integer,
          ${input.operationId}::uuid,
          ${input.kind}::text,
          ${input.text}::text,
          ${input.expiresInDays}::integer
        )`,
      ),
  ).catch(refusingTaskNoteFailure("save"));
  if (rows.length !== 1) throw new Error("Task note create returned no durable receipt");
  return TaskNoteMutationResult.parse({ note: noteFromRow(rows[0]!), replayed: rows[0]!.replayed });
}

export async function archiveTaskNote(db: Database, input: ArchiveTaskNoteInput) {
  assertAttemptClaims(input);
  TaskNoteReason.parse(input.reason);
  const rows = await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) =>
      await rawRows<TaskNoteRow>(
        tx,
        sql`SELECT * FROM archive_task_note_for_attempt(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid,
          ${input.turnId}::uuid,
          ${input.attemptId}::uuid,
          ${input.executionGeneration}::integer,
          ${input.operationId}::uuid,
          ${input.noteId}::uuid,
          ${input.expectedVersion}::integer,
          ${input.reason}::text
        )`,
      ),
  ).catch(refusingTaskNoteFailure("archive"));
  if (rows.length !== 1) throw new Error("Task note archive returned no durable receipt");
  return TaskNoteMutationResult.parse({ note: noteFromRow(rows[0]!), replayed: rows[0]!.replayed });
}

/**
 * Atomically archive one exact active note and create its immutable replacement.
 * Exact retries return the original linked receipt; changed input or authority fails.
 */
export async function replaceTaskNote(db: Database, input: ReplaceTaskNoteInput) {
  assertAttemptClaims(input);
  TaskNoteKind.parse(input.replacementKind);
  TaskNoteText.parse(input.replacementText);
  TaskNoteReason.parse(input.reason);
  if (
    input.expectedReplacedVersion !== 1 ||
    !Number.isSafeInteger(input.replacementExpiresInDays) ||
    input.replacementExpiresInDays < 1 ||
    input.replacementExpiresInDays > TASK_NOTE_MAX_LIFETIME_DAYS
  ) {
    throw new Error(
      `Task-note replacement requires version 1 and a 1-${TASK_NOTE_MAX_LIFETIME_DAYS} day expiry`,
    );
  }
  const archiveOperationId = derivedTaskNoteOperationId(input.operationId, "archive");
  const createOperationId = derivedTaskNoteOperationId(input.operationId, "create");
  const rows = await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) =>
      await rawRows<TaskNoteReplacementRow>(
        tx,
        sql`SELECT * FROM replace_task_note_for_attempt(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid,
          ${input.turnId}::uuid,
          ${input.attemptId}::uuid,
          ${input.executionGeneration}::integer,
          ${input.operationId}::uuid,
          ${archiveOperationId}::uuid,
          ${createOperationId}::uuid,
          ${input.replacedNoteId}::uuid,
          ${input.expectedReplacedVersion}::integer,
          ${input.replacementKind}::text,
          ${input.replacementText}::text,
          ${input.replacementExpiresInDays}::integer,
          ${input.reason}::text
        )`,
      ),
  ).catch(refusingTaskNoteFailure("replace"));
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error("Task-note replacement returned no receipt");
  return TaskNoteReplacementResult.parse({
    operationId: row.operation_id,
    inputHash: row.input_hash,
    replaces: {
      noteId: row.replaced_note_id,
      archivedVersion: row.replaced_note_version,
    },
    replacement: noteFromRow({
      note_id: row.replacement_note_id,
      root_session_id: row.root_session_id,
      kind: row.replacement_kind,
      note_text: row.replacement_text,
      status: row.replacement_status,
      version: row.replacement_version,
      expires_at: row.replacement_expires_at,
      created_at: row.replacement_created_at,
      updated_at: row.replacement_updated_at,
      archived_at: row.replacement_archived_at,
      actor_kind: row.replacement_actor_kind,
      source_session_id: row.replacement_source_session_id,
      source_turn_id: row.replacement_source_turn_id,
    }),
    replayed: row.replayed,
  });
}

export async function listTaskNotes(db: Database, input: ListTaskNotesInput) {
  assertAttemptClaims(input);
  const limit = input.limit ?? TASK_NOTE_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_NOTE_LIST_MAX_LIMIT) {
    throw new Error(`Task note list limit must be 1-${TASK_NOTE_LIST_MAX_LIMIT}`);
  }
  const rows = await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) =>
      await rawRows<TaskNoteRow>(
        tx,
        sql`SELECT * FROM list_task_notes_for_attempt(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid,
          ${input.turnId}::uuid,
          ${input.attemptId}::uuid,
          ${input.executionGeneration}::integer,
          ${input.includeArchived ?? false}::boolean,
          ${limit}::integer
        )`,
      ),
  ).catch(refusingTaskNoteFailure("list"));
  return TaskNoteListResponse.parse({ notes: rows.map(noteFromRow) });
}
