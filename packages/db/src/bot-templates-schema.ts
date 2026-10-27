import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { SessionAvatar } from "@opengeni/contracts";

/**
 * Bot templates saved in a workspace (migration 1008): where a new bot chat
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

/**
 * Setup-instruction updates bot chats propose for their template (migration
 * 1015). A person who may change the template accepts or dismisses each one.
 * Foreign keys, checks and the session-visibility policy live in the migration.
 */
export const botTemplateProposals = pgTable(
  "bot_template_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    templateId: uuid("template_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    baseUpdatedAt: timestamp("base_updated_at", { withTimezone: true }).notNull(),
    setupInstructions: text("setup_instructions").notNull(),
    reason: text("reason").notNull(),
    proposedBySubjectId: text("proposed_by_subject_id"),
    status: text("status")
      .$type<"pending" | "accepted" | "dismissed" | "superseded">()
      .notNull()
      .default("pending"),
    decidedBySubjectId: text("decided_by_subject_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("bot_template_proposals_template_idx").on(
      table.workspaceId,
      table.templateId,
      table.status,
      table.createdAt,
    ),
    index("bot_template_proposals_session_idx").on(
      table.workspaceId,
      table.sessionId,
      table.status,
    ),
  ],
);
