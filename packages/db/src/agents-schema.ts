import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { SessionAvatar } from "@opengeni/contracts";

/**
 * Agents (migration 1243, docs/agents.md): one record per agent, owned by its
 * HOME workspace, where its chats run. Same ids as the legacy Slack agents and
 * bot templates it replaces. Everyone in the organization may read agents that
 * are not Only me (`private`); an Only me agent is visible only to its owner.
 *
 * On all three tables, the length/size bounds checks, the account and
 * workspace foreign keys, the connection foreign key and the RLS policies
 * live only in migration 1243; this file declares what queries rely on.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    visibility: text("visibility").$type<"private" | "workspace">().notNull(),
    ownerSubjectId: text("owner_subject_id"),
    name: text("name").notNull(),
    /** lower(btrim(name)), for name clash hints only; not unique. */
    nameKey: text("name_key").notNull(),
    description: text("description").notNull().default(""),
    avatar: jsonb("avatar").$type<SessionAvatar>(),
    memoryEnabled: boolean("memory_enabled").notNull().default(false),
    memoryCollectionId: uuid("memory_collection_id"),
    currentRevision: integer("current_revision").notNull().default(1),
    origin: text("origin").$type<"slack_agent" | "bot_template" | "app" | "slack">().notNull(),
    sourceSessionId: uuid("source_session_id"),
    createdBySubjectId: text("created_by_subject_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("agents_id_account_uq").on(table.id, table.accountId),
    index("agents_workspace_idx").on(table.workspaceId, table.createdAt),
    index("agents_account_idx").on(table.accountId),
    check("agents_visibility_check", sql`${table.visibility} in ('private', 'workspace')`),
    check(
      "agents_private_owner_check",
      sql`${table.visibility} = 'workspace' or ${table.ownerSubjectId} is not null`,
    ),
    check(
      "agents_origin_check",
      sql`${table.origin} in ('slack_agent', 'bot_template', 'app', 'slack')`,
    ),
  ],
);

/**
 * Immutable agent content: Instructions (up to 20,000 characters), First
 * message, and the name and description as of the revision. Home workspace
 * only, never organization readable; the runtime may only read and insert.
 */
export const agentRevisions = pgTable(
  "agent_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    firstMessage: text("first_message").notNull().default(""),
    createdBySubjectId: text("created_by_subject_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("agent_revisions_agent_revision_uq").on(table.agentId, table.revision),
    foreignKey({
      name: "agent_revisions_agent_fk",
      columns: [table.agentId, table.accountId],
      foreignColumns: [agents.id, agents.accountId],
    }).onDelete("cascade"),
    index("agent_revisions_workspace_idx").on(table.workspaceId),
  ],
);

/**
 * Where an agent is available in Slack: one row per agent and Slack
 * installation (connection), owned by the agent's HOME workspace. `nameKey`
 * is the Slack handle key, unique per installation. Slack routing reads it
 * from the installation's home workspace through the organization read.
 */
export const agentSlackInstalls = pgTable(
  "agent_slack_installs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    /** The Slack installation's own workspace (migration 1301). */
    installWorkspaceId: uuid("install_workspace_id"),
    slackTeamId: text("slack_team_id").notNull(),
    nameKey: text("name_key").notNull(),
    open: boolean("open").notNull().default(false),
    enabledBySubjectId: text("enabled_by_subject_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("agent_slack_installs_agent_connection_uq").on(table.agentId, table.connectionId),
    unique("agent_slack_installs_name_key_uq").on(table.connectionId, table.nameKey),
    foreignKey({
      name: "agent_slack_installs_agent_fk",
      columns: [table.agentId, table.accountId],
      foreignColumns: [agents.id, agents.accountId],
    }).onDelete("cascade"),
    index("agent_slack_installs_workspace_idx").on(table.workspaceId),
  ],
);
