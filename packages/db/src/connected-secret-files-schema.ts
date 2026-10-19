import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/** Content-free obligations intentionally survive deletion of their owner. */
export const connectedSecretFileScopes = pgTable(
  "connected_secret_file_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    controlWorkspaceId: uuid("control_workspace_id").notNull(),
    enrollmentId: uuid("enrollment_id").notNull(),
    pubkey: text("pubkey").notNull(),
    connectionInstanceId: text("connection_instance_id").notNull(),
    scope: text("scope").notNull(),
    closeRequestedAt: timestamp("close_requested_at", { withTimezone: true }),
    retryAfter: timestamp("retry_after", { withTimezone: true }).notNull().defaultNow(),
    claimId: uuid("claim_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetScope: unique().on(table.controlWorkspaceId, table.enrollmentId, table.scope),
    due: index("connected_secret_file_scopes_due").on(table.retryAfter),
    attempt: index("connected_secret_file_scopes_attempt").on(table.attemptId),
  }),
);
