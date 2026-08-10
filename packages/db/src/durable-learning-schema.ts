import type {
  DurableLearningAttemptReceipt,
  DurableLearningRouteDecision,
} from "@opengeni/contracts";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sessions, sessionTurnAttempts, sessionTurns, workspaces } from "./schema";

export const durableLearningAttempts = pgTable(
  "durable_learning_attempts",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    executionAttemptId: uuid("execution_attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id").notNull(),
    operation: text("operation").$type<"write" | "rollback">().notNull(),
    targetSurface: text("target_surface")
      .$type<"company_profile" | "workspace_instruction_policy" | "preference_registry">()
      .notNull(),
    inputHash: text("input_hash").notNull(),
    canonicalInput: text("canonical_input").notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    decision: jsonb("decision").$type<DurableLearningRouteDecision>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceAccount: foreignKey({
      name: "durable_learning_attempts_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("restrict"),
    session: foreignKey({
      name: "durable_learning_attempts_session_fk",
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete("restrict"),
    turn: foreignKey({
      name: "durable_learning_attempts_turn_fk",
      columns: [table.workspaceId, table.turnId],
      foreignColumns: [sessionTurns.workspaceId, sessionTurns.id],
    }).onDelete("restrict"),
    executionAttempt: foreignKey({
      name: "durable_learning_attempts_execution_attempt_fk",
      columns: [table.workspaceId, table.executionAttemptId],
      foreignColumns: [sessionTurnAttempts.workspaceId, sessionTurnAttempts.id],
    }).onDelete("restrict"),
    inputHashValid: check(
      "durable_learning_attempts_input_hash_chk",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
    generationValid: check(
      "durable_learning_attempts_generation_chk",
      sql`${table.executionGeneration} > 0`,
    ),
    actorValid: check(
      "durable_learning_attempts_actor_chk",
      sql`length(btrim(${table.initiatingHumanSubjectId})) between 1 and 1024`,
    ),
    executionLookup: index("durable_learning_attempts_execution_idx").on(
      table.workspaceId,
      table.executionAttemptId,
      table.createdAt,
    ),
    workspaceIdentity: uniqueIndex("durable_learning_attempts_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
  }),
);

export const durableLearningAttemptReceipts = pgTable(
  "durable_learning_attempt_receipts",
  {
    attemptId: uuid("attempt_id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    inputHash: text("input_hash").notNull(),
    receipt: jsonb("receipt").$type<DurableLearningAttemptReceipt>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attempt: foreignKey({
      name: "durable_learning_attempt_receipts_attempt_fk",
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [durableLearningAttempts.workspaceId, durableLearningAttempts.id],
    }).onDelete("restrict"),
    workspaceAccount: foreignKey({
      name: "durable_learning_attempt_receipts_workspace_account_fk",
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [workspaces.id, workspaces.accountId],
    }).onDelete("restrict"),
    inputHashValid: check(
      "durable_learning_attempt_receipts_input_hash_chk",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
