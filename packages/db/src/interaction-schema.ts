import type {
  AttachedBrowserDeviceCapabilities,
  AuthRunChoice,
  AuthRunExternalAction,
  AuthRunPendingField,
  BrowserRevisionMaterialization,
  BrowserSessionCapabilities,
  ComputerSessionCapabilities,
  InteractionPlacement,
  NetworkRouteConfiguration,
  NetworkRouteConsistency,
  SiteAuthAuthority,
  SiteAuthHealthPolicy,
  SiteAuthMethod,
} from "@opengeni/contracts";
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Foreign keys into the older workspace/session/sandbox tables live in the SQL
// migration. Keeping this schema leaf independent avoids a cycle into schema.ts.

export const interactionLifecycleValues = [
  "starting",
  "active",
  "suspending",
  "suspended",
  "restoring",
  "repair_required",
  "lost",
  "ending",
  "ended",
  "failed",
] as const;

export const interactionOperationStateValues = [
  "prepared",
  "dispatched",
  "completed",
  "failed",
  "outcome_unknown",
] as const;

export const interactionOperationKindValues = [
  "create",
  "resume",
  "suspend",
  "end",
  "publish",
] as const;

export const workspaceInteractionRevisions = pgTable(
  "workspace_interaction_revisions",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    revisionValid: check(
      "workspace_interaction_revisions_revision_check",
      sql`${table.revision} >= 0`,
    ),
  }),
);

export const browserIdentities = pgTable(
  "browser_identities",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    defaultRevisionId: uuid("default_revision_id"),
    headGeneration: bigint("head_generation", { mode: "number" }).notNull().default(0),
    revisionCount: bigint("revision_count", { mode: "number" }).notNull().default(0),
    createOperationId: uuid("create_operation_id").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("browser_identities_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    createOperation: uniqueIndex("browser_identities_workspace_create_operation_uq").on(
      table.workspaceId,
      table.createOperationId,
    ),
    activeName: uniqueIndex("browser_identities_workspace_active_name_uq")
      .on(table.workspaceId, sql`lower(${table.name})`)
      .where(sql`${table.status} = 'active'`),
    discovery: index("browser_identities_workspace_status_updated_idx").on(
      table.workspaceId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    valuesValid: check(
      "browser_identities_values_check",
      sql`octet_length(${table.name}) between 1 and 200
        and ${table.name} = btrim(${table.name})
        and octet_length(${table.createdBySubjectId}) between 1 and 1024
        and ${table.headGeneration} >= 0
        and ${table.revisionCount} >= 0
        and ${table.headGeneration} <= ${table.revisionCount}
        and (
          (${table.headGeneration} = 0 and ${table.defaultRevisionId} is null)
          or (${table.headGeneration} > 0 and ${table.defaultRevisionId} is not null)
        )`,
    ),
  }),
);

export const browserRevisions = pgTable(
  "browser_revisions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    parentRevisionId: uuid("parent_revision_id"),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    sourceBrowserSessionId: uuid("source_browser_session_id").notNull(),
    publicationOperationId: uuid("publication_operation_id").notNull(),
    expectedHeadGeneration: bigint("expected_head_generation", {
      mode: "number",
    }).notNull(),
    advanceDefaultRequested: boolean("advance_default_requested").notNull(),
    defaultAdvanced: boolean("default_advanced").notNull(),
    resultHeadGeneration: bigint("result_head_generation", {
      mode: "number",
    }).notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceRevision: uniqueIndex("browser_revisions_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    identityRevision: uniqueIndex("browser_revisions_identity_id_uq").on(
      table.identityId,
      table.id,
    ),
    workspaceIdentityRevision: uniqueIndex("browser_revisions_workspace_identity_id_uq").on(
      table.workspaceId,
      table.identityId,
      table.id,
    ),
    identityOrdinal: uniqueIndex("browser_revisions_identity_ordinal_uq").on(
      table.identityId,
      table.ordinal,
    ),
    publicationOperation: uniqueIndex("browser_revisions_workspace_publication_operation_uq").on(
      table.workspaceId,
      table.publicationOperationId,
    ),
    identityHistory: index("browser_revisions_identity_history_idx").on(
      table.workspaceId,
      table.identityId,
      table.ordinal,
    ),
    valuesValid: check(
      "browser_revisions_values_check",
      sql`${table.ordinal} > 0
        and ${table.expectedHeadGeneration} >= 0
        and ${table.resultHeadGeneration} >= 0
        and (not ${table.defaultAdvanced} or ${table.advanceDefaultRequested})
        and (
          not ${table.defaultAdvanced}
          or ${table.resultHeadGeneration} = ${table.expectedHeadGeneration} + 1
        )
        and ${table.manifestDigest} ~ '^[0-9a-f]{64}$'
        and octet_length(${table.createdBySubjectId}) between 1 and 1024
        and ${table.parentRevisionId} is distinct from ${table.id}`,
    ),
  }),
);

/** Internal encrypted object metadata. Public mappers expose only bounded
 * integrity/compatibility fields through BrowserRevisionComponent. */
export const browserStateArtifacts = pgTable(
  "browser_state_artifacts",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceBrowserSessionId: uuid("source_browser_session_id").notNull(),
    purpose: text("purpose", {
      enum: ["revision_component", "private_checkpoint"],
    }).notNull(),
    kind: text("kind", {
      enum: ["chromium_profile", "normalized_web_state", "provider_snapshot"],
    }).notNull(),
    format: text("format").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    contentDigest: text("content_digest").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    objectKey: text("object_key").notNull(),
    encryptedDataKey: text("encrypted_data_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    materialization: jsonb("materialization").$type<BrowserRevisionMaterialization>().notNull(),
    state: text("state", { enum: ["available", "delete_pending", "deleted"] })
      .notNull()
      .default("available"),
    retainedUntil: timestamp("retained_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceArtifact: uniqueIndex("browser_state_artifacts_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    objectKey: uniqueIndex("browser_state_artifacts_object_key_uq").on(table.objectKey),
    source: index("browser_state_artifacts_source_idx").on(
      table.workspaceId,
      table.sourceBrowserSessionId,
      table.createdAt,
    ),
    gc: index("browser_state_artifacts_gc_idx").on(
      table.state,
      table.retainedUntil,
      table.createdAt,
    ),
    valuesValid: check(
      "browser_state_artifacts_values_check",
      sql`octet_length(${table.format}) between 1 and 512
        and ${table.format} = btrim(${table.format})
        and ${table.artifactDigest} ~ '^[0-9a-f]{64}$'
        and ${table.contentDigest} ~ '^[0-9a-f]{64}$'
        and ${table.manifestDigest} ~ '^[0-9a-f]{64}$'
        and octet_length(${table.objectKey}) between 1 and 2048
        and ${table.objectKey} ~ ('^workspaces/' || ${table.workspaceId}::text || '/browser-state/[A-Za-z0-9._=-]+(/[A-Za-z0-9._=-]+)*$')
        and octet_length(${table.encryptedDataKey}) between 16 and 8192
        and ${table.sizeBytes} > 0
        and jsonb_typeof(${table.materialization}) = 'object'
        and octet_length(${table.materialization}::text) between 2 and 65536
        and (
          ${table.purpose} <> 'revision_component'
          or (
            ${table.state} = 'available'
            and ${table.retainedUntil} is null
            and ${table.deletedAt} is null
          )
        )`,
    ),
    lifecycleValid: check(
      "browser_state_artifacts_lifecycle_check",
      sql`(${table.state} = 'deleted' and ${table.deletedAt} is not null)
        or (${table.state} <> 'deleted' and ${table.deletedAt} is null)`,
    ),
  }),
);

export const browserRevisionComponents = pgTable(
  "browser_revision_components",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    sourceBrowserSessionId: uuid("source_browser_session_id").notNull(),
    artifactPurpose: text("artifact_purpose", { enum: ["revision_component"] })
      .notNull()
      .default("revision_component"),
    kind: text("kind", {
      enum: ["chromium_profile", "normalized_web_state", "provider_snapshot"],
    }).notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceComponent: uniqueIndex("browser_revision_components_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    revisionPosition: uniqueIndex("browser_revision_components_revision_position_uq").on(
      table.revisionId,
      table.position,
    ),
    artifact: uniqueIndex("browser_revision_components_artifact_uq").on(table.artifactId),
    revisionKind: uniqueIndex("browser_revision_components_revision_kind_uq").on(
      table.revisionId,
      table.kind,
    ),
    revision: index("browser_revision_components_revision_idx").on(
      table.workspaceId,
      table.revisionId,
      table.position,
    ),
    valuesValid: check(
      "browser_revision_components_values_check",
      sql`${table.position} between 0 and 15
        and ${table.artifactPurpose} = 'revision_component'`,
    ),
  }),
);

export const attachedBrowserDevices = pgTable(
  "attached_browser_devices",
  {
    id: uuid("id").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    enrollmentId: uuid("enrollment_id").notNull(),
    name: text("name").notNull(),
    profileLabel: text("profile_label"),
    browserName: text("browser_name").notNull(),
    browserVersion: text("browser_version").notNull(),
    extensionVersion: text("extension_version").notNull(),
    platform: text("platform", {
      enum: ["linux", "macos", "windows"],
    }).notNull(),
    architecture: text("architecture", { enum: ["x64", "arm64"] }).notNull(),
    connectionGeneration: text("connection_generation").notNull(),
    inventoryRevision: bigint("inventory_revision", {
      mode: "number",
    }).notNull(),
    tabCount: integer("tab_count").notNull(),
    capabilities: jsonb("capabilities").$type<AttachedBrowserDeviceCapabilities>().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({
      name: "attached_browser_devices_workspace_id_pk",
      columns: [table.workspaceId, table.id],
    }),
    enrollment: index("attached_browser_devices_enrollment_idx").on(
      table.workspaceId,
      table.enrollmentId,
      table.disconnectedAt,
      table.updatedAt,
    ),
    discovery: index("attached_browser_devices_discovery_idx").on(
      table.workspaceId,
      table.disconnectedAt,
      table.updatedAt,
      table.id,
    ),
    valuesValid: check(
      "attached_browser_devices_values_check",
      sql`octet_length(${table.name}) between 1 and 200
        and ${table.name} = btrim(${table.name})
        and (${table.profileLabel} is null or (
          octet_length(${table.profileLabel}) between 1 and 200
          and ${table.profileLabel} = btrim(${table.profileLabel})
        ))
        and octet_length(${table.browserName}) between 1 and 100
        and ${table.browserName} = btrim(${table.browserName})
        and octet_length(${table.browserVersion}) between 1 and 256
        and ${table.browserVersion} = btrim(${table.browserVersion})
        and octet_length(${table.extensionVersion}) between 1 and 256
        and ${table.extensionVersion} = btrim(${table.extensionVersion})
        and octet_length(${table.connectionGeneration}) between 1 and 256
        and ${table.connectionGeneration} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
        and ${table.inventoryRevision} >= 0
        and ${table.tabCount} between 0 and 100000
        and jsonb_typeof(${table.capabilities}) = 'object'
        and octet_length(${table.capabilities}::text) between 2 and 65536`,
    ),
  }),
);

/** Accepted full-snapshot cursor for one connected agent's local browser bridge.
 *  This lets heartbeat replay refresh liveness without allowing an older
 *  inventory to disconnect a newly announced profile. */
export const attachedBrowserInventories = pgTable(
  "attached_browser_inventories",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    enrollmentId: uuid("enrollment_id").notNull(),
    bridgeGeneration: text("bridge_generation").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identity: primaryKey({
      name: "attached_browser_inventories_workspace_enrollment_pk",
      columns: [table.workspaceId, table.enrollmentId],
    }),
    valuesValid: check(
      "attached_browser_inventories_values_check",
      sql`octet_length(${table.bridgeGeneration}) between 1 and 256
        and ${table.bridgeGeneration} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
        and ${table.revision} >= 0`,
    ),
  }),
);

export const browserSessions = pgTable(
  "browser_sessions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    lifecycle: text("lifecycle", { enum: interactionLifecycleValues })
      .notNull()
      .default("starting"),
    placementKind: text("placement_kind", {
      enum: ["sandbox_group", "connected_machine", "attached_device", "external_provider"],
    }).notNull(),
    sandboxGroupId: uuid("sandbox_group_id"),
    connectedSandboxId: uuid("connected_sandbox_id"),
    deviceId: uuid("device_id"),
    externalProviderId: text("external_provider_id"),
    externalPlacementId: text("external_placement_id"),
    controllerId: text("controller_id"),
    controllerGeneration: text("controller_generation"),
    placementInstanceId: text("placement_instance_id"),
    tokenGeneration: integer("token_generation").notNull().default(1),
    driverId: text("driver_id").notNull(),
    engine: text("engine", {
      enum: ["chromium", "chrome", "firefox", "webkit", "lightpanda", "external"],
    }).notNull(),
    engineVersion: text("engine_version"),
    headless: boolean("headless").notNull(),
    identityId: uuid("identity_id"),
    baseRevisionId: uuid("base_revision_id"),
    linkedComputerSessionId: uuid("linked_computer_session_id"),
    networkRouteId: uuid("network_route_id"),
    networkRouteVersion: bigint("network_route_version", { mode: "number" }),
    networkRouteConfiguration: jsonb("network_route_configuration"),
    networkRouteConsistency: jsonb("network_route_consistency"),
    networkRouteCredentialVersion: bigint("network_route_credential_version", {
      mode: "number",
    }),
    networkRouteAuthorityDigest: text("network_route_authority_digest"),
    privateCheckpointArtifactId: uuid("private_checkpoint_artifact_id"),
    capabilities: jsonb("capabilities").$type<BrowserSessionCapabilities>().notNull(),
    createOperationId: uuid("create_operation_id").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    failureCode: text("failure_code"),
    controllerHeartbeatAt: timestamp("controller_heartbeat_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("browser_sessions_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    createOperation: uniqueIndex("browser_sessions_workspace_create_operation_uq").on(
      table.workspaceId,
      table.createOperationId,
    ),
    workspaceLifecycle: index("browser_sessions_workspace_lifecycle_idx").on(
      table.workspaceId,
      table.lifecycle,
      table.lastUsedAt,
      table.id,
    ),
    sandboxGroup: index("browser_sessions_sandbox_group_idx").on(
      table.workspaceId,
      table.sandboxGroupId,
      table.lifecycle,
    ),
    networkRoute: index("browser_sessions_workspace_network_route_idx").on(
      table.workspaceId,
      table.networkRouteId,
      table.lifecycle,
    ),
    valuesValid: check(
      "browser_sessions_values_check",
      sql`octet_length(${table.name}) between 1 and 200
        and octet_length(${table.driverId}) between 1 and 512
        and octet_length(${table.createdBySubjectId}) between 1 and 1024
        and ${table.tokenGeneration} > 0
        and octet_length(${table.capabilities}::text) between 2 and 65536
        and (
          (${table.networkRouteId} is null
            and ${table.networkRouteVersion} is null
            and ${table.networkRouteConfiguration} is null
            and ${table.networkRouteConsistency} is null
            and ${table.networkRouteCredentialVersion} is null
            and ${table.networkRouteAuthorityDigest} is null)
          or
          (${table.networkRouteId} is not null
            and ${table.networkRouteVersion} > 0
            and jsonb_typeof(${table.networkRouteConfiguration}) = 'object'
            and octet_length(${table.networkRouteConfiguration}::text) between 2 and 65536
            and jsonb_typeof(${table.networkRouteConsistency}) = 'object'
            and octet_length(${table.networkRouteConsistency}::text) between 2 and 65536
            and (${table.networkRouteCredentialVersion} is null or ${table.networkRouteCredentialVersion} > 0)
            and (${table.networkRouteAuthorityDigest} is not null or ${table.networkRouteCredentialVersion} is null)
            and (${table.networkRouteAuthorityDigest} is null or (
              octet_length(${table.networkRouteAuthorityDigest}) between 16 and 256
              and ${table.networkRouteAuthorityDigest} ~ '^[A-Za-z0-9._~-]+$'
            )))
        )
        and (${table.engineVersion} is null or octet_length(${table.engineVersion}) between 1 and 256)
        and (${table.failureCode} is null or octet_length(${table.failureCode}) between 1 and 512)`,
    ),
    placementValid: check(
      "browser_sessions_placement_check",
      sql`(
          ${table.placementKind} = 'sandbox_group'
          and ${table.sandboxGroupId} is not null
          and ${table.connectedSandboxId} is null
          and ${table.deviceId} is null
          and ${table.externalProviderId} is null
          and ${table.externalPlacementId} is null
        ) or (
          ${table.placementKind} = 'connected_machine'
          and ${table.sandboxGroupId} is null
          and ${table.connectedSandboxId} is not null
          and ${table.deviceId} is null
          and ${table.externalProviderId} is null
          and ${table.externalPlacementId} is null
        ) or (
          ${table.placementKind} = 'attached_device'
          and ${table.sandboxGroupId} is null
          and ${table.connectedSandboxId} is null
          and ${table.deviceId} is not null
          and ${table.externalProviderId} is null
          and ${table.externalPlacementId} is null
        ) or (
          ${table.placementKind} = 'external_provider'
          and ${table.sandboxGroupId} is null
          and ${table.connectedSandboxId} is null
          and ${table.deviceId} is null
          and ${table.externalProviderId} is not null
          and ${table.externalPlacementId} is not null
          and octet_length(${table.externalProviderId}) between 1 and 512
          and octet_length(${table.externalPlacementId}) between 1 and 512
        )`,
    ),
    controllerValid: check(
      "browser_sessions_controller_check",
      sql`(
          ${table.controllerId} is null
          and ${table.controllerGeneration} is null
          and ${table.placementInstanceId} is null
          and ${table.controllerHeartbeatAt} is null
        ) or (
          ${table.controllerId} is not null
          and octet_length(${table.controllerId}) between 1 and 512
          and ${table.controllerGeneration} is not null
          and octet_length(${table.controllerGeneration}) between 1 and 256
          and ${table.placementInstanceId} is not null
          and octet_length(${table.placementInstanceId}) between 1 and 512
          and ${table.controllerHeartbeatAt} is not null
        )`,
    ),
    identityRevisionValid: check(
      "browser_sessions_identity_revision_check",
      sql`${table.baseRevisionId} is null or ${table.identityId} is not null`,
    ),
    failureValid: check(
      "browser_sessions_failure_check",
      sql`(
          ${table.lifecycle} in ('repair_required', 'lost', 'failed')
          and ${table.failureCode} is not null
        ) or (
          ${table.lifecycle} not in ('repair_required', 'lost', 'failed')
          and ${table.failureCode} is null
        )`,
    ),
  }),
);

export const browserSessionAssociations = pgTable(
  "browser_session_associations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    browserSessionId: uuid("browser_session_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id"),
    attemptId: uuid("attempt_id"),
    relationship: text("relationship", {
      enum: ["created", "using", "observing", "related"],
    }).notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resourceSessionRelationship: uniqueIndex(
      "browser_session_associations_resource_session_relationship_uq",
    ).on(table.browserSessionId, table.sessionId, table.relationship),
    workspaceSession: index("browser_session_associations_workspace_session_idx").on(
      table.workspaceId,
      table.sessionId,
      table.lastUsedAt,
    ),
    resource: index("browser_session_associations_resource_idx").on(
      table.workspaceId,
      table.browserSessionId,
      table.lastUsedAt,
    ),
    valuesValid: check(
      "browser_session_associations_values_check",
      sql`octet_length(${table.actorSubjectId}) between 1 and 1024
        and (${table.attemptId} is null or ${table.turnId} is not null)`,
    ),
  }),
);

export const computerSessions = pgTable(
  "computer_sessions",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    lifecycle: text("lifecycle", { enum: interactionLifecycleValues })
      .notNull()
      .default("starting"),
    placementKind: text("placement_kind", {
      enum: ["sandbox_group", "connected_machine", "attached_device", "external_provider"],
    }).notNull(),
    sandboxGroupId: uuid("sandbox_group_id"),
    connectedSandboxId: uuid("connected_sandbox_id"),
    deviceId: uuid("device_id"),
    externalProviderId: text("external_provider_id"),
    externalPlacementId: text("external_placement_id"),
    controllerId: text("controller_id"),
    controllerGeneration: text("controller_generation"),
    placementInstanceId: text("placement_instance_id"),
    tokenGeneration: integer("token_generation").notNull().default(1),
    platform: text("platform", { enum: ["linux", "macos", "windows"] }),
    adapter: text("adapter"),
    seatId: text("seat_id"),
    displayId: text("display_id"),
    capabilities: jsonb("capabilities").$type<ComputerSessionCapabilities>(),
    createOperationId: uuid("create_operation_id").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    failureCode: text("failure_code"),
    controllerHeartbeatAt: timestamp("controller_heartbeat_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("computer_sessions_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    createOperation: uniqueIndex("computer_sessions_workspace_create_operation_uq").on(
      table.workspaceId,
      table.createOperationId,
    ),
    workspaceLifecycle: index("computer_sessions_workspace_lifecycle_idx").on(
      table.workspaceId,
      table.lifecycle,
      table.lastUsedAt,
      table.id,
    ),
    sandboxGroup: index("computer_sessions_sandbox_group_idx").on(
      table.workspaceId,
      table.sandboxGroupId,
      table.lifecycle,
    ),
    valuesValid: check(
      "computer_sessions_values_check",
      sql`octet_length(${table.name}) between 1 and 200
        and ${table.name} = btrim(${table.name})
        and octet_length(${table.createdBySubjectId}) between 1 and 1024
        and ${table.tokenGeneration} > 0
        and (${table.adapter} is null or octet_length(${table.adapter}) between 1 and 512)
        and (${table.seatId} is null or octet_length(${table.seatId}) between 1 and 512)
        and (${table.displayId} is null or octet_length(${table.displayId}) between 1 and 512)
        and (${table.capabilities} is null or (
          jsonb_typeof(${table.capabilities}) = 'object'
          and octet_length(${table.capabilities}::text) between 2 and 65536
        ))
        and (${table.failureCode} is null or octet_length(${table.failureCode}) between 1 and 512)`,
    ),
    placementValid: check(
      "computer_sessions_placement_check",
      sql`(
          ${table.placementKind} = 'sandbox_group'
          and ${table.sandboxGroupId} is not null
          and ${table.connectedSandboxId} is null
          and ${table.deviceId} is null
          and ${table.externalProviderId} is null
          and ${table.externalPlacementId} is null
        ) or (
          ${table.placementKind} = 'connected_machine'
          and ${table.sandboxGroupId} is null
          and ${table.connectedSandboxId} is not null
          and ${table.deviceId} is null
          and ${table.externalProviderId} is null
          and ${table.externalPlacementId} is null
        ) or (
          ${table.placementKind} = 'attached_device'
          and ${table.sandboxGroupId} is null
          and ${table.connectedSandboxId} is null
          and ${table.deviceId} is not null
          and ${table.externalProviderId} is null
          and ${table.externalPlacementId} is null
        ) or (
          ${table.placementKind} = 'external_provider'
          and ${table.sandboxGroupId} is null
          and ${table.connectedSandboxId} is null
          and ${table.deviceId} is null
          and ${table.externalProviderId} is not null
          and ${table.externalPlacementId} is not null
          and octet_length(${table.externalProviderId}) between 1 and 512
          and octet_length(${table.externalPlacementId}) between 1 and 512
        )`,
    ),
    controllerValid: check(
      "computer_sessions_controller_check",
      sql`(
          ${table.controllerId} is null
          and ${table.controllerGeneration} is null
          and ${table.placementInstanceId} is null
          and ${table.controllerHeartbeatAt} is null
        ) or (
          ${table.controllerId} is not null
          and octet_length(${table.controllerId}) between 1 and 512
          and ${table.controllerGeneration} is not null
          and octet_length(${table.controllerGeneration}) between 1 and 256
          and ${table.placementInstanceId} is not null
          and octet_length(${table.placementInstanceId}) between 1 and 512
          and ${table.controllerHeartbeatAt} is not null
        )`,
    ),
    nativeBindingValid: check(
      "computer_sessions_native_binding_check",
      sql`(
          ${table.platform} is null
          and ${table.adapter} is null
          and ${table.seatId} is null
          and ${table.displayId} is null
          and ${table.capabilities} is null
        ) or (
          ${table.platform} is not null
          and ${table.adapter} is not null
          and ${table.seatId} is not null
          and ${table.displayId} is not null
          and ${table.capabilities} is not null
        )`,
    ),
    activeValid: check(
      "computer_sessions_active_binding_check",
      sql`${table.lifecycle} <> 'active' or (
        ${table.controllerId} is not null
        and ${table.platform} is not null
        and ${table.capabilities} is not null
      )`,
    ),
    failureValid: check(
      "computer_sessions_failure_check",
      sql`(
          ${table.lifecycle} in ('repair_required', 'lost', 'failed')
          and ${table.failureCode} is not null
        ) or (
          ${table.lifecycle} not in ('repair_required', 'lost', 'failed')
          and ${table.failureCode} is null
        )`,
    ),
  }),
);

export const computerSessionAssociations = pgTable(
  "computer_session_associations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    computerSessionId: uuid("computer_session_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id"),
    attemptId: uuid("attempt_id"),
    relationship: text("relationship", {
      enum: ["created", "using", "observing", "related"],
    }).notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resourceSessionRelationship: uniqueIndex(
      "computer_session_associations_resource_session_relationship_uq",
    ).on(table.computerSessionId, table.sessionId, table.relationship),
    workspaceSession: index("computer_session_associations_workspace_session_idx").on(
      table.workspaceId,
      table.sessionId,
      table.lastUsedAt,
    ),
    resource: index("computer_session_associations_resource_idx").on(
      table.workspaceId,
      table.computerSessionId,
      table.lastUsedAt,
    ),
    valuesValid: check(
      "computer_session_associations_values_check",
      sql`octet_length(${table.actorSubjectId}) between 1 and 1024
        and (${table.attemptId} is null or ${table.turnId} is not null)`,
    ),
  }),
);

export const networkRoutes = pgTable(
  "network_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    configuration: jsonb("configuration").$type<NetworkRouteConfiguration>().notNull(),
    consistency: jsonb("consistency").$type<NetworkRouteConsistency>().notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createOperationId: uuid("create_operation_id").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    updatedBySubjectId: text("updated_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("network_routes_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    createOperation: uniqueIndex("network_routes_workspace_create_operation_uq").on(
      table.workspaceId,
      table.createOperationId,
    ),
    activeName: uniqueIndex("network_routes_workspace_active_name_uq")
      .on(table.workspaceId, sql`lower(${table.name})`)
      .where(sql`${table.status} = 'active'`),
    discovery: index("network_routes_workspace_status_updated_idx").on(
      table.workspaceId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    valuesValid: check(
      "network_routes_values_check",
      sql`octet_length(${table.name}) between 1 and 200
        and ${table.name} = btrim(${table.name})
        and jsonb_typeof(${table.configuration}) = 'object'
        and octet_length(${table.configuration}::text) between 2 and 65536
        and jsonb_typeof(${table.consistency}) = 'object'
        and octet_length(${table.consistency}::text) between 2 and 65536
        and ${table.version} > 0
        and octet_length(${table.createdBySubjectId}) between 1 and 1024
        and octet_length(${table.updatedBySubjectId}) between 1 and 1024`,
    ),
  }),
);

export const siteAuthConnections = pgTable(
  "site_auth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    accountLabel: text("account_label").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    origins: jsonb("origins").$type<string[]>().notNull(),
    loginUrl: text("login_url"),
    verificationUrlPrefixes: jsonb("verification_url_prefixes").$type<string[]>().notNull(),
    authorities: jsonb("authorities").$type<SiteAuthAuthority[]>().notNull(),
    methods: jsonb("methods").$type<SiteAuthMethod[]>().notNull(),
    preferredIdentityId: uuid("preferred_identity_id"),
    preferredPlacement: jsonb("preferred_placement").$type<InteractionPlacement>(),
    preferredNetworkRouteId: uuid("preferred_network_route_id"),
    healthPolicy: jsonb("health_policy").$type<SiteAuthHealthPolicy>().notNull(),
    verificationState: text("verification_state", {
      enum: ["unknown", "verified", "needs_repair", "failed"],
    })
      .notNull()
      .default("unknown"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastVerifiedUrl: text("last_verified_url"),
    repairCode: text("repair_code"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createOperationId: uuid("create_operation_id").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    updatedBySubjectId: text("updated_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("site_auth_connections_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    createOperation: uniqueIndex("site_auth_connections_workspace_create_operation_uq").on(
      table.workspaceId,
      table.createOperationId,
    ),
    activeName: uniqueIndex("site_auth_connections_workspace_active_name_uq")
      .on(table.workspaceId, sql`lower(${table.name})`)
      .where(sql`${table.status} = 'active'`),
    discovery: index("site_auth_connections_workspace_status_updated_idx").on(
      table.workspaceId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    valuesValid: check(
      "site_auth_connections_values_check",
      sql`octet_length(${table.name}) between 1 and 200
        and ${table.name} = btrim(${table.name})
        and octet_length(${table.accountLabel}) between 1 and 200
        and ${table.accountLabel} = btrim(${table.accountLabel})
        and jsonb_typeof(${table.origins}) = 'array'
        and octet_length(${table.origins}::text) between 3 and 65536
        and (${table.loginUrl} is null or octet_length(${table.loginUrl}) between 1 and 16384)
        and jsonb_typeof(${table.verificationUrlPrefixes}) = 'array'
        and octet_length(${table.verificationUrlPrefixes}::text) between 2 and 65536
        and jsonb_typeof(${table.authorities}) = 'array'
        and octet_length(${table.authorities}::text) between 3 and 65536
        and jsonb_typeof(${table.methods}) = 'array'
        and octet_length(${table.methods}::text) between 3 and 65536
        and (${table.preferredPlacement} is null or (
          jsonb_typeof(${table.preferredPlacement}) = 'object'
          and octet_length(${table.preferredPlacement}::text) between 2 and 65536
        ))
        and jsonb_typeof(${table.healthPolicy}) = 'object'
        and octet_length(${table.healthPolicy}::text) between 2 and 65536
        and (${table.lastVerifiedUrl} is null or octet_length(${table.lastVerifiedUrl}) between 1 and 16384)
        and (${table.repairCode} is null or octet_length(${table.repairCode}) between 1 and 512)
        and ${table.version} > 0
        and octet_length(${table.createdBySubjectId}) between 1 and 1024
        and octet_length(${table.updatedBySubjectId}) between 1 and 1024`,
    ),
    verificationValid: check(
      "site_auth_connections_verification_check",
      sql`(
          ${table.verificationState} = 'verified'
          and ${table.lastVerifiedAt} is not null
          and ${table.lastVerifiedUrl} is not null
          and ${table.repairCode} is null
        ) or (
          ${table.verificationState} = 'unknown'
          and ${table.lastVerifiedAt} is null
          and ${table.lastVerifiedUrl} is null
          and ${table.repairCode} is null
        ) or (
          ${table.verificationState} in ('needs_repair', 'failed')
          and ${table.repairCode} is not null
        )`,
    ),
  }),
);

export const authRuns = pgTable(
  "auth_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    siteAuthConnectionId: uuid("site_auth_connection_id").notNull(),
    browserSessionId: uuid("browser_session_id").notNull(),
    targetId: text("target_id").notNull(),
    controllerGeneration: text("controller_generation").notNull(),
    targetGeneration: text("target_generation").notNull(),
    documentGeneration: text("document_generation"),
    methodId: text("method_id"),
    authorityId: text("authority_id"),
    state: text("state", {
      enum: [
        "discovering",
        "awaiting_choice",
        "awaiting_secret",
        "awaiting_external_action",
        "working",
        "verified",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("discovering"),
    choices: jsonb("choices").$type<AuthRunChoice[]>().notNull().default([]),
    pendingFields: jsonb("pending_fields").$type<AuthRunPendingField[]>().notNull().default([]),
    externalAction: jsonb("external_action").$type<AuthRunExternalAction>(),
    interventionId: uuid("intervention_id"),
    verifiedUrl: text("verified_url"),
    failureCode: text("failure_code"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    operationId: uuid("operation_id").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("auth_runs_workspace_id_uq").on(table.workspaceId, table.id),
    operation: uniqueIndex("auth_runs_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    activeTarget: uniqueIndex("auth_runs_active_browser_target_uq")
      .on(table.workspaceId, table.browserSessionId, table.targetId)
      .where(sql`${table.settledAt} is null`),
    browserHistory: index("auth_runs_browser_history_idx").on(
      table.workspaceId,
      table.browserSessionId,
      table.createdAt,
    ),
    siteHistory: index("auth_runs_site_history_idx").on(
      table.workspaceId,
      table.siteAuthConnectionId,
      table.createdAt,
    ),
    valuesValid: check(
      "auth_runs_values_check",
      sql`octet_length(${table.targetId}) between 1 and 512
        and octet_length(${table.controllerGeneration}) between 1 and 256
        and octet_length(${table.targetGeneration}) between 1 and 256
        and (${table.documentGeneration} is null or octet_length(${table.documentGeneration}) between 1 and 256)
        and (${table.methodId} is null or octet_length(${table.methodId}) between 1 and 512)
        and (${table.authorityId} is null or octet_length(${table.authorityId}) between 1 and 512)
        and jsonb_typeof(${table.choices}) = 'array'
        and octet_length(${table.choices}::text) between 2 and 65536
        and jsonb_typeof(${table.pendingFields}) = 'array'
        and octet_length(${table.pendingFields}::text) between 2 and 65536
        and (${table.externalAction} is null or (
          jsonb_typeof(${table.externalAction}) = 'object'
          and octet_length(${table.externalAction}::text) between 2 and 65536
        ))
        and (${table.verifiedUrl} is null or octet_length(${table.verifiedUrl}) between 1 and 16384)
        and (${table.failureCode} is null or octet_length(${table.failureCode}) between 1 and 512)
        and ${table.version} > 0
        and octet_length(${table.createdBySubjectId}) between 1 and 1024`,
    ),
    lifecycleValid: check(
      "auth_runs_lifecycle_check",
      sql`(
          ${table.state} = 'verified'
          and ${table.verifiedUrl} is not null
          and ${table.failureCode} is null
          and ${table.settledAt} is not null
        ) or (
          ${table.state} = 'failed'
          and ${table.verifiedUrl} is null
          and ${table.failureCode} is not null
          and ${table.settledAt} is not null
        ) or (
          ${table.state} = 'cancelled'
          and ${table.verifiedUrl} is null
          and ${table.settledAt} is not null
        ) or (
          ${table.state} not in ('verified', 'failed', 'cancelled')
          and ${table.verifiedUrl} is null
          and ${table.failureCode} is null
          and ${table.settledAt} is null
        )`,
    ),
    projectionValid: check(
      "auth_runs_projection_check",
      sql`(${table.state} = 'awaiting_choice') = (jsonb_array_length(${table.choices}) > 0)
        and (${table.state} = 'awaiting_secret') = (jsonb_array_length(${table.pendingFields}) > 0)
        and (${table.state} = 'awaiting_external_action') = (${table.externalAction} is not null)
        and (${table.state} = 'failed') = (${table.failureCode} is not null)`,
    ),
  }),
);

export const interactionInterventions = pgTable(
  "interaction_interventions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    resourceKind: text("resource_kind", {
      enum: ["browser_session", "computer_session"],
    }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    targetId: text("target_id").notNull(),
    controllerGeneration: text("controller_generation").notNull(),
    targetGeneration: text("target_generation").notNull(),
    documentGeneration: text("document_generation"),
    kind: text("kind", {
      enum: ["manual_login", "mfa", "external_action", "confirmation", "other"],
    }).notNull(),
    reason: text("reason").notNull(),
    status: text("status", {
      enum: ["open", "completed", "dismissed", "expired", "cancelled"],
    })
      .notNull()
      .default("open"),
    authRunId: uuid("auth_run_id"),
    originatingSessionId: uuid("originating_session_id").notNull(),
    originatingTurnId: uuid("originating_turn_id"),
    originatingAttemptId: uuid("originating_attempt_id"),
    originatingToolOperationId: uuid("originating_tool_operation_id"),
    originatingToolCallId: text("originating_tool_call_id"),
    responseActorSubjectId: text("response_actor_subject_id"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    operationId: uuid("operation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceIdentity: uniqueIndex("interaction_interventions_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    operation: uniqueIndex("interaction_interventions_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    originatingToolCall: uniqueIndex("interaction_interventions_originating_tool_call_uq")
      .on(
        table.workspaceId,
        table.originatingSessionId,
        table.originatingTurnId,
        table.originatingToolCallId,
      )
      .where(sql`${table.originatingToolCallId} is not null`),
    openResource: index("interaction_interventions_open_resource_idx").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
      table.status,
      table.createdAt,
    ),
    openTargetKind: uniqueIndex("interaction_interventions_open_target_kind_uq")
      .on(table.workspaceId, table.resourceKind, table.resourceId, table.targetId, table.kind)
      .where(sql`${table.status} = 'open'`),
    openAuthRun: uniqueIndex("interaction_interventions_open_auth_run_uq")
      .on(table.workspaceId, table.authRunId)
      .where(sql`${table.status} = 'open' and ${table.authRunId} is not null`),
    valuesValid: check(
      "interaction_interventions_values_check",
      sql`octet_length(${table.targetId}) between 1 and 512
        and octet_length(${table.controllerGeneration}) between 1 and 256
        and octet_length(${table.targetGeneration}) between 1 and 256
        and (${table.documentGeneration} is null or octet_length(${table.documentGeneration}) between 1 and 256)
        and octet_length(${table.reason}) between 1 and 2048
        and ${table.reason} = btrim(${table.reason})
        and (${table.originatingAttemptId} is null or ${table.originatingTurnId} is not null)
        and (${table.originatingToolOperationId} is null or ${table.originatingAttemptId} is not null)
        and (${table.originatingToolCallId} is null or (
          ${table.originatingAttemptId} is not null
          and octet_length(${table.originatingToolCallId}) between 1 and 1024
        ))
        and (${table.responseActorSubjectId} is null or octet_length(${table.responseActorSubjectId}) between 1 and 1024)
        and ${table.version} > 0`,
    ),
    lifecycleValid: check(
      "interaction_interventions_lifecycle_check",
      sql`(
          ${table.status} = 'open'
          and ${table.responseActorSubjectId} is null
          and ${table.settledAt} is null
        ) or (
          ${table.status} <> 'open'
          and ${table.settledAt} is not null
        )`,
    ),
  }),
);

export const interactionResourceOperations = pgTable(
  "interaction_resource_operations",
  {
    operationId: uuid("operation_id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    resourceKind: text("resource_kind", {
      enum: ["network_route", "site_auth_connection", "auth_run", "intervention"],
    }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    kind: text("kind", {
      enum: ["create", "update", "start", "report", "protected_fill", "verify", "resolve"],
    }).notNull(),
    requestDigest: text("request_digest").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state", {
      enum: ["prepared", "dispatched", "completed", "failed", "outcome_unknown"],
    })
      .notNull()
      .default("completed"),
    resultVersion: bigint("result_version", { mode: "number" }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    actorSubjectId: text("actor_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceOperation: uniqueIndex("interaction_resource_operations_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    resourceHistory: index("interaction_resource_operations_resource_history_idx").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
      table.createdAt,
    ),
    valuesValid: check(
      "interaction_resource_operations_values_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'
        and jsonb_typeof(${table.metadata}) = 'object'
        and octet_length(${table.metadata}::text) between 2 and 65536
        and (${table.resultVersion} is null or ${table.resultVersion} > 0)
        and (${table.result} is null or (
          jsonb_typeof(${table.result}) = 'object'
          and octet_length(${table.result}::text) between 2 and 262144
        ))
        and (${table.errorCode} is null or octet_length(${table.errorCode}) between 1 and 512)
        and octet_length(${table.actorSubjectId}) between 1 and 1024`,
    ),
    lifecycleValid: check(
      "interaction_resource_operations_lifecycle_check",
      sql`(
          ${table.state} = 'completed'
          and ${table.resultVersion} is not null
          and ${table.result} is not null
          and ${table.errorCode} is null
          and ${table.settledAt} is not null
        ) or (
          ${table.state} in ('failed', 'outcome_unknown')
          and ${table.resultVersion} is null
          and ${table.result} is null
          and ${table.errorCode} is not null
          and ${table.settledAt} is not null
        ) or (
          ${table.state} in ('prepared', 'dispatched')
          and ${table.resultVersion} is null
          and ${table.result} is null
          and ${table.errorCode} is null
          and ${table.settledAt} is null
        )`,
    ),
  }),
);

export const interactionOperations = pgTable(
  "interaction_operations",
  {
    operationId: uuid("operation_id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    resourceKind: text("resource_kind", {
      enum: ["browser_session", "computer_session"],
    }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    kind: text("kind", { enum: interactionOperationKindValues }).notNull(),
    requestDigest: text("request_digest").notNull(),
    state: text("state", { enum: interactionOperationStateValues }).notNull().default("prepared"),
    controllerGeneration: text("controller_generation"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorRetryable: boolean("error_retryable"),
    errorDetails: jsonb("error_details").$type<Record<string, unknown>>(),
    actorSubjectId: text("actor_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceOperation: uniqueIndex("interaction_operations_workspace_operation_uq").on(
      table.workspaceId,
      table.operationId,
    ),
    resourceHistory: index("interaction_operations_resource_history_idx").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
      table.createdAt,
    ),
    activeResource: uniqueIndex("interaction_operations_active_resource_uq")
      .on(table.workspaceId, table.resourceKind, table.resourceId)
      .where(sql`${table.state} in ('prepared', 'dispatched')`),
    valuesValid: check(
      "interaction_operations_values_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'
        and octet_length(${table.actorSubjectId}) between 1 and 1024
        and (${table.controllerGeneration} is null or octet_length(${table.controllerGeneration}) between 1 and 256)
        and (${table.errorCode} is null or octet_length(${table.errorCode}) between 1 and 512)
        and (${table.errorMessage} is null or octet_length(${table.errorMessage}) between 1 and 8192)
        and (${table.errorDetails} is null or octet_length(${table.errorDetails}::text) between 2 and 65536)`,
    ),
    lifecycleValid: check(
      "interaction_operations_lifecycle_check",
      sql`(
          ${table.state} = 'prepared'
          and ${table.dispatchedAt} is null
          and ${table.settledAt} is null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null
          and ${table.errorRetryable} is null
          and ${table.errorDetails} is null
        ) or (
          ${table.state} = 'dispatched'
          and ${table.dispatchedAt} is not null
          and ${table.settledAt} is null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null
          and ${table.errorRetryable} is null
          and ${table.errorDetails} is null
        ) or (
          ${table.state} = 'completed'
          and ${table.dispatchedAt} is not null
          and ${table.settledAt} is not null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null
          and ${table.errorRetryable} is null
          and ${table.errorDetails} is null
        ) or (
          ${table.state} in ('failed', 'outcome_unknown')
          and ${table.settledAt} is not null
          and ${table.errorCode} is not null
          and ${table.errorMessage} is not null
          and ${table.errorRetryable} is not null
        )`,
    ),
  }),
);
