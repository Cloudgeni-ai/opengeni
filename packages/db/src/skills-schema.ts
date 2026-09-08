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
