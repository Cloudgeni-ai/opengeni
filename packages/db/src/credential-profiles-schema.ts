import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Migration 0997: credential profiles (names and secret references, never
// values). Foreign keys to workspaces and sessions live in the migration.

export type CredentialProfileEntryRow = { name: string; reference: string };

export const credentialProfiles = pgTable(
  "credential_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    /** NULL for the workspace profile. */
    sessionId: uuid("session_id"),
    entries: jsonb("entries").$type<CredentialProfileEntryRow[]>().notNull().default([]),
    /** NULL on a session inherits; on the workspace it means off. */
    gitHelper: boolean("git_helper"),
    updatedBySubjectId: text("updated_by_subject_id").notNull(),
    updatedBySessionId: uuid("updated_by_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("credential_profiles_workspace_uq")
      .on(table.workspaceId)
      .where(sql`${table.sessionId} IS NULL`),
    uniqueIndex("credential_profiles_session_uq")
      .on(table.workspaceId, table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index("credential_profiles_session_idx")
      .on(table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
  ],
);
