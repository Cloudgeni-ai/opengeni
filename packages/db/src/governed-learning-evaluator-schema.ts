import type { GovernedLearningDecisionReason } from "@opengeni/contracts";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Immutable, content-free evaluator evidence. Migration 0268 owns the exact
 * foreign keys, checks, FORCE-RLS policies, trigger, and runtime privileges.
 */
export const governedLearningDecisionReceipts = pgTable(
  "governed_learning_decision_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id").notNull(),
    policySnapshotId: uuid("policy_snapshot_id").notNull(),
    policySnapshotHash: text("policy_snapshot_hash").notNull(),
    policyRevisionId: uuid("policy_revision_id"),
    policyActivationVersion: bigint("policy_activation_version", { mode: "number" }).notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    proposalInputHash: text("proposal_input_hash").notNull(),
    proposalContentHash: text("proposal_content_hash").notNull(),
    claimId: uuid("claim_id").notNull(),
    claimInputHash: text("claim_input_hash").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    evidenceInputHash: text("evidence_input_hash").notNull(),
    evidenceContentHash: text("evidence_content_hash").notNull(),
    evidenceAuthorityHash: text("evidence_authority_hash").notNull(),
    reviewRevision: bigint("review_revision", { mode: "number" }).notNull(),
    reviewState: text("review_state").notNull(),
    effectiveMode: text("effective_mode").notNull(),
    confidenceBps: integer("confidence_bps").notNull(),
    conflictCount: integer("conflict_count").notNull(),
    outcome: text("outcome").notNull(),
    reasonCodes: text("reason_codes").array().$type<GovernedLearningDecisionReason[]>().notNull(),
    automaticEligible: boolean("automatic_eligible").notNull(),
    confidenceFloorBps: integer("confidence_floor_bps").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceOperation: uniqueIndex("governed_learning_decision_receipts_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    snapshotProposal: uniqueIndex("governed_learning_decision_receipts_snapshot_proposal_uq").on(
      table.policySnapshotId,
      table.proposalId,
    ),
    workspaceTimeline: index("governed_learning_decision_receipts_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);
