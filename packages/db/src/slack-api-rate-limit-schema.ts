import { pgTable, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Content-free deployment-global quota: Slack applies it across every token and tenant. */
export const slackApiRateLimits = pgTable(
  "slack_api_rate_limits",
  {
    scopeHash: text("scope_hash").primaryKey(),
    nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    scopeHashValid: check(
      "slack_api_rate_limits_scope_hash_check",
      sql`${table.scopeHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
