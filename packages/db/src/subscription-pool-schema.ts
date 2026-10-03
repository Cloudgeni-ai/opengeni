import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type * as Schema from "./schema";

/** The same account, lease, pin and wait storage contract for subscription providers. */
export function createSubscriptionPoolTables<Provider extends "xai" | "claude">(
  provider: Provider,
  parents: { managedAccounts: typeof Schema.managedAccounts; workspaces: typeof Schema.workspaces },
) {
  const { managedAccounts, workspaces } = parents;
  const name = <Name extends string>(value: Name) =>
    `${provider}_${value}` as `${Provider}_${Name}`;
  const authorityKind = { xai: sql`'xai_subscription'`, claude: sql`'claude_subscription'` }[
    provider
  ];
  const credentials = pgTable(
    name("subscription_credentials"),
    {
      allowedModelIds: text("allowed_model_ids").array(),
      allowedWorkspaceIds: uuid("allowed_workspace_ids").array(),
      allowPersonalWorkspaces: boolean("allow_personal_workspaces").notNull().default(true),
      accessPolicyVersion: integer("access_policy_version").notNull().default(1),
      accessPolicyUpdatedBy: text("access_policy_updated_by"),
      accessPolicyUpdatedAt: timestamp("access_policy_updated_at", { withTimezone: true }),
      id: uuid("id").primaryKey().defaultRandom(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => managedAccounts.id, { onDelete: "cascade" }),
      workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
      credentialEncrypted: text("credential_encrypted").notNull(),
      providerAccountId: text("provider_account_id"),
      label: text("label"),
      accountEmail: text("account_email"),
      planType: text("plan_type"),
      status: text("status").notNull().default("active"),
      expiresAt: timestamp("expires_at", { withTimezone: true }),
      lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
      lastError: text("last_error"),
      version: integer("version").notNull().default(1),
      allocatorEnabled: boolean("allocator_enabled").notNull().default(true),
      allocatorVersion: integer("allocator_version").notNull().default(1),
      allocatorUpdatedAt: timestamp("allocator_updated_at", {
        withTimezone: true,
      }),
      quotaUsedPercent: integer("quota_used_percent"),
      quotaResetAt: timestamp("quota_reset_at", { withTimezone: true }),
      quotaCheckedAt: timestamp("quota_checked_at", { withTimezone: true }),
      exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }),
      selectionCount: integer("selection_count").notNull().default(0),
      lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
      authorityScope: text("authority_scope").notNull().default("workspace"),
      ownerOrganizationMembershipId: uuid("owner_organization_membership_id"),
      organizationUserResourceAuthorityId: uuid("organization_user_resource_authority_id"),
      organizationUserResourceKind: text("organization_user_resource_kind"),
      organizationUserResourceAuthorityGeneration: bigint(
        "organization_user_resource_authority_generation",
        { mode: "number" },
      ),
      // Connection attribution only. Ownership/execution authority comes from
      // the explicit authority tuple above and the frozen acceptance snapshot.
      connectedBySubjectId: text("connected_by_subject_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      accountIdentity: uniqueIndex(name("subscription_credentials_account_identity_uq")).on(
        table.accountId,
        table.id,
      ),
      scopeWorkspaceShape: check(
        name("credential_scope_workspace_shape"),
        sql`(${table.authorityScope} = 'organization') = (${table.workspaceId} is null)`,
      ),
      workspaceIdentity: uniqueIndex(name("subscription_credentials_workspace_id_uq")).on(
        table.workspaceId,
        table.id,
      ),
      workspaceAccountIdentity: uniqueIndex(
        name("subscription_credentials_workspace_account_id_uq"),
      ).on(table.workspaceId, table.accountId, table.id),
      providerIdentity: uniqueIndex(name("subscription_credentials_provider_identity_uq"))
        .on(
          table.accountId,
          table.workspaceId,
          table.authorityScope,
          table.ownerOrganizationMembershipId,
          table.providerAccountId,
        )
        .where(sql`${table.providerAccountId} is not null`),
      workspaceStatus: index(name("subscription_credentials_workspace_status_idx")).on(
        table.workspaceId,
        table.status,
        table.allocatorEnabled,
      ),
      scopeValid: check(
        name("subscription_credentials_authority_scope_chk"),
        sql`${table.authorityScope} in ('workspace', 'user', 'organization')`,
      ),
      authorityShapeValid: check(
        name("subscription_credentials_authority_shape_chk"),
        sql`(
          ${table.authorityScope} in ('workspace', 'organization')
          and ${table.ownerOrganizationMembershipId} is null
          and ${table.organizationUserResourceAuthorityId} is null
          and ${table.organizationUserResourceKind} is null
          and ${table.organizationUserResourceAuthorityGeneration} is null
        ) or (
          ${table.authorityScope} = 'user'
          and ${table.ownerOrganizationMembershipId} is not null
          and ${table.organizationUserResourceAuthorityId} is not null
          and ${table.organizationUserResourceKind} = ${authorityKind}
          and ${table.organizationUserResourceAuthorityGeneration} > 0
        )`,
      ),
      statusValid: check(
        name("subscription_credentials_status_chk"),
        sql`${table.status} in ('active', 'needs_relogin', 'error', 'disabled')`,
      ),
      versionValid: check(
        name("subscription_credentials_version_chk"),
        sql`${table.version} > 0 and ${table.allocatorVersion} > 0`,
      ),
      quotaValid: check(
        name("subscription_credentials_quota_chk"),
        sql`${table.quotaUsedPercent} is null or ${table.quotaUsedPercent} between 0 and 100`,
      ),
    }),
  );

  const rotationSettings = pgTable(
    name("rotation_settings"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => managedAccounts.id, { onDelete: "cascade" }),
      workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
      authorityScope: text("authority_scope").notNull().default("workspace"),
      ownerOrganizationMembershipId: uuid("owner_organization_membership_id"),
      activeCredentialId: uuid("active_credential_id"),
      rotationEnabled: boolean("rotation_enabled").notNull().default(true),
      fairnessCursor: bigint("fairness_cursor", { mode: "number" }).notNull().default(0),
      version: integer("version").notNull().default(1),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      scopeWorkspaceShape: check(
        name("rotation_scope_workspace_shape"),
        sql`(${table.authorityScope} = 'organization') = (${table.workspaceId} is null)`,
      ),
      workspacePool: uniqueIndex(name("rotation_settings_workspace_pool_uq")).on(
        table.accountId,
        table.workspaceId,
        table.authorityScope,
        table.ownerOrganizationMembershipId,
      ),
      scopeValid: check(
        name("rotation_settings_authority_scope_chk"),
        sql`(${table.authorityScope} in ('workspace', 'organization') and ${table.ownerOrganizationMembershipId} is null)
        or (${table.authorityScope} = 'user' and ${table.ownerOrganizationMembershipId} is not null)`,
      ),
      countersValid: check(
        name("rotation_settings_counters_chk"),
        sql`${table.fairnessCursor} >= 0 and ${table.version} > 0`,
      ),
    }),
  );

  const credentialLeases = pgTable(
    name("credential_leases"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => managedAccounts.id, { onDelete: "cascade" }),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      authorityScope: text("authority_scope").notNull(),
      ownerOrganizationMembershipId: uuid("owner_organization_membership_id"),
      credentialId: uuid("credential_id").notNull(),
      turnId: uuid("turn_id").notNull(),
      holderId: text("holder_id").notNull(),
      generation: integer("generation").notNull().default(1),
      leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      workspaceTurn: uniqueIndex(name("credential_leases_workspace_turn_uq")).on(
        table.workspaceId,
        table.turnId,
      ),
      activeCredential: index(name("credential_leases_active_credential_idx")).on(
        table.workspaceId,
        table.credentialId,
        table.leasedUntil,
      ),
      expiry: index(name("credential_leases_expiry_idx")).on(table.leasedUntil),
      scopeValid: check(
        name("credential_leases_authority_scope_chk"),
        sql`(${table.authorityScope} in ('workspace', 'organization') and ${table.ownerOrganizationMembershipId} is null)
        or (${table.authorityScope} = 'user' and ${table.ownerOrganizationMembershipId} is not null)`,
      ),
      generationValid: check(
        name("credential_leases_generation_chk"),
        sql`${table.generation} > 0`,
      ),
    }),
  );

  const sessionAccountPins = pgTable(
    name("session_account_pins"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => managedAccounts.id, { onDelete: "cascade" }),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      sessionId: uuid("session_id").notNull(),
      authorityScope: text("authority_scope").notNull().default("workspace"),
      ownerOrganizationMembershipId: uuid("owner_organization_membership_id"),
      pinnedCredentialId: uuid("pinned_credential_id"),
      pinSource: text("pin_source"),
      lastCredentialId: uuid("last_credential_id"),
      version: integer("version").notNull().default(1),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      // Migration 0231 adds NULLS NOT DISTINCT so workspace scope is also a
      // singleton; Drizzle 0.45 cannot encode that PostgreSQL index modifier.
      workspaceSessionPool: uniqueIndex(name("session_account_pins_workspace_session_uq")).on(
        table.workspaceId,
        table.sessionId,
        table.authorityScope,
        table.ownerOrganizationMembershipId,
      ),
      scopeValid: check(
        name("session_account_pins_authority_scope_chk"),
        sql`(${table.authorityScope} in ('workspace', 'organization') and ${table.ownerOrganizationMembershipId} is null)
        or (${table.authorityScope} = 'user' and ${table.ownerOrganizationMembershipId} is not null)`,
      ),
      pinValid: check(
        name("session_account_pins_pin_chk"),
        sql`(${table.pinnedCredentialId} is null and ${table.pinSource} is null)
        or (${table.pinnedCredentialId} is not null and ${table.pinSource} in ('manual', 'policy'))`,
      ),
      versionValid: check(name("session_account_pins_version_chk"), sql`${table.version} > 0`),
    }),
  );

  const capacityWaiters = pgTable(
    name("capacity_waiters"),
    {
      id: uuid("id").primaryKey().defaultRandom(),
      accountId: uuid("account_id")
        .notNull()
        .references(() => managedAccounts.id, { onDelete: "cascade" }),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      sessionId: uuid("session_id").notNull(),
      goalId: uuid("goal_id"),
      goalVersion: integer("goal_version"),
      blockedTurnId: uuid("blocked_turn_id").notNull(),
      blockedTurnGeneration: integer("blocked_turn_generation").notNull(),
      workflowId: text("workflow_id").notNull(),
      authorityScope: text("authority_scope").notNull(),
      ownerOrganizationMembershipId: uuid("owner_organization_membership_id"),
      status: text("status").notNull().default("waiting"),
      generation: integer("generation").notNull().default(1),
      earliestResetAt: timestamp("earliest_reset_at", { withTimezone: true }),
      nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
      wakeRevision: integer("wake_revision").notNull().default(1),
      observedWakeRevision: integer("observed_wake_revision").notNull().default(0),
      lastWakeReason: text("last_wake_reason").notNull().default("capacity_wait_armed"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      // Migration 0234 uses NULLS NOT DISTINCT so workspace scope is also a
      // singleton; Drizzle 0.45 cannot encode that PostgreSQL index modifier.
      workspaceSessionPool: uniqueIndex(name("capacity_waiters_workspace_session_uq")).on(
        table.workspaceId,
        table.sessionId,
        table.authorityScope,
        table.ownerOrganizationMembershipId,
      ),
      pending: index(name("capacity_waiters_pending_idx")).on(
        table.workspaceId,
        table.status,
        table.nextCheckAt,
      ),
      wakeRepair: index(name("capacity_waiters_wake_repair_idx")).on(
        table.status,
        table.wakeRevision,
        table.observedWakeRevision,
      ),
      scopeValid: check(
        name("capacity_waiters_authority_scope_chk"),
        sql`(${table.authorityScope} in ('workspace', 'organization') and ${table.ownerOrganizationMembershipId} is null)
        or (${table.authorityScope} = 'user' and ${table.ownerOrganizationMembershipId} is not null)`,
      ),
      statusValid: check(
        name("capacity_waiters_status_chk"),
        sql`${table.status} in ('waiting', 'resumed', 'superseded')`,
      ),
      countersValid: check(
        name("capacity_waiters_counters_chk"),
        sql`${table.blockedTurnGeneration} >= 0
        and ${table.generation} > 0
        and ${table.wakeRevision} > 0
        and ${table.observedWakeRevision} >= 0
        and ${table.observedWakeRevision} <= ${table.wakeRevision}`,
      ),
      goalFenceValid: check(
        name("capacity_waiters_goal_fence_chk"),
        sql`(${table.goalId} is null and ${table.goalVersion} is null)
        or (${table.goalId} is not null and ${table.goalVersion} > 0)`,
      ),
    }),
  );
  return { credentials, rotationSettings, credentialLeases, sessionAccountPins, capacityWaiters };
}

export type SubscriptionPoolTables = ReturnType<typeof createSubscriptionPoolTables>;
