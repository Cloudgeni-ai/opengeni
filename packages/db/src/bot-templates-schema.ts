import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SessionAvatar } from "@opengeni/contracts";

/**
 * Bot templates saved in a workspace (migration 1004): where a new bot chat
 * starts. The foreign key to workspaces lives in the migration.
 */
export const botTemplates = pgTable(
  "bot_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    avatar: jsonb("avatar").$type<SessionAvatar>(),
    setupInstructions: text("setup_instructions").notNull(),
    sourceSessionId: uuid("source_session_id"),
    createdBySubjectId: text("created_by_subject_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("bot_templates_workspace_idx").on(table.workspaceId, table.createdAt)],
);
