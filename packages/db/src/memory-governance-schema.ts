import { sql } from "drizzle-orm";
import {
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

// Foreign keys, immutable-history triggers, and lifecycle-only mutation guards
// live in migration 0152. Keeping this leaf cycle-free lets schema.ts expose the
// additive memory governance tables without importing knowledgeMemories here.
export const knowledgeMemoryRelationships = pgTable(
  "knowledge_memory_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceMemoryId: uuid("source_memory_id").notNull(),
    targetMemoryId: uuid("target_memory_id").notNull(),
    relationshipType: text("relationship_type").notNull(),
    version: integer("version").notNull().default(1),
    createdByEventId: uuid("created_by_event_id").notNull(),
    removedByEventId: uuid("removed_by_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => ({
    activeDirectedEdge: uniqueIndex("knowledge_memory_relationships_active_edge_uq")
      .on(table.workspaceId, table.sourceMemoryId, table.targetMemoryId, table.relationshipType)
      .where(sql`${table.removedByEventId} is null`),
    activeSymmetricEdge: uniqueIndex("knowledge_memory_relationships_active_symmetric_edge_uq")
      .on(
        table.workspaceId,
        table.relationshipType,
        sql`least(${table.sourceMemoryId}, ${table.targetMemoryId})`,
        sql`greatest(${table.sourceMemoryId}, ${table.targetMemoryId})`,
      )
      .where(
        sql`${table.removedByEventId} is null and ${table.relationshipType} in ('conflicts_with', 'related_to')`,
      ),
    source: index("knowledge_memory_relationships_source_idx").on(
      table.workspaceId,
      table.sourceMemoryId,
      table.createdAt.desc(),
      table.id,
    ),
    target: index("knowledge_memory_relationships_target_idx").on(
      table.workspaceId,
      table.targetMemoryId,
      table.createdAt.desc(),
      table.id,
    ),
    typeValid: check(
      "knowledge_memory_relationships_type_chk",
      sql`${table.relationshipType} in ('derived_from', 'supersedes', 'corrects', 'conflicts_with', 'related_to', 'depends_on', 'applies_to')`,
    ),
    distinctEndpoints: check(
      "knowledge_memory_relationships_distinct_chk",
      sql`${table.sourceMemoryId} <> ${table.targetMemoryId}`,
    ),
    versionPositive: check("knowledge_memory_relationships_version_chk", sql`${table.version} > 0`),
    removedShape: check(
      "knowledge_memory_relationships_removed_shape_chk",
      sql`(${table.removedByEventId} is null and ${table.removedAt} is null) or (${table.removedByEventId} is not null and ${table.removedAt} is not null)`,
    ),
    workspaceIdentity: uniqueIndex("knowledge_memory_relationships_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
  }),
);

export const knowledgeMemoryLifecycleEvents = pgTable(
  "knowledge_memory_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    action: text("action").notNull(),
    operationType: text("operation_type").notNull(),
    targetMemoryId: uuid("target_memory_id").notNull(),
    relatedMemoryId: uuid("related_memory_id"),
    relationshipId: uuid("relationship_id"),
    relationshipType: text("relationship_type"),
    actorKind: text("actor_kind").notNull(),
    actorSubjectId: text("actor_subject_id").notNull(),
    actorSessionId: uuid("actor_session_id"),
    actorTurnId: uuid("actor_turn_id"),
    actorAttemptId: uuid("actor_attempt_id"),
    actorExecutionGeneration: integer("actor_execution_generation"),
    planHash: text("plan_hash").notNull(),
    beforeState: jsonb("before_state").$type<Record<string, unknown>>().notNull(),
    afterState: jsonb("after_state").$type<Record<string, unknown>>().notNull(),
    revertsEventId: uuid("reverts_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operationAction: uniqueIndex("knowledge_memory_lifecycle_events_operation_action_uq").on(
      table.workspaceId,
      table.operationId,
      table.action,
    ),
    oneRevert: uniqueIndex("knowledge_memory_lifecycle_events_one_revert_uq")
      .on(table.revertsEventId)
      .where(sql`${table.revertsEventId} is not null`),
    targetTimeline: index("knowledge_memory_lifecycle_events_target_timeline_idx").on(
      table.workspaceId,
      table.targetMemoryId,
      table.createdAt.desc(),
      table.id,
    ),
    actorTimeline: index("knowledge_memory_lifecycle_events_actor_timeline_idx").on(
      table.workspaceId,
      table.actorKind,
      table.actorSubjectId,
      table.createdAt.desc(),
      table.id,
    ),
    actionValid: check(
      "knowledge_memory_lifecycle_events_action_chk",
      sql`${table.action} in ('apply', 'revert')`,
    ),
    operationValid: check(
      "knowledge_memory_lifecycle_events_operation_chk",
      sql`${table.operationType} in ('reclassify', 'archive', 'relationship_add', 'relationship_remove', 'supersede', 'correct')`,
    ),
    relationshipShape: check(
      "knowledge_memory_lifecycle_events_relationship_chk",
      sql`(${table.operationType} in ('relationship_add', 'relationship_remove', 'supersede', 'correct') and ${table.relatedMemoryId} is not null and ${table.relationshipId} is not null and ${table.relationshipType} is not null) or (${table.operationType} in ('reclassify', 'archive') and ${table.relatedMemoryId} is null and ${table.relationshipId} is null and ${table.relationshipType} is null)`,
    ),
    actorValid: check(
      "knowledge_memory_lifecycle_events_actor_chk",
      sql`${table.actorKind} in ('subject', 'service') and length(btrim(${table.actorSubjectId})) between 1 and 1024`,
    ),
    attemptShape: check(
      "knowledge_memory_lifecycle_events_attempt_shape_chk",
      sql`(${table.actorSessionId} is null and ${table.actorTurnId} is null and ${table.actorAttemptId} is null and ${table.actorExecutionGeneration} is null) or (${table.actorSessionId} is not null and ${table.actorTurnId} is not null and ${table.actorAttemptId} is not null and ${table.actorExecutionGeneration} > 0)`,
    ),
    planHashShape: check(
      "knowledge_memory_lifecycle_events_plan_hash_chk",
      sql`${table.planHash} ~ '^[a-f0-9]{64}$'`,
    ),
    stateShape: check(
      "knowledge_memory_lifecycle_events_state_chk",
      sql`jsonb_typeof(${table.beforeState}) = 'object' and jsonb_typeof(${table.afterState}) = 'object' and not (${table.beforeState} ?| array['text', 'sourceRefs', 'source_refs', 'metadata', 'embedding']) and not (${table.afterState} ?| array['text', 'sourceRefs', 'source_refs', 'metadata', 'embedding'])`,
    ),
    revertShape: check(
      "knowledge_memory_lifecycle_events_revert_shape_chk",
      sql`(${table.action} = 'apply' and ${table.revertsEventId} is null) or (${table.action} = 'revert' and ${table.revertsEventId} is not null)`,
    ),
    workspaceIdentity: uniqueIndex("knowledge_memory_lifecycle_events_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
  }),
);
