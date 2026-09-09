import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Source identity, not another mutable Skill head. Portable ownership stays upstream. */
export const skillSourceBindings = pgTable(
  "skill_source_bindings",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    pluginId: uuid("plugin_id").notNull(),
    facetKey: text("facet_key").notNull(),
    preferenceId: uuid("preference_id").notNull(),
    skillFacetId: uuid("skill_facet_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.pluginId, table.facetKey] }),
    uniqueIndex("skill_source_bindings_preference_id_key").on(table.preferenceId),
  ],
);

export const skillWriteReceipts = pgTable(
  "skill_write_receipts",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    actor: jsonb("actor").notNull(),
    receipt: jsonb("receipt").notNull(),
    activationEventId: uuid("activation_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.operationId] })],
);

/** Immutable maintenance evidence; never an execution configuration head. */
export const skillConfigConversionReceipts = pgTable(
  "skill_config_conversion_receipts",
  {
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    conversionVersion: text("conversion_version").notNull().default("0426-v1"),
    actor: text("actor").notNull().default("service:skill-migration:0432"),
    originalConfiguration: jsonb("original_configuration").notNull(),
    originalHash: text("original_hash").notNull(),
    replacementHash: text("replacement_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sourceKind, table.sourceId, table.conversionVersion],
    }),
  ],
);
