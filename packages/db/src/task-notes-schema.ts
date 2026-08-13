import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
});

// Cross-row validation, lifecycle-only mutation, exact-attempt authority,
// restrictive session-visibility RLS, and grants are owned by migration 0239.
export const taskNotes = pgTable(
  "task_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    rootSessionId: uuid("root_session_id").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    textHash: text("text_hash").notNull(),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createOperationId: uuid("create_operation_id").notNull(),
    createInputHash: text("create_input_hash").notNull(),
    createdByActorKind: text("created_by_actor_kind").notNull(),
    createdByActorSubjectId: text("created_by_actor_subject_id").notNull(),
    createdByInitiatingHumanSubjectId: text("created_by_initiating_human_subject_id"),
    createdBySessionId: uuid("created_by_session_id").notNull(),
    createdByTurnId: uuid("created_by_turn_id").notNull(),
    createdByAttemptId: uuid("created_by_attempt_id").notNull(),
    createdByExecutionGeneration: integer("created_by_execution_generation").notNull(),
    archiveOperationId: uuid("archive_operation_id"),
    archiveInputHash: text("archive_input_hash"),
    archivedByActorKind: text("archived_by_actor_kind"),
    archivedByActorSubjectId: text("archived_by_actor_subject_id"),
    archivedByInitiatingHumanSubjectId: text("archived_by_initiating_human_subject_id"),
    archivedBySessionId: uuid("archived_by_session_id"),
    archivedByTurnId: uuid("archived_by_turn_id"),
    archivedByAttemptId: uuid("archived_by_attempt_id"),
    archivedByExecutionGeneration: integer("archived_by_execution_generation"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("task_notes_workspace_id_uq").on(table.workspaceId, table.id),
    workspaceRootIdentity: uniqueIndex("task_notes_workspace_root_id_uq").on(
      table.workspaceId,
      table.rootSessionId,
      table.id,
    ),
    createOperation: uniqueIndex("task_notes_workspace_create_operation_uq").on(
      table.workspaceId,
      table.createOperationId,
    ),
    archiveOperation: uniqueIndex("task_notes_workspace_archive_operation_uq")
      .on(table.workspaceId, table.archiveOperationId)
      .where(sql`${table.archiveOperationId} is not null`),
    rootActive: index("task_notes_root_active_idx").on(
      table.workspaceId,
      table.rootSessionId,
      table.status,
      table.expiresAt,
      table.updatedAt,
      table.id,
    ),
  }),
);

export const taskNoteEvents = pgTable(
  "task_note_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    rootSessionId: uuid("root_session_id").notNull(),
    noteId: uuid("note_id").notNull(),
    eventType: text("event_type").notNull(),
    noteVersion: integer("note_version").notNull(),
    operationId: uuid("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    textHash: text("text_hash").notNull(),
    reason: text("reason"),
    actorKind: text("actor_kind").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id"),
    actorSessionId: uuid("actor_session_id").notNull(),
    actorTurnId: uuid("actor_turn_id").notNull(),
    actorAttemptId: uuid("actor_attempt_id").notNull(),
    actorExecutionGeneration: integer("actor_execution_generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("task_note_events_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    noteVersion: uniqueIndex("task_note_events_note_version_uq").on(
      table.workspaceId,
      table.noteId,
      table.noteVersion,
    ),
    rootTimeline: index("task_note_events_root_timeline_idx").on(
      table.workspaceId,
      table.rootSessionId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const taskNoteWriteCapabilities = pgTable(
  "task_note_write_capabilities",
  {
    backendPid: integer("backend_pid").notNull(),
    transactionId: xid8("transaction_id").notNull(),
    capabilityId: uuid("capability_id").notNull(),
  },
  (table) => ({
    identity: uniqueIndex("task_note_write_capabilities_identity_uq").on(
      table.backendPid,
      table.transactionId,
      table.capabilityId,
    ),
  }),
);
