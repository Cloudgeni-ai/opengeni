import { z } from "zod";
import type postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle, PostgresJsSession, PostgresJsTransaction } from "drizzle-orm/postgres-js";
import { withRestoredSessionActivityRlsContext, type Database } from "./database";
import { failSessionWorkBeforeAttemptClaim } from "./index";
import * as schema from "./schema";

export const INTERRUPTED_TURN_RETIREMENT_MARKER = "-- OPENGENI_INTERRUPTED_TURN_RETIREMENT_STAGE";
export const INTERRUPTED_TURN_RETIREMENT_MIGRATION = "0764_interrupted_turn_recovery.sql";

const manifestSchema = z.object({
  operationId: z.uuid(),
  targets: z.array(z.object({
    accountId: z.uuid(), workspaceId: z.uuid(), sessionId: z.uuid(), turnId: z.uuid(),
    workflowId: z.string().min(1).max(255),
    expectedVersion: z.number().int().positive(),
    expectedLastSequence: z.number().int().positive(),
  }).strict()).min(1).max(1000),
}).strict();
export type InterruptedTurnRetirementManifest = z.infer<typeof manifestSchema>;

/** Operator intent is explicit and private. An ordinary upgrade must never
 * cancel another installation's intentionally resumable paused work. */
export function parseInterruptedTurnRetirementManifest(value: unknown): InterruptedTurnRetirementManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid interrupted-turn retirement manifest");
  if (new Set(parsed.data.targets.map(target => target.sessionId)).size !== parsed.data.targets.length)
    throw new Error("Interrupted-turn retirement targets must name unique sessions");
  return parsed.data;
}

export async function migrateInterruptedTurnRetirement(
  transaction: postgres.TransactionSql,
  value?: InterruptedTurnRetirementManifest,
): Promise<void> {
  if (value === undefined) return;
  const manifest = parseInterruptedTurnRetirementManifest(value);
  // Initialize the driver's supported parsers, then use its exported
  // transaction adapter so canonical helpers use savepoints on THIS migration
  // transaction, not a new connection/transaction. No private driver fields.
  drizzle(transaction);
  const dialect = new PgDialect();
  const session = new PostgresJsSession<postgres.TransactionSql, typeof schema, {}>(transaction, dialect, undefined);
  const db = new PostgresJsTransaction(dialect, session, undefined) as unknown as Database;
  const ordered = [...manifest.targets].sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId) || a.sessionId.localeCompare(b.sessionId));
  for (const target of ordered) {
    await withRestoredSessionActivityRlsContext(db, target, async scoped => {
      const result = await failSessionWorkBeforeAttemptClaim(scoped, target.workspaceId, {
        accountId: target.accountId, sessionId: target.sessionId,
        workflowId: target.workflowId, trigger: {kind: "next"},
        error: "Interrupted work was terminally retired by the operator without replay.",
      }, {
        turnId: target.turnId, expectedVersion: target.expectedVersion,
        expectedLastSequence: target.expectedLastSequence, operationId: manifest.operationId,
      });
      if (result.action !== "failed" || result.turnId !== target.turnId)
        throw new Error("Interrupted-turn retirement target changed or is unsafe");
    });
  }
}
