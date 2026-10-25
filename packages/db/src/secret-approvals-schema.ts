import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Migration 0952: per-item and per-field approval for agent use of secrets.
// Foreign keys to accounts, workspaces and sessions live in the migration.

/** One stored approval target: names are for the person deciding, never values. */
export type SecretUseApprovalTargetRow = {
  vaultId: string;
  itemId: string;
  /** The field's name key; the empty string never appears in a target. */
  fieldKey: string;
  vaultName: string;
  itemName: string;
  fieldName: string;
};

export const secretApprovalRules = pgTable(
  "secret_approval_rules",
  {
    accountId: uuid("account_id").notNull(),
    itemId: uuid("item_id").notNull(),
    /** Empty for the whole item, else a field name key. */
    fieldKey: text("field_key").notNull().default(""),
    vaultId: uuid("vault_id").notNull(),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.itemId, table.fieldKey] })],
);

export const secretUseApprovals = pgTable(
  "secret_use_approvals",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    approverSubjectId: text("approver_subject_id").notNull(),
    targets: jsonb("targets").$type<SecretUseApprovalTargetRow[]>().notNull(),
    surface: text("surface").notNull(),
    toolName: text("tool_name").notNull(),
    destination: text("destination"),
    status: text("status")
      .$type<"pending" | "approved" | "denied" | "used" | "revoked">()
      .notNull()
      .default("pending"),
    scope: text("scope").$type<"once" | "session" | "window">(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBySubjectId: text("decided_by_subject_id"),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBySubjectId: text("revoked_by_subject_id"),
  },
  (table) => [
    index("secret_use_approvals_grants_idx")
      .on(table.workspaceId, table.approverSubjectId)
      .where(sql`${table.status} = 'approved'`),
    index("secret_use_approvals_session_idx").on(table.sessionId, table.createdAt.desc()),
  ],
);
