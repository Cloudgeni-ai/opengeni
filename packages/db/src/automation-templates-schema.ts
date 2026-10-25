import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Automation templates saved in a workspace (migration 0959). `definition`
 * holds the message, schedule, triggers and storm guard as the API validated
 * them. The foreign key to workspaces lives in the migration.
 */
export const automationTemplates = pgTable(
  "automation_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    createdBySubjectId: text("created_by_subject_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("automation_templates_workspace_idx").on(table.workspaceId, table.createdAt)],
);
