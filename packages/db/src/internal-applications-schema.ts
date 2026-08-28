import type {
  InternalApplicationBundleManifest,
  InternalApplicationDataGovernance,
  InternalApplicationDataSourceLocator,
  InternalApplicationDefinition,
  InternalApplicationDeploymentPlan,
  InternalApplicationDeploymentTargetConfig,
  InternalApplicationTargetCapabilities,
} from "@opengeni/contracts/internal-applications";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Cross-table foreign keys are migration-owned. Keeping this leaf cycle-free
// lets schema.ts expose the domain without importing its own root module.
export const internalApplications = pgTable(
  "internal_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("draft"),
    headRevisionId: uuid("head_revision_id"),
    headRevision: bigint("head_revision", { mode: "number" }).notNull().default(0),
    definitionHash: text("definition_hash"),
    creationOperationId: uuid("creation_operation_id").notNull(),
    creationRequestHash: text("creation_request_hash").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceSlug: uniqueIndex("internal_applications_workspace_slug_uq").on(
      table.workspaceId,
      table.slug,
    ),
    workspaceCreationOperation: uniqueIndex("internal_applications_workspace_operation_uq").on(
      table.workspaceId,
      table.creationOperationId,
    ),
    workspaceUpdated: index("internal_applications_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
      table.id,
    ),
    status: check(
      "internal_applications_status_chk",
      sql`${table.status} in ('draft', 'active', 'archived')`,
    ),
  }),
);

export const internalApplicationRevisions = pgTable(
  "internal_application_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    definitionHash: text("definition_hash").notNull(),
    definition: jsonb("definition").$type<InternalApplicationDefinition>().notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    applicationRevision: uniqueIndex("internal_application_revisions_revision_uq").on(
      table.applicationId,
      table.revision,
    ),
    applicationOperation: uniqueIndex("internal_application_revisions_operation_uq").on(
      table.applicationId,
      table.operationId,
    ),
    workspaceTimeline: index("internal_application_revisions_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const internalApplicationDataSources = pgTable(
  "internal_application_data_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").notNull(),
    allowedAccessModes: jsonb("allowed_access_modes").$type<string[]>().notNull(),
    locator: jsonb("locator").$type<InternalApplicationDataSourceLocator>().notNull(),
    schemaDefinition: jsonb("schema_definition").$type<Record<string, unknown>>().notNull(),
    governance: jsonb("governance").$type<InternalApplicationDataGovernance>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean>>().notNull(),
    status: text("status").notNull().default("active"),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceName: uniqueIndex("internal_application_data_sources_workspace_name_uq").on(
      table.workspaceId,
      table.name,
    ),
    workspaceStatus: index("internal_application_data_sources_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.name,
    ),
  }),
);

export const internalApplicationDeploymentTargets = pgTable(
  "internal_application_deployment_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").notNull(),
    environment: text("environment").notNull(),
    site: text("site").notNull(),
    config: jsonb("config").$type<InternalApplicationDeploymentTargetConfig>().notNull(),
    capabilities: jsonb("capabilities").$type<InternalApplicationTargetCapabilities>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean>>().notNull(),
    status: text("status").notNull().default("active"),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceName: uniqueIndex("internal_application_targets_workspace_name_uq").on(
      table.workspaceId,
      table.name,
    ),
    workspaceStatus: index("internal_application_targets_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.name,
    ),
  }),
);

export const internalApplicationBundles = pgTable(
  "internal_application_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    applicationRevisionId: uuid("application_revision_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    digest: text("digest").notNull(),
    manifest: jsonb("manifest").$type<InternalApplicationBundleManifest>().notNull(),
    status: text("status").notNull().default("ready"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    applicationDigest: uniqueIndex("internal_application_bundles_digest_uq").on(
      table.applicationId,
      table.digest,
    ),
    applicationOperation: uniqueIndex("internal_application_bundles_operation_uq").on(
      table.applicationId,
      table.operationId,
    ),
    workspaceTimeline: index("internal_application_bundles_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const internalApplicationDeployments = pgTable(
  "internal_application_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    environment: text("environment").notNull(),
    targetId: uuid("target_id").notNull(),
    targetRevision: bigint("target_revision", { mode: "number" }).notNull(),
    activeBundleId: uuid("active_bundle_id"),
    previousBundleId: uuid("previous_bundle_id"),
    desiredBundleId: uuid("desired_bundle_id"),
    status: text("status").notNull().default("not_deployed"),
    internalUrl: text("internal_url"),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    applicationEnvironment: uniqueIndex("internal_application_deployments_environment_uq").on(
      table.applicationId,
      table.environment,
    ),
    workspaceStatus: index("internal_application_deployments_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.updatedAt,
    ),
  }),
);

export const internalApplicationDeploymentOperations = pgTable(
  "internal_application_deployment_operations",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    deploymentId: uuid("deployment_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    requestHash: text("request_hash").notNull(),
    plan: jsonb("plan").$type<InternalApplicationDeploymentPlan>(),
    approvedBySubjectId: text("approved_by_subject_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    providerOperationId: text("provider_operation_id"),
    providerStarted: boolean("provider_started").notNull().default(false),
    result: jsonb("result").$type<Record<string, string | number | boolean>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deploymentTimeline: index("internal_application_operations_deployment_time_idx").on(
      table.deploymentId,
      table.createdAt,
      table.id,
    ),
    workspaceStatus: index("internal_application_operations_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.updatedAt,
    ),
  }),
);

export const internalApplicationEvents = pgTable(
  "internal_application_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    applicationId: uuid("application_id"),
    deploymentId: uuid("deployment_id"),
    operationId: uuid("operation_id"),
    type: text("type").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    facts: jsonb("facts").$type<Record<string, string | number | boolean | null>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceTimeline: index("internal_application_events_workspace_time_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    applicationTimeline: index("internal_application_events_application_time_idx").on(
      table.applicationId,
      table.createdAt,
      table.id,
    ),
    typeBound: check(
      "internal_application_events_type_bytes_chk",
      sql`octet_length(convert_to(${table.type}, 'UTF8')) between 1 and 128`,
    ),
  }),
);
