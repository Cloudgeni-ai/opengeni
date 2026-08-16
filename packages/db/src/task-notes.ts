import {
  TASK_NOTE_LIST_DEFAULT_LIMIT,
  TASK_NOTE_LIST_MAX_LIMIT,
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
    input.expiresInDays > 30
  ) {
    throw new Error("Task note expiry must be 1-30 whole days");
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
  );
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
  );
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
    input.replacementExpiresInDays > 30
  ) {
    throw new Error("Task-note replacement requires version 1 and a 1-30 day expiry");
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
  );
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
  );
  return TaskNoteListResponse.parse({ notes: rows.map(noteFromRow) });
}
