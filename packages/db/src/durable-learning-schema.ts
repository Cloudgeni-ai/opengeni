import type { DurableLearningReceipt, DurableLearningRequest } from "@opengeni/contracts";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Cross-table foreign keys, JSON bounds, immutability triggers, RLS, and
// runtime grants are migration-owned. This leaf remains cycle-free so the
// ordinary schema barrel can expose the append-only router ledger.
export const durableLearningAttempts = pgTable(
  "durable_learning_attempts",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    contractVersion: text("contract_version").notNull(),
    operation: text("operation").notNull(),
    origin: text("origin").notNull(),
    inputHash: text("input_hash").notNull(),
    request: jsonb("request").$type<DurableLearningRequest>().notNull(),
    actorKind: text("actor_kind").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id"),
    sessionId: uuid("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantAttempt: uniqueIndex("durable_learning_attempts_tenant_attempt_uq").on(
      table.accountId,
      table.workspaceId,
      table.id,
    ),
    workspaceTimeline: index("durable_learning_attempts_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const durableLearningReceipts = pgTable(
  "durable_learning_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    inputHash: text("input_hash").notNull(),
    outcome: text("outcome").notNull(),
    destination: text("destination"),
    resourceId: text("resource_id"),
    receipt: jsonb("receipt").$type<DurableLearningReceipt>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attempt: uniqueIndex("durable_learning_receipts_attempt_uq").on(
      table.accountId,
      table.workspaceId,
      table.attemptId,
    ),
    workspaceTimeline: index("durable_learning_receipts_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);

// Immutable authority-side compatibility output. The selected authority writes
// this in the same transaction as its effect so a retry can reconstruct the
// exact original result without invoking the mutable authority again.
export const durableLearningAuthorityResults = pgTable(
  "durable_learning_authority_results",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    inputHash: text("input_hash").notNull(),
    effectKind: text("effect_kind").notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "durable_learning_authority_results_pk",
      columns: [table.accountId, table.workspaceId, table.attemptId],
    }),
    workspaceTimeline: index("durable_learning_authority_results_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.attemptId,
    ),
  }),
);

// Mutable coordination only: claims fence concurrent execution while attempts
// and receipts remain immutable audit evidence. Expired claims may be replaced
// so a crashed executor can retry the same authority operation id.
export const durableLearningAttemptClaims = pgTable(
  "durable_learning_attempt_claims",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "durable_learning_attempt_claims_pk",
      columns: [table.accountId, table.workspaceId, table.attemptId],
    }),
    expiry: index("durable_learning_attempt_claims_expiry_idx").on(
      table.workspaceId,
      table.expiresAt,
      table.attemptId,
    ),
  }),
);
