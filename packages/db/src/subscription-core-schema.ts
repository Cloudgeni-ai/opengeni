import { sql } from "drizzle-orm";
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

/** M2 storage declarations. Runtime consumers remain on the legacy adapters. */
export const subscriptionConnections = pgTable(
  "subscription_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    providerAccountId: text("provider_account_id"),
    accountEmail: text("account_email"),
    label: text("label"),
    planType: text("plan_type"),
    credentialEncrypted: text("credential_encrypted").notNull(),
    credentialFormat: text("credential_format").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    refreshGeneration: bigint("refresh_generation", { mode: "number" }).notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    lastError: text("last_error"),
    allocatorEnabled: boolean("allocator_enabled").notNull(),
    allocatorVersion: integer("allocator_version").notNull(),
    excludedModels: text("excluded_models").array().notNull(),
    allowedModelIds: text("allowed_model_ids").array(),
    ownership: text("ownership").notNull(),
    ownerOrganizationMembershipId: uuid("owner_organization_membership_id"),
    ownerSubjectId: text("owner_subject_id"),
    authorityId: uuid("authority_id"),
    authorityResourceKind: text("authority_resource_kind"),
    authorityGeneration: bigint("authority_generation", { mode: "number" }),
    connectedBySubjectId: text("connected_by_subject_id"),
    scopeKind: text("scope_kind").notNull(),
    allowPersonalWorkspaces: boolean("allow_personal_workspaces").notNull(),
    managedByWorkspaceId: uuid("managed_by_workspace_id"),
    providerState: jsonb("provider_state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    providerOwnerAccount: uniqueIndex("subscription_connections_provider_owner_account_uq").on(
      table.accountId,
      table.provider,
      table.providerAccountId,
      sql`coalesce(${table.ownerOrganizationMembershipId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    placement: index("subscription_connections_placement_idx").on(
      table.accountId,
      table.provider,
      table.status,
      table.allocatorEnabled,
      table.ownership,
      table.scopeKind,
    ),
    providerValid: check(
      "subscription_connections_provider_chk",
      sql`${table.provider} in ('codex', 'claude', 'xai')`,
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
    assignment: uniqueIndex("subscription_connection_workspaces_pk").on(
      table.connectionId,
      table.workspaceId,
    ),
    placement: index("subscription_connection_workspaces_placement_idx").on(
      table.accountId,
      table.workspaceId,
      table.connectionId,
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
    assignment: uniqueIndex("subscription_connection_people_pk").on(
      table.connectionId,
      table.organizationMembershipId,
    ),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    alias: uniqueIndex("subscription_connection_aliases_pk").on(
      table.accountId,
      table.provider,
      table.aliasConnectionId,
    ),
  }),
);

export const subscriptionConnectionQuota = pgTable("subscription_connection_quota", {
  accountId: uuid("account_id").notNull(),
  connectionId: uuid("connection_id").primaryKey(),
  quota: jsonb("quota").notNull(),
  selectionCount: bigint("selection_count", { mode: "number" }).notNull(),
  lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
  observedRefreshGeneration: bigint("observed_refresh_generation", { mode: "number" }),
  revision: bigint("revision", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
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
    lockedSettings: text("locked_settings").array().notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    updatedBySubjectId: text("updated_by_subject_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    workspace: index("subscription_settings_workspace_idx").on(table.accountId, table.workspaceId),
  }),
);

export const subscriptionPersonPreferences = pgTable("subscription_person_preferences", {
  accountId: uuid("account_id").notNull(),
  organizationMembershipId: uuid("organization_membership_id").notNull(),
  personalFallbackOptIn: boolean("personal_fallback_opt_in").notNull(),
  version: bigint("version", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const subscriptionSessionBindings = pgTable(
  "subscription_session_bindings",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    provider: text("provider").notNull(),
    connectionId: uuid("connection_id"),
    modelId: text("model_id").notNull(),
    choice: text("choice").notNull(),
    onlyThisModel: boolean("only_this_model").notNull(),
    lastModelCallAt: timestamp("last_model_call_at", { withTimezone: true }),
    lastSwitchReason: text("last_switch_reason"),
    version: bigint("version", { mode: "number" }).notNull(),
  },
  (table) => ({
    placement: index("subscription_session_bindings_connection_idx").on(
      table.accountId,
      table.provider,
      table.connectionId,
    ),
  }),
);

export const subscriptionLeases = pgTable("subscription_leases", {
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  turnId: uuid("turn_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  provider: text("provider").notNull(),
  holderId: text("holder_id").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull(),
  leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
});

export const subscriptionCapacityWaiters = pgTable(
  "subscription_capacity_waiters",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    provider: text("provider").notNull(),
    waitReason: text("wait_reason").notNull(),
    policyHash: text("policy_hash"),
    resetKind: text("reset_kind"),
    refreshAttempt: integer("refresh_attempt").notNull(),
    resumedUpdateId: uuid("resumed_update_id"),
    earliestResetAt: timestamp("earliest_reset_at", { withTimezone: true }),
    generation: bigint("generation", { mode: "number" }).notNull(),
    wakeRevision: bigint("wake_revision", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    recovery: index("subscription_capacity_waiters_recovery_idx").on(
      table.provider,
      table.earliestResetAt,
      table.wakeRevision,
    ),
  }),
);

export const subscriptionTurnFailures = pgTable("subscription_turn_failures", {
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  turnId: uuid("turn_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  provider: text("provider").notNull(),
  failureKind: text("failure_kind").notNull(),
  recoveryEvidence: jsonb("recovery_evidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const subscriptionAppsDesignations = pgTable("subscription_apps_designations", {
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  version: bigint("version", { mode: "number" }).notNull(),
  updatedBySubjectId: text("updated_by_subject_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const subscriptionProviderCutovers = pgTable("subscription_provider_cutovers", {
  accountId: uuid("account_id").notNull(),
  provider: text("provider").notNull(),
  enabled: boolean("enabled").notNull(),
  version: bigint("version", { mode: "number" }).notNull(),
  updatedBySubjectId: text("updated_by_subject_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
