import type { WorkspaceLearningSourceOverride } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const workspaceLearningPolicyRevisions = pgTable(
  "workspace_learning_policy_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    revision: bigint("revision", { mode: "number" })
      .notNull()
      .default(sql`nextval('workspace_learning_policy_revision_seq')`),
    workspaceMode: text("workspace_mode").notNull(),
    sourceOverrides: jsonb("source_overrides").$type<WorkspaceLearningSourceOverride[]>().notNull(),
    policyHash: text("policy_hash").notNull(),
    supersedesRevisionId: uuid("supersedes_revision_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceOperation: uniqueIndex(
      "workspace_learning_policy_revisions_workspace_operation_uq",
    ).on(table.workspaceId, table.operationId),
    workspaceRevision: uniqueIndex("workspace_learning_policy_revisions_workspace_revision_uq").on(
      table.workspaceId,
      table.revision,
    ),
    workspaceHistory: index("workspace_learning_policy_revisions_workspace_history_idx").on(
      table.workspaceId,
      table.revision,
    ),
    mode: check(
      "workspace_learning_policy_revisions_mode_chk",
      sql`${table.workspaceMode} in ('off', 'suggest', 'automatic')`,
    ),
  }),
);

export const workspaceLearningPolicyHeads = pgTable(
  "workspace_learning_policy_heads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    policyHash: text("policy_hash").notNull(),
    activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspace: uniqueIndex("workspace_learning_policy_heads_workspace_uq").on(table.workspaceId),
  }),
);

export const workspaceLearningPolicyActivationEvents = pgTable(
  "workspace_learning_policy_activation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    type: text("type").notNull(),
    activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
    oldRevisionId: uuid("old_revision_id"),
    oldRevision: bigint("old_revision", { mode: "number" }),
    oldPolicyHash: text("old_policy_hash"),
    newRevisionId: uuid("new_revision_id").notNull(),
    newRevision: bigint("new_revision", { mode: "number" }).notNull(),
    newPolicyHash: text("new_policy_hash").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceOperation: uniqueIndex("workspace_learning_policy_events_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    workspaceVersion: uniqueIndex("workspace_learning_policy_events_workspace_version_uq").on(
      table.workspaceId,
      table.activationVersion,
    ),
    workspaceTimeline: index("workspace_learning_policy_events_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const workspaceLearningPolicySnapshots = pgTable(
  "workspace_learning_policy_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    revisionId: uuid("revision_id"),
    revision: bigint("revision", { mode: "number" }),
    policyHash: text("policy_hash"),
    activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    workspaceMode: text("workspace_mode").notNull(),
    sourceOverrides: jsonb("source_overrides").$type<WorkspaceLearningSourceOverride[]>().notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attempt: uniqueIndex("workspace_learning_policy_snapshots_attempt_uq").on(
      table.accountId,
      table.workspaceId,
      table.attemptId,
    ),
    workspaceTimeline: index("workspace_learning_policy_snapshots_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);
