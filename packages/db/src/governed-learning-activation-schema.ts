import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Migration 0269 owns exact foreign keys, RLS, immutability and lifecycle checks. */
export const governedLearningActivationReceipts = pgTable(
  "governed_learning_activation_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    decisionReceiptId: uuid("decision_receipt_id").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id").notNull(),
    serviceActorSubjectId: text("service_actor_subject_id").notNull(),
    policyRevisionId: uuid("policy_revision_id").notNull(),
    policyHash: text("policy_hash").notNull(),
    policyActivationVersion: bigint("policy_activation_version", { mode: "number" }).notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceAuthorityHash: text("source_authority_hash").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    knowledgePreviousReviewId: uuid("knowledge_previous_review_id").notNull(),
    knowledgePreviousReviewRevision: bigint("knowledge_previous_review_revision", {
      mode: "number",
    }).notNull(),
    knowledgeApprovalReviewId: uuid("knowledge_approval_review_id").notNull(),
    knowledgeApprovalReviewRevision: bigint("knowledge_approval_review_revision", {
      mode: "number",
    }).notNull(),
    knowledgeApprovalInputHash: text("knowledge_approval_input_hash").notNull(),
    destination: text("destination").notNull(),
    destinationProposalId: uuid("destination_proposal_id").notNull(),
    destinationRevisionId: uuid("destination_revision_id").notNull(),
    destinationOldRevisionId: uuid("destination_old_revision_id"),
    destinationOldContentHash: text("destination_old_content_hash"),
    destinationOldVersion: bigint("destination_old_version", { mode: "number" }).notNull(),
    destinationNewContentHash: text("destination_new_content_hash").notNull(),
    destinationNewVersion: bigint("destination_new_version", { mode: "number" }).notNull(),
    destinationEventId: uuid("destination_event_id").notNull(),
    // Added by migration 0272 alongside human-confirmed activation; the schema
    // file had not caught up.
    authorityKind: text("authority_kind").notNull().default("automatic"),
    humanInputRequestId: uuid("human_input_request_id"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("governed_learning_activation_receipts_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    decision: uniqueIndex("governed_learning_activation_receipts_decision_uq").on(
      table.decisionReceiptId,
    ),
    timeline: index("governed_learning_activation_receipts_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    hash: check(
      "governed_learning_activation_receipts_hash_chk",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const governedLearningActivationUndoReceipts = pgTable(
  "governed_learning_activation_undo_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    activationReceiptId: uuid("activation_receipt_id").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id").notNull(),
    serviceActorSubjectId: text("service_actor_subject_id").notNull(),
    destination: text("destination").notNull(),
    knowledgeApprovalReviewId: uuid("knowledge_approval_review_id").notNull(),
    knowledgeRevocationReviewId: uuid("knowledge_revocation_review_id").notNull(),
    knowledgeRevocationReviewRevision: bigint("knowledge_revocation_review_revision", {
      mode: "number",
    }).notNull(),
    knowledgeRevocationInputHash: text("knowledge_revocation_input_hash").notNull(),
    destinationActivatedRevisionId: uuid("destination_activated_revision_id").notNull(),
    destinationRestoredRevisionId: uuid("destination_restored_revision_id"),
    destinationActivatedContentHash: text("destination_activated_content_hash").notNull(),
    destinationRestoredContentHash: text("destination_restored_content_hash"),
    destinationOldVersion: bigint("destination_old_version", { mode: "number" }).notNull(),
    destinationNewVersion: bigint("destination_new_version", { mode: "number" }).notNull(),
    destinationEventId: uuid("destination_event_id").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("governed_learning_activation_undo_receipts_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    activation: uniqueIndex("governed_learning_activation_undo_receipts_activation_uq").on(
      table.activationReceiptId,
    ),
    timeline: index("governed_learning_activation_undo_receipts_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);
