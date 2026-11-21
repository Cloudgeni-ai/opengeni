import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Content-free token buckets per connected agent (migration 1530), shared by
 * every API process. FORCE RLS in the organization's account context.
 */
export const mcpConnectionRateLimits = pgTable(
  "mcp_connection_rate_limits",
  {
    // References managed_accounts (cascade) in the migration.
    accountId: uuid("account_id").notNull(),
    scopeHash: text("scope_hash").notNull(),
    tokens: doublePrecision("tokens").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "mcp_connection_rate_limits_pkey",
      columns: [table.accountId, table.scopeHash],
    }),
    scopeHashValid: check(
      "mcp_connection_rate_limits_scope_hash_check",
      sql`${table.scopeHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
