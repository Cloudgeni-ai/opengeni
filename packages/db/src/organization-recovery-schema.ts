import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const organizationRecoveryPolicies = pgTable(
  "organization_recovery_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    configuredByMembershipId: uuid("configured_by_membership_id").notNull(),
    configuredByIdentityId: uuid("configured_by_identity_id").notNull(),
    configuredAt: timestamp("configured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idAccount: unique("organization_recovery_policies_id_account_unique").on(
      table.id,
      table.accountId,
    ),
    accountRevision: unique("organization_recovery_policies_account_revision_unique").on(
      table.accountId,
      table.revision,
    ),
  }),
);

export const organizationRecoveryPolicyHeads = pgTable("organization_recovery_policy_heads", {
  accountId: uuid("account_id").primaryKey(),
  currentPolicyId: uuid("current_policy_id").notNull().unique(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationRecoveryCustodians = pgTable(
  "organization_recovery_custodians",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    membershipId: uuid("membership_id").notNull(),
    canonicalIdentityId: uuid("canonical_identity_id").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    policyOrdinal: unique("organization_recovery_custodians_policy_ordinal_unique").on(
      table.policyId,
      table.ordinal,
    ),
    policyMembership: unique("organization_recovery_custodians_policy_membership_unique").on(
      table.policyId,
      table.membershipId,
    ),
    policyIdentity: unique("organization_recovery_custodians_policy_identity_unique").on(
      table.policyId,
      table.canonicalIdentityId,
    ),
    accountPolicy: index("organization_recovery_custodians_account_policy_idx").on(
      table.accountId,
      table.policyId,
      table.ordinal,
    ),
  }),
);

export const organizationRecoveryCustodianAcceptances = pgTable(
  "organization_recovery_custodian_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    custodianId: uuid("custodian_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    canonicalIdentityId: uuid("canonical_identity_id").notNull(),
    authUserId: text("auth_user_id").notNull(),
    loginBindingId: uuid("login_binding_id").notNull(),
    membershipAuthorizationRevision: bigint("membership_authorization_revision", {
      mode: "number",
    }).notNull(),
    identityRevision: bigint("identity_revision", { mode: "number" }).notNull(),
    authRevision: bigint("auth_revision", { mode: "number" }).notNull(),
    subjectRevision: bigint("subject_revision", { mode: "number" }).notNull(),
    loginBindingRevision: bigint("login_binding_revision", { mode: "number" }).notNull(),
    reauthOperationId: uuid("reauth_operation_id").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    current: index("organization_recovery_acceptances_current_idx").on(
      table.policyId,
      table.canonicalIdentityId,
      table.acceptedAt,
      table.id,
    ),
  }),
);

export const organizationRecoveryOperations = pgTable(
  "organization_recovery_operations",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    policyRevision: bigint("policy_revision", { mode: "number" }).notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    state: text("state").notNull().default("collecting"),
    targetMembershipId: uuid("target_membership_id").notNull(),
    targetIdentityId: uuid("target_identity_id").notNull(),
    targetAuthUserId: text("target_auth_user_id").notNull(),
    targetMembershipAuthorizationRevision: bigint("target_membership_authorization_revision", {
      mode: "number",
    }).notNull(),
    targetIdentityRevision: bigint("target_identity_revision", { mode: "number" }).notNull(),
    targetAuthRevision: bigint("target_auth_revision", { mode: "number" }).notNull(),
    targetSubjectRevision: bigint("target_subject_revision", { mode: "number" }).notNull(),
    startedByCustodianId: uuid("started_by_custodian_id").notNull(),
    startedByIdentityId: uuid("started_by_identity_id").notNull(),
    quorumAt: timestamp("quorum_at", { withTimezone: true }),
    executableAt: timestamp("executable_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    notificationBatchId: uuid("notification_batch_id"),
    notificationCount: integer("notification_count"),
    notificationDigest: text("notification_digest"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneLive: uniqueIndex("organization_recovery_operations_one_live_idx")
      .on(table.accountId)
      .where(sql`${table.state} in ('collecting', 'cooling')`),
    accountCreated: index("organization_recovery_operations_account_created_idx").on(
      table.accountId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const organizationRecoveryApprovals = pgTable(
  "organization_recovery_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    operationRevision: bigint("operation_revision", { mode: "number" }).notNull(),
    policyId: uuid("policy_id").notNull(),
    custodianId: uuid("custodian_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    canonicalIdentityId: uuid("canonical_identity_id").notNull(),
    authUserId: text("auth_user_id").notNull(),
    loginBindingId: uuid("login_binding_id").notNull(),
    membershipAuthorizationRevision: bigint("membership_authorization_revision", {
      mode: "number",
    }).notNull(),
    identityRevision: bigint("identity_revision", { mode: "number" }).notNull(),
    authRevision: bigint("auth_revision", { mode: "number" }).notNull(),
    subjectRevision: bigint("subject_revision", { mode: "number" }).notNull(),
    loginBindingRevision: bigint("login_binding_revision", { mode: "number" }).notNull(),
    custodianAcceptanceId: uuid("custodian_acceptance_id").notNull(),
    reauthOperationId: uuid("reauth_operation_id").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    current: index("organization_recovery_approvals_current_idx").on(
      table.operationId,
      table.canonicalIdentityId,
      table.approvedAt,
      table.id,
    ),
  }),
);

export const organizationRecoveryCommandReceipts = pgTable(
  "organization_recovery_command_receipts",
  {
    accountId: uuid("account_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    action: text("action").notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    actorIdentityId: uuid("actor_identity_id").notNull(),
    inputHash: text("input_hash").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.accountId, table.operationId] }),
  }),
);

export const organizationRecoveryEvents = pgTable(
  "organization_recovery_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    policyId: uuid("policy_id"),
    operationId: uuid("operation_id"),
    commandOperationId: uuid("command_operation_id"),
    eventType: text("event_type").notNull(),
    actorMembershipId: uuid("actor_membership_id"),
    actorIdentityId: uuid("actor_identity_id"),
    eventRevision: bigint("event_revision", { mode: "number" }).notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    commandType: uniqueIndex("organization_recovery_events_command_type_unique")
      .on(table.accountId, table.commandOperationId, table.eventType)
      .where(sql`${table.commandOperationId} is not null`),
  }),
);

export const organizationRecoveryNotificationOutbox = pgTable(
  "organization_recovery_notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    recipientMembershipId: uuid("recipient_membership_id").notNull(),
    recipientIdentityId: uuid("recipient_identity_id").notNull(),
    audience: text("audience").notNull(),
    notificationType: text("notification_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    payloadDigest: text("payload_digest").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    batch: index("organization_recovery_outbox_batch_idx").on(
      table.operationId,
      table.batchId,
      table.id,
    ),
  }),
);

export const organizationRecoveryNotificationAttempts = pgTable(
  "organization_recovery_notification_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outboxId: uuid("outbox_id").notNull(),
    deliveryId: uuid("delivery_id").notNull(),
    provider: text("provider").notNull(),
    claimOwner: text("claim_owner").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    phase: text("phase").notNull(),
    providerMessageId: text("provider_message_id"),
    errorClass: text("error_class"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliveryPhase: unique("organization_recovery_attempts_delivery_phase_unique").on(
      table.outboxId,
      table.deliveryId,
      table.phase,
    ),
  }),
);
