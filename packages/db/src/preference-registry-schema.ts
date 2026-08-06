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
import type { PreferenceRegistryDescriptor } from "@opengeni/contracts";

// Foreign keys and cross-row integrity triggers are migration-owned. This leaf
// stays cycle-free so schema.ts can expose the registry as one additive domain.
export const preferenceRegistryPreferences = pgTable(
  "preference_registry_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    stableKey: text("stable_key").notNull(),
    scope: text("scope").notNull(),
    scopeWorkspaceId: uuid("scope_workspace_id"),
    scopeSubjectId: text("scope_subject_id"),
    status: text("status").notNull().default("proposed"),
    scopeVersion: integer("scope_version").notNull().default(1),
    activationVersion: integer("activation_version").notNull().default(0),
    activeRevisionId: uuid("active_revision_id"),
    activeRevision: bigint("active_revision", { mode: "number" }),
    activeContentHash: text("active_content_hash"),
    supersededByPreferenceId: uuid("superseded_by_preference_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationStableKey: uniqueIndex("preference_registry_preferences_organization_key_uq")
      .on(table.accountId, table.stableKey)
      .where(sql`${table.scope} = 'organization'`),
    workspaceStableKey: uniqueIndex("preference_registry_preferences_workspace_key_uq")
      .on(table.accountId, table.scopeWorkspaceId, table.stableKey)
      .where(sql`${table.scope} = 'workspace'`),
    userStableKey: uniqueIndex("preference_registry_preferences_user_key_uq")
      .on(table.accountId, table.scopeSubjectId, table.stableKey)
      .where(sql`${table.scope} = 'user'`),
    applicable: index("preference_registry_preferences_applicable_idx").on(
      table.accountId,
      table.scope,
      table.scopeWorkspaceId,
      table.scopeSubjectId,
      table.status,
      table.stableKey,
    ),
    scopeShape: check(
      "preference_registry_preferences_scope_shape_chk",
      sql`(
        (${table.scope} = 'organization' and ${table.scopeWorkspaceId} is null and ${table.scopeSubjectId} is null)
        or (${table.scope} = 'workspace' and ${table.scopeWorkspaceId} is not null and ${table.scopeSubjectId} is null)
        or (${table.scope} = 'user' and ${table.scopeWorkspaceId} is null and ${table.scopeSubjectId} is not null)
      )`,
    ),
  }),
);

export const preferenceRegistryRevisions = pgTable(
  "preference_registry_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    preferenceId: uuid("preference_id").notNull(),
    revision: bigint("revision", { mode: "number" })
      .notNull()
      .default(sql`nextval('preference_registry_revision_seq')`),
    title: text("title").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    precedenceRank: integer("precedence_rank").notNull().default(0),
    conflictStrategy: text("conflict_strategy").notNull(),
    conflictsWith: jsonb("conflicts_with").$type<string[]>().notNull().default([]),
    provenanceSource: text("provenance_source").notNull(),
    provenanceSourceId: text("provenance_source_id"),
    trust: text("trust").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    correctsRevisionId: uuid("corrects_revision_id"),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    preferenceRevision: uniqueIndex("preference_registry_revisions_preference_revision_uq").on(
      table.preferenceId,
      table.revision,
    ),
    history: index("preference_registry_revisions_history_idx").on(
      table.preferenceId,
      table.revision,
    ),
  }),
);

export const preferenceRegistryEvents = pgTable(
  "preference_registry_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    preferenceId: uuid("preference_id").notNull(),
    type: text("type").notNull(),
    version: integer("version").notNull(),
    oldRevisionId: uuid("old_revision_id"),
    newRevisionId: uuid("new_revision_id"),
    oldScope: text("old_scope"),
    oldWorkspaceId: uuid("old_workspace_id"),
    oldSubjectId: text("old_subject_id"),
    newScope: text("new_scope"),
    newWorkspaceId: uuid("new_workspace_id"),
    newSubjectId: text("new_subject_id"),
    relatedPreferenceId: uuid("related_preference_id"),
    actorSubjectId: text("actor_subject_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    preferenceVersion: uniqueIndex("preference_registry_events_preference_version_uq").on(
      table.preferenceId,
      table.version,
    ),
    timeline: index("preference_registry_events_timeline_idx").on(
      table.preferenceId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const preferenceRegistrySnapshots = pgTable(
  "preference_registry_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    initiatingHumanSubjectId: text("initiating_human_subject_id").notNull(),
    descriptors: jsonb("descriptors").$type<PreferenceRegistryDescriptor[]>().notNull(),
    descriptorHash: text("descriptor_hash").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attempt: uniqueIndex("preference_registry_snapshots_attempt_uq").on(
      table.accountId,
      table.workspaceId,
      table.attemptId,
    ),
    humanTimeline: index("preference_registry_snapshots_human_timeline_idx").on(
      table.workspaceId,
      table.initiatingHumanSubjectId,
      table.createdAt,
    ),
    descriptorBytes: check(
      "preference_registry_snapshots_descriptor_bytes_chk",
      sql`octet_length(convert_to(${table.descriptors}::text, 'UTF8')) <= 16384`,
    ),
  }),
);
