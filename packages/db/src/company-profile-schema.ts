import { sql } from "drizzle-orm";
import type { CompanyProfileSnapshotEntry } from "@opengeni/contracts";
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

export const companyProfileRevisions = pgTable(
  "company_profile_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    accountId: uuid("account_id").notNull(),
    revision: bigint("revision", { mode: "number" })
      .notNull()
      .default(sql`nextval('company_profile_revision_seq')`),
    intent: text("intent").notNull(),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    provenanceSource: text("provenance_source").notNull(),
    provenanceSourceId: text("provenance_source_id"),
    supersedesRevisionId: uuid("supersedes_revision_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountOperation: uniqueIndex("company_profile_revisions_account_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    accountRevision: uniqueIndex("company_profile_revisions_account_revision_uq").on(
      table.accountId,
      table.revision,
    ),
    accountHistory: index("company_profile_revisions_account_history_idx").on(
      table.accountId,
      table.revision,
    ),
    receipt: check(
      "company_profile_revisions_receipt_chk",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    intent: check(
      "company_profile_revisions_intent_chk",
      sql`${table.intent} in ('active', 'proposal')`,
    ),
  }),
);

export const companyProfileHeads = pgTable("company_profile_heads", {
  accountId: uuid("account_id").primaryKey(),
  revisionId: uuid("revision_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  contentHash: text("content_hash").notNull(),
  activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companyProfileActivationEvents = pgTable(
  "company_profile_activation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    accountId: uuid("account_id").notNull(),
    type: text("type").notNull(),
    activationVersion: bigint("activation_version", { mode: "number" }).notNull(),
    oldRevisionId: uuid("old_revision_id"),
    oldRevision: bigint("old_revision", { mode: "number" }),
    oldContentHash: text("old_content_hash"),
    newRevisionId: uuid("new_revision_id"),
    newRevision: bigint("new_revision", { mode: "number" }),
    newContentHash: text("new_content_hash"),
    actorSubjectId: text("actor_subject_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountOperation: uniqueIndex("company_profile_events_account_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    accountActivationVersion: uniqueIndex("company_profile_events_account_version_uq").on(
      table.accountId,
      table.activationVersion,
    ),
    accountTimeline: index("company_profile_events_account_time_idx").on(
      table.accountId,
      table.createdAt,
      table.id,
    ),
    receipt: check(
      "company_profile_events_receipt_chk",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    type: check("company_profile_events_type_chk", sql`${table.type} in ('activate', 'rollback')`),
  }),
);

export const companyProfileSnapshots = pgTable(
  "company_profile_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    profile: jsonb("profile").$type<CompanyProfileSnapshotEntry | null>(),
    snapshotHash: text("snapshot_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attempt: uniqueIndex("company_profile_snapshots_attempt_uq").on(
      table.accountId,
      table.workspaceId,
      table.attemptId,
    ),
    workspaceTimeline: index("company_profile_snapshots_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    generation: check(
      "company_profile_snapshots_generation_chk",
      sql`${table.executionGeneration} > 0`,
    ),
    hash: check(
      "company_profile_snapshots_hash_chk",
      sql`${table.snapshotHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
