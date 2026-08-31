import { sql } from "drizzle-orm";
import type {
  CompanyProfileAgentHumanInputPrompt,
  CompanyProfileAgentPolicyMode,
  CompanyProfileSnapshotEntry,
} from "@opengeni/contracts";
import {
  bigint,
  boolean,
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
    idAccount: uniqueIndex("company_profile_revisions_id_account_uq").on(table.id, table.accountId),
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
    idAccount: uniqueIndex("company_profile_events_id_account_uq").on(table.id, table.accountId),
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

export const organizationCompanyProfileAgentPolicies = pgTable(
  "organization_company_profile_agent_policies",
  {
    accountId: uuid("account_id").primaryKey(),
    mode: text("mode").$type<CompanyProfileAgentPolicyMode>().notNull().default("suggest"),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    updatedByMembershipId: uuid("updated_by_membership_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mode: check(
      "organization_company_profile_agent_policies_mode_check",
      sql`${table.mode} in ('off', 'suggest', 'automatic')`,
    ),
    version: check(
      "organization_company_profile_agent_policies_version_check",
      sql`${table.version} >= 0`,
    ),
  }),
);

export const organizationCompanyProfileAgentPolicyEvents = pgTable(
  "organization_company_profile_agent_policy_events",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    requestedMode: text("requested_mode").$type<CompanyProfileAgentPolicyMode>().notNull(),
    expectedVersion: bigint("expected_version", { mode: "number" }).notNull(),
    resultMode: text("result_mode").$type<CompanyProfileAgentPolicyMode>().notNull(),
    resultVersion: bigint("result_version", { mode: "number" }).notNull(),
    resultUpdatedAt: timestamp("result_updated_at", { withTimezone: true }).notNull(),
    changed: boolean("changed").notNull(),
  },
  (table) => ({
    accountTimeline: index("organization_company_profile_agent_policy_events_account_idx").on(
      table.accountId,
      table.resultVersion,
    ),
    modes: check(
      "organization_company_profile_agent_policy_events_mode_check",
      sql`${table.requestedMode} in ('off', 'suggest', 'automatic')
        and ${table.resultMode} in ('off', 'suggest', 'automatic')`,
    ),
    versions: check(
      "organization_company_profile_agent_policy_events_version_check",
      sql`${table.expectedVersion} >= 0 and ${table.resultVersion} > 0`,
    ),
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

export const companyProfileAgentProposalReceipts = pgTable(
  "company_profile_agent_proposal_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    creationAttemptId: uuid("creation_attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id").notNull(),
    initiatingMembershipId: uuid("initiating_membership_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    expectedCurrentRevisionId: uuid("expected_current_revision_id"),
    expectedActivationVersion: bigint("expected_activation_version", { mode: "number" }).notNull(),
    policyMode: text("policy_mode").$type<CompanyProfileAgentPolicyMode>().notNull(),
    policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    humanInput: jsonb("human_input").$type<CompanyProfileAgentHumanInputPrompt>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountOperation: uniqueIndex("company_profile_agent_proposals_account_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    accountRevision: uniqueIndex("company_profile_agent_proposals_account_revision_uq").on(
      table.accountId,
      table.revisionId,
    ),
    idAccount: uniqueIndex("company_profile_agent_proposals_id_account_uq").on(
      table.id,
      table.accountId,
    ),
    turn: index("company_profile_agent_proposals_turn_idx").on(
      table.workspaceId,
      table.sessionId,
      table.turnId,
      table.executionGeneration,
    ),
    hash: check(
      "company_profile_agent_proposals_input_hash_check",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
    generation: check(
      "company_profile_agent_proposals_generation_check",
      sql`${table.executionGeneration} > 0
        and ${table.expectedActivationVersion} >= 0
        and ${table.policyVersion} >= 0`,
    ),
    subject: check(
      "company_profile_agent_proposals_subject_check",
      sql`octet_length(btrim(${table.initiatingHumanSubjectId})) between 1 and 1024`,
    ),
    reason: check(
      "company_profile_agent_proposals_reason_check",
      sql`char_length(btrim(${table.reason})) between 1 and 4096
        and octet_length(convert_to(btrim(${table.reason}), 'UTF8')) <= 16384`,
    ),
    policyMode: check(
      "company_profile_agent_proposals_policy_mode_check",
      sql`${table.policyMode} in ('suggest', 'automatic')`,
    ),
    humanInputShape: check(
      "company_profile_agent_proposals_human_input_check",
      sql`jsonb_typeof(${table.humanInput}) = 'object'
        and jsonb_array_length(${table.humanInput}->'questions') = 1
        and ${table.humanInput}->>'allowSkip' = 'false'
        and octet_length(${table.humanInput}::text) <= 49152`,
    ),
  }),
);

export const companyProfileAgentConfirmationReceipts = pgTable(
  "company_profile_agent_confirmation_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    confirmationAttemptId: uuid("confirmation_attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    proposalReceiptId: uuid("proposal_receipt_id").notNull(),
    proposalRevisionId: uuid("proposal_revision_id").notNull(),
    humanInputRequestId: uuid("human_input_request_id").notNull(),
    approverSubjectId: text("approver_subject_id").notNull(),
    approverMembershipId: uuid("approver_membership_id").notNull(),
    activationEventId: uuid("activation_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountOperation: uniqueIndex("company_profile_agent_confirmations_account_operation_uq").on(
      table.accountId,
      table.operationId,
    ),
    proposal: uniqueIndex("company_profile_agent_confirmations_proposal_uq").on(
      table.accountId,
      table.proposalReceiptId,
    ),
    activationEvent: uniqueIndex("company_profile_agent_confirmations_event_uq").on(
      table.accountId,
      table.activationEventId,
    ),
    hash: check(
      "company_profile_agent_confirmations_input_hash_check",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
    generation: check(
      "company_profile_agent_confirmations_generation_check",
      sql`${table.executionGeneration} > 0`,
    ),
    subject: check(
      "company_profile_agent_confirmations_subject_check",
      sql`octet_length(btrim(${table.approverSubjectId})) between 1 and 1024`,
    ),
  }),
);

export const companyProfileAgentAutomaticActivationReceipts = pgTable(
  "company_profile_agent_automatic_activation_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    activationAttemptId: uuid("activation_attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    proposalReceiptId: uuid("proposal_receipt_id").notNull(),
    proposalRevisionId: uuid("proposal_revision_id").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id").notNull(),
    initiatingMembershipId: uuid("initiating_membership_id").notNull(),
    policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
    activationEventId: uuid("activation_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountOperation: uniqueIndex(
      "company_profile_agent_automatic_activations_account_operation_uq",
    ).on(table.accountId, table.operationId),
    proposal: uniqueIndex("company_profile_agent_automatic_activations_proposal_uq").on(
      table.accountId,
      table.proposalReceiptId,
    ),
    activationEvent: uniqueIndex("company_profile_agent_automatic_activations_event_uq").on(
      table.accountId,
      table.activationEventId,
    ),
    turn: index("company_profile_agent_automatic_activations_turn_idx").on(
      table.workspaceId,
      table.sessionId,
      table.turnId,
      table.executionGeneration,
    ),
    hash: check(
      "company_profile_agent_automatic_activations_input_hash_check",
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
    generation: check(
      "company_profile_agent_automatic_activations_generation_check",
      sql`${table.executionGeneration} > 0 and ${table.policyVersion} >= 0`,
    ),
    subject: check(
      "company_profile_agent_automatic_activations_subject_check",
      sql`octet_length(btrim(${table.initiatingHumanSubjectId})) between 1 and 1024`,
    ),
  }),
);
