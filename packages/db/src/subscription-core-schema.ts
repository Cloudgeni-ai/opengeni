import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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

/** M2 storage declarations. Runtime consumers remain on the legacy adapters. */
export const subscriptionConnections = pgTable(
  "subscription_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull().default("subscription"),
    providerAccountId: text("provider_account_id"),
    accountEmail: text("account_email"),
    label: text("label"),
    planType: text("plan_type"),
    credentialEncrypted: text("credential_encrypted").notNull(),
    credentialFormat: text("credential_format").notNull().default("v1"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    refreshGeneration: bigint("refresh_generation", { mode: "number" }).notNull().default(1),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"),
    /** Irreversible local secret removal; retained rows are nonsecret history. */
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** When a time-bound health quarantine (status error) ends. */
    healthRetryAt: timestamp("health_retry_at", { withTimezone: true }),
    extraCreditsEnabled: boolean("extra_credits_enabled").notNull().default(false),
    extraCreditsVersion: integer("extra_credits_version").notNull().default(1),
    extraCreditsUpdatedBySubjectId: text("extra_credits_updated_by_subject_id"),
    extraCreditsUpdatedAt: timestamp("extra_credits_updated_at", { withTimezone: true }),
    allocatorEnabled: boolean("allocator_enabled").notNull().default(true),
    allocatorVersion: integer("allocator_version").notNull().default(1),
    excludedModels: text("excluded_models").array().notNull().default([]),
    allowedModelIds: text("allowed_model_ids").array(),
    ownership: text("ownership").notNull().default("shared"),
    ownerOrganizationMembershipId: uuid("owner_organization_membership_id"),
    ownerSubjectId: text("owner_subject_id"),
    authorityId: uuid("authority_id"),
    authorityResourceKind: text("authority_resource_kind"),
    authorityGeneration: bigint("authority_generation", { mode: "number" }),
    connectedBySubjectId: text("connected_by_subject_id"),
    scopeKind: text("scope_kind").notNull().default("workspaces"),
    allowPersonalWorkspaces: boolean("allow_personal_workspaces").notNull().default(true),
    managedByWorkspaceId: uuid("managed_by_workspace_id"),
    providerState: jsonb("provider_state").notNull().default({}),
    /** The signed-in person within the upstream account (M3 PR 3b, 0688). */
    providerSubjectId: text("provider_subject_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerOwnerAccount: uniqueIndex("subscription_connections_provider_owner_account_uq")
      .on(
        table.accountId,
        table.provider,
        table.providerAccountId,
        sql`coalesce(${table.providerSubjectId}, '')`,
        sql`coalesce(${table.ownerOrganizationMembershipId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${table.providerAccountId} is not null`),
    accountIdentity: uniqueIndex("subscription_connections_account_id_uq").on(
      table.accountId,
      table.id,
    ),
    providerIdentity: uniqueIndex("subscription_connections_account_provider_id_uq").on(
      table.accountId,
      table.provider,
      table.id,
    ),
    placement: index("subscription_connections_placement_idx").on(
      table.accountId,
      table.provider,
      table.status,
      table.allocatorEnabled,
      table.ownership,
      table.scopeKind,
    ),
    manager: index("subscription_connections_manager_idx")
      .on(table.accountId, table.managedByWorkspaceId)
      .where(sql`${table.managedByWorkspaceId} is not null`),
    providerValid: check(
      "subscription_connections_provider_chk",
      sql`${table.provider} in ('codex', 'claude', 'xai')`,
    ),
    disconnectedSecret: check(
      "subscription_disconnected_secret_chk",
      sql`${table.disconnectedAt} is null or (${table.status} = 'disabled'
        and ${table.credentialEncrypted} = '' and ${table.providerAccountId} is null
        and not ${table.allocatorEnabled})`,
    ),
  }),
);

export const subscriptionConnectionWorkspaces = pgTable(
  "subscription_connection_workspaces",
  {
    accountId: uuid("account_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (table) => ({
    assignment: primaryKey({
      name: "subscription_connection_workspaces_pk",
      columns: [table.connectionId, table.workspaceId],
    }),
    placement: index("subscription_connection_workspaces_placement_idx").on(
      table.accountId,
      table.workspaceId,
      table.connectionId,
    ),
  }),
);

export const subscriptionConnectionAssignmentPolicies = pgTable(
  "subscription_connection_assignment_policies",
  {
    accountId: uuid("account_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    inferencePool: text("inference_pool").notNull(),
    allocatorEnabled: boolean("allocator_enabled").notNull().default(true),
    allowedModelIds: text("allowed_model_ids").array(),
    excludedModels: text("excluded_models").array().notNull().default([]),
    managedByWorkspaceId: uuid("managed_by_workspace_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({
      name: "subscription_connection_assignment_policies_pk",
      columns: [table.accountId, table.connectionId, table.workspaceId, table.inferencePool],
    }),
    pool: index("subscription_connection_assignment_policies_pool_idx").on(
      table.accountId,
      table.workspaceId,
      table.inferencePool,
      table.connectionId,
    ),
    manager: index("subscription_connection_assignment_policies_manager_idx")
      .on(table.accountId, table.managedByWorkspaceId)
      .where(sql`${table.managedByWorkspaceId} is not null`),
    inferencePoolValid: check(
      "subscription_connection_assignment_policies_pool_chk",
      sql`${table.inferencePool} in ('workspace', 'organization')`,
    ),
  }),
);

export const subscriptionConnectionPeople = pgTable(
  "subscription_connection_people",
  {
    accountId: uuid("account_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    organizationMembershipId: uuid("organization_membership_id").notNull(),
  },
  (table) => ({
    assignment: primaryKey({
      name: "subscription_connection_people_pk",
      columns: [table.connectionId, table.organizationMembershipId],
    }),
    placement: index("subscription_connection_people_placement_idx").on(
      table.accountId,
      table.organizationMembershipId,
      table.connectionId,
    ),
  }),
);

export const subscriptionConnectionAliases = pgTable(
  "subscription_connection_aliases",
  {
    accountId: uuid("account_id").notNull(),
    provider: text("provider").notNull(),
    aliasConnectionId: uuid("alias_connection_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    alias: primaryKey({
      name: "subscription_connection_aliases_pk",
      columns: [table.accountId, table.provider, table.aliasConnectionId],
    }),
  }),
);

export const subscriptionConnectionQuota = pgTable("subscription_connection_quota", {
  accountId: uuid("account_id").notNull(),
  connectionId: uuid("connection_id").primaryKey(),
  quota: jsonb("quota").notNull().default({ windows: [], modelCooldowns: {} }),
  selectionCount: bigint("selection_count", { mode: "number" }).notNull().default(0),
  lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
  observedRefreshGeneration: bigint("observed_refresh_generation", { mode: "number" }),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptionSettings = pgTable(
  "subscription_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id"),
    codexPrimaryConnectionId: uuid("codex_primary_connection_id"),
    claudePrimaryConnectionId: uuid("claude_primary_connection_id"),
    xaiPrimaryConnectionId: uuid("xai_primary_connection_id"),
    rotation: jsonb("rotation"),
    providers: jsonb("providers"),
    crossProviderFailover: boolean("cross_provider_failover"),
    fallbackOrder: jsonb("fallback_order"),
    personalConnectionsAllowed: boolean("personal_connections_allowed"),
    personalFallbackAllowed: boolean("personal_fallback_allowed"),
    lockedSettings: text("locked_settings").array().notNull().default([]),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedBySubjectId: text("updated_by_subject_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: unique("subscription_settings_account_workspace_uq")
      .on(table.accountId, table.workspaceId)
      .nullsNotDistinct(),
    workspace: index("subscription_settings_workspace_idx")
      .on(table.accountId, table.workspaceId)
      .where(sql`${table.workspaceId} is not null`),
  }),
);

export const subscriptionPersonPreferences = pgTable(
  "subscription_person_preferences",
  {
    accountId: uuid("account_id").notNull(),
    organizationMembershipId: uuid("organization_membership_id").notNull(),
    personalFallbackOptIn: boolean("personal_fallback_opt_in").notNull().default(false),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.accountId, table.organizationMembershipId] }),
  }),
);

export const subscriptionSessionBindings = pgTable(
  "subscription_session_bindings",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    provider: text("provider").notNull(),
    connectionId: uuid("connection_id"),
    modelId: text("model_id").notNull(),
    choice: text("choice").notNull().default("automatic"),
    onlyThisModel: boolean("only_this_model").notNull().default(false),
    lastModelCallAt: timestamp("last_model_call_at", { withTimezone: true }),
    lastSwitchReason: text("last_switch_reason"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.workspaceId, table.sessionId] }),
    placement: index("subscription_session_bindings_connection_idx").on(
      table.accountId,
      table.provider,
      table.connectionId,
    ),
  }),
);

export const subscriptionLeases = pgTable(
  "subscription_leases",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    provider: text("provider").notNull(),
    holderId: text("holder_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.workspaceId, table.turnId] }),
    connectionExpiry: index("subscription_leases_connection_expiry_idx").on(
      table.accountId,
      table.connectionId,
      table.leasedUntil,
    ),
  }),
);

/** Operation leases are independent of chat-turn leases and may be sessionless. */
export const subscriptionOperationLeases = pgTable(
  "subscription_operation_leases",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    requestId: text("request_id"),
    transportAttempt: integer("transport_attempt"),
    requestReservedAt: timestamp("request_reserved_at", { withTimezone: true }),
    requestOutcome: text("request_outcome"),
    requestObservedAt: timestamp("request_observed_at", { withTimezone: true }),
    sessionId: uuid("session_id"),
    turnId: uuid("turn_id"),
    provider: text("provider").notNull(),
    connectionId: uuid("connection_id").notNull(),
    holderId: text("holder_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({
      name: "subscription_operation_leases_pk",
      columns: [table.accountId, table.operationId],
    }),
    connectionExpiry: index("subscription_operation_leases_connection_expiry_idx").on(
      table.accountId,
      table.connectionId,
      table.leasedUntil,
    ),
    session: index("subscription_operation_leases_session_idx")
      .on(table.accountId, table.workspaceId, table.sessionId, table.turnId)
      .where(sql`${table.sessionId} is not null`),
    operationKindValid: check(
      "subscription_operation_leases_kind_chk",
      sql`${table.operationKind} in ('image', 'realtime', 'transcription', 'model', 'credential_request', 'apps')`,
    ),
    requestIdentity: uniqueIndex("subscription_operation_request_identity_uq")
      .on(table.accountId, table.requestId, table.transportAttempt)
      .where(sql`${table.requestId} is not null`),
    requestShape: check(
      "subscription_operation_request_shape_chk",
      sql`(${table.requestId} is null and ${table.transportAttempt} is null
        and ${table.requestReservedAt} is null and ${table.requestOutcome} is null
        and ${table.requestObservedAt} is null)
        or (${table.requestId} is not null and ${table.transportAttempt} is not null
          and ${table.requestOutcome} is not null and length(${table.requestId}) between 1 and 512
          and ${table.transportAttempt} > 0 and ${table.requestReservedAt} is not null
          and ${table.requestOutcome} in ('reserved', 'response_received', 'refused', 'unknown'))`,
    ),
    referenceShape: check(
      "subscription_operation_leases_reference_chk",
      sql`(${table.turnId} is null or ${table.sessionId} is not null)
        and (${table.sessionId} is not null or (${table.turnId} is null and ${table.operationKind} in ('transcription', 'credential_request', 'apps')))
        and (${table.operationKind} <> 'model' or ${table.turnId} is not null)`,
    ),
  }),
);

export const subscriptionCapacityWaiters = pgTable(
  "subscription_capacity_waiters",
  {
    waiterId: uuid("waiter_id").notNull().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    provider: text("provider").notNull(),
    waitReason: text("wait_reason").notNull(),
    policyHash: text("policy_hash"),
    resetKind: text("reset_kind"),
    refreshAttempt: integer("refresh_attempt").notNull().default(0),
    resumedUpdateId: uuid("resumed_update_id"),
    earliestResetAt: timestamp("earliest_reset_at", { withTimezone: true }),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    wakeRevision: bigint("wake_revision", { mode: "number" }).notNull().default(1),
    observedWakeRevision: bigint("observed_wake_revision", { mode: "number" }).notNull().default(0),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    blockedTurnGeneration: bigint("blocked_turn_generation", { mode: "number" }),
    /** Goal fence for a waiting goal continuation; both or neither. */
    goalId: uuid("goal_id"),
    goalVersion: bigint("goal_version", { mode: "number" }),
    lastWakeReason: text("last_wake_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.workspaceId, table.sessionId] }),
    stableWaiterId: uniqueIndex("subscription_capacity_waiters_account_waiter_id_uq").on(
      table.accountId,
      table.waiterId,
    ),
    recovery: index("subscription_capacity_waiters_recovery_idx").on(
      table.provider,
      table.earliestResetAt,
      table.wakeRevision,
    ),
  }),
);

export const subscriptionCapacityWakeOutbox = pgTable(
  "subscription_capacity_wake_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    waiterId: uuid("waiter_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    wakeRevision: bigint("wake_revision", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimGeneration: bigint("claim_generation", { mode: "number" }).notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => ({
    identity: uniqueIndex("subscription_capacity_wake_outbox_identity_uq").on(
      table.accountId,
      table.waiterId,
      table.generation,
      table.wakeRevision,
    ),
    due: index("subscription_capacity_wake_outbox_due_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.deliveredAt} is null`),
  }),
);

export const subscriptionTurnFailures = pgTable(
  "subscription_turn_failures",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    provider: text("provider").notNull(),
    failureKind: text("failure_kind").notNull(),
    recoveryEvidence: jsonb("recovery_evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.workspaceId, table.turnId, table.connectionId] }),
    turn: index("subscription_turn_failures_turn_idx").on(
      table.accountId,
      table.turnId,
      table.provider,
    ),
  }),
);

export const subscriptionAppsDesignations = pgTable(
  "subscription_apps_designations",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedBySubjectId: text("updated_by_subject_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.workspaceId] }),
    connection: index("subscription_apps_designations_connection_idx").on(
      table.accountId,
      table.connectionId,
    ),
  }),
);

export const subscriptionProviderCutovers = pgTable(
  "subscription_provider_cutovers",
  {
    accountId: uuid("account_id").notNull(),
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedBySubjectId: text("updated_by_subject_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.accountId, table.provider] }),
  }),
);
