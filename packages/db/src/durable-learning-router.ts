import {
  DurableLearningAttempt,
  DurableLearningReceipt,
  stableJson,
  type DurableLearningAttempt as DurableLearningAttemptType,
  type DurableLearningReceipt as DurableLearningReceiptType,
} from "@opengeni/contracts";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withWorkspaceRls } from "./database";
import * as schema from "./schema";

const DURABLE_LEARNING_CLAIM_LEASE_SECONDS = 120;

export class DurableLearningLedgerConflictError extends Error {
  readonly name = "DurableLearningLedgerConflictError";
  readonly code = "ATTEMPT_REUSED_WITH_DIFFERENT_INPUT" as const;
}

export type DurableLearningAttemptClaims = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

/** Resolve the immutable human behind a live signed agent attempt. */
export async function resolveDurableLearningAttemptAuthority(
  db: Database,
  input: DurableLearningAttemptClaims,
): Promise<{ initiatingHumanSubjectId: string }> {
  if (!Number.isSafeInteger(input.executionGeneration) || input.executionGeneration <= 0) {
    throw new Error("Durable learning attempt requires a positive execution generation");
  }
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = (await scopedDb.execute(sql`
      WITH locked_workspace AS MATERIALIZED (
        SELECT workspace.id, workspace.account_id
        FROM workspaces workspace
        WHERE workspace.id = ${input.workspaceId}::uuid
          AND workspace.account_id = ${input.accountId}::uuid
        FOR KEY SHARE OF workspace
      ), locked_session AS MATERIALIZED (
        SELECT session.id, session.account_id, session.workspace_id, session.active_turn_id
        FROM sessions session
        JOIN locked_workspace workspace
          ON workspace.id = session.workspace_id
          AND workspace.account_id = session.account_id
        WHERE session.id = ${input.sessionId}::uuid
          AND session.active_turn_id = ${input.turnId}::uuid
        FOR SHARE OF session
      ), locked_turn AS MATERIALIZED (
        SELECT turn.id, turn.account_id, turn.workspace_id, turn.session_id,
          turn.active_attempt_id, turn.execution_generation,
          coalesce(
            turn.initiating_human_subject_id,
            case when turn.initiator_kind = 'subject' then turn.initiator_subject_id end
          ) as initiating_human_subject_id
        FROM session_turns turn
        JOIN locked_session session
          ON session.id = turn.session_id
          AND session.workspace_id = turn.workspace_id
          AND session.account_id = turn.account_id
        WHERE turn.id = ${input.turnId}::uuid
          AND turn.active_attempt_id = ${input.attemptId}::uuid
          AND turn.execution_generation = ${input.executionGeneration}
          AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
          AND length(btrim(coalesce(
            turn.initiating_human_subject_id,
            case when turn.initiator_kind = 'subject' then turn.initiator_subject_id end
          ))) BETWEEN 1 AND 1024
        FOR SHARE OF turn
      ), locked_attempt AS MATERIALIZED (
        SELECT attempt.id, attempt.account_id, attempt.workspace_id,
          attempt.session_id, attempt.turn_id, attempt.execution_generation
        FROM session_turn_attempts attempt
        JOIN locked_turn turn
          ON turn.id = attempt.turn_id
          AND turn.session_id = attempt.session_id
          AND turn.workspace_id = attempt.workspace_id
          AND turn.account_id = attempt.account_id
        WHERE attempt.id = ${input.attemptId}::uuid
          AND attempt.execution_generation = ${input.executionGeneration}
          AND attempt.state IN ('claimed', 'running')
          AND NOT EXISTS (
            SELECT 1
            FROM session_attempt_interruptions interruption
            WHERE interruption.workspace_id = attempt.workspace_id
              AND interruption.attempt_id = attempt.id
              AND interruption.state IN ('pending', 'delivered', 'acknowledged')
          )
        FOR SHARE OF attempt
      )
      SELECT turn.initiating_human_subject_id
      FROM locked_workspace workspace
      JOIN locked_session session ON true
      JOIN locked_turn turn ON true
      JOIN locked_attempt attempt ON true
      WHERE workspace.account_id = attempt.account_id
        AND workspace.id = attempt.workspace_id
        AND session.id = attempt.session_id
        AND turn.id = attempt.turn_id
    `)) as unknown as Array<{ initiating_human_subject_id: string }>;
    const initiatingHumanSubjectId = rows[0]?.initiating_human_subject_id;
    if (!initiatingHumanSubjectId) {
      throw new Error(
        "Durable learning requires the exact current attempt, generation, and immutable human initiator",
      );
    }
    return { initiatingHumanSubjectId };
  });
}

type AttemptRow = typeof schema.durableLearningAttempts.$inferSelect;
type ReceiptRow = typeof schema.durableLearningReceipts.$inferSelect;

function attemptFromRow(row: AttemptRow): DurableLearningAttemptType {
  return DurableLearningAttempt.parse({
    id: row.id,
    contractVersion: row.contractVersion,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    inputHash: row.inputHash,
    request: row.request,
    actor: { kind: row.actorKind, subjectId: row.actorSubjectId },
    initiatingHumanSubjectId: row.initiatingHumanSubjectId,
    sessionId: row.sessionId,
    createdAt: row.createdAt.toISOString(),
  });
}

function receiptFromRow(row: ReceiptRow): DurableLearningReceiptType {
  return DurableLearningReceipt.parse(row.receipt);
}

async function attemptAndReceipt(
  db: Database,
  attemptId: string,
): Promise<{
  attempt: DurableLearningAttemptType;
  receipt: DurableLearningReceiptType | null;
} | null> {
  const [row] = await db
    .select({
      attempt: schema.durableLearningAttempts,
      receipt: schema.durableLearningReceipts,
    })
    .from(schema.durableLearningAttempts)
    .leftJoin(
      schema.durableLearningReceipts,
      and(
        eq(schema.durableLearningReceipts.accountId, schema.durableLearningAttempts.accountId),
        eq(schema.durableLearningReceipts.workspaceId, schema.durableLearningAttempts.workspaceId),
        eq(schema.durableLearningReceipts.attemptId, schema.durableLearningAttempts.id),
      ),
    )
    .where(eq(schema.durableLearningAttempts.id, attemptId))
    .limit(1);
  if (!row) return null;
  return {
    attempt: attemptFromRow(row.attempt),
    receipt: row.receipt ? receiptFromRow(row.receipt) : null,
  };
}

/**
 * Postgres implementation of the core router's structural attempt-ledger port.
 * The interface is intentionally structural so @opengeni/db does not import
 * @opengeni/core and create a package cycle.
 */
export function createDurableLearningAttemptLedger(db: Database) {
  return {
    async reserveAttempt(attempt: DurableLearningAttemptType) {
      const parsed = DurableLearningAttempt.parse(attempt);
      return await withWorkspaceRls(db, parsed.workspaceId, async (scopedDb) => {
        return await scopedDb.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`durable-learning:${parsed.accountId}:${parsed.workspaceId}:${parsed.id}`}, 0::bigint))`,
          );
          const existing = await attemptAndReceipt(tx, parsed.id);
          if (existing) {
            if (existing.attempt.inputHash !== parsed.inputHash) {
              throw new DurableLearningLedgerConflictError(
                "Durable-learning attempt id was reused with different immutable input",
              );
            }
            if (existing.receipt) {
              return { ...existing, claimId: null };
            }
          } else {
            await tx.insert(schema.durableLearningAttempts).values({
              id: parsed.id,
              accountId: parsed.accountId,
              workspaceId: parsed.workspaceId,
              contractVersion: parsed.contractVersion,
              operation: parsed.request.operation,
              origin: parsed.request.origin,
              inputHash: parsed.inputHash,
              request: parsed.request,
              actorKind: parsed.actor.kind,
              actorSubjectId: parsed.actor.subjectId,
              initiatingHumanSubjectId: parsed.initiatingHumanSubjectId,
              sessionId: parsed.sessionId,
              createdAt: new Date(parsed.createdAt),
            });
          }

          const claimId = randomUUID();
          const [claim] = await rawRows<{ claim_id: string }>(
            tx,
            sql`
              INSERT INTO durable_learning_attempt_claims (
                account_id, workspace_id, attempt_id, claim_id, claimed_at, expires_at
              ) VALUES (
                ${parsed.accountId}::uuid,
                ${parsed.workspaceId}::uuid,
                ${parsed.id}::uuid,
                ${claimId}::uuid,
                now(),
                now() + make_interval(secs => ${DURABLE_LEARNING_CLAIM_LEASE_SECONDS})
              )
              ON CONFLICT (account_id, workspace_id, attempt_id) DO UPDATE SET
                claim_id = excluded.claim_id,
                claimed_at = excluded.claimed_at,
                expires_at = excluded.expires_at
              WHERE durable_learning_attempt_claims.expires_at <= now()
              RETURNING claim_id
            `,
          );
          return {
            attempt: existing?.attempt ?? parsed,
            receipt: null,
            claimId: claim?.claim_id ?? null,
          };
        });
      });
    },

    async renewAttemptClaim(attempt: DurableLearningAttemptType, claimId: string) {
      const parsed = DurableLearningAttempt.parse(attempt);
      return await withWorkspaceRls(db, parsed.workspaceId, async (scopedDb) => {
        const renewed = await scopedDb
          .update(schema.durableLearningAttemptClaims)
          .set({
            expiresAt: sql`now() + make_interval(secs => ${DURABLE_LEARNING_CLAIM_LEASE_SECONDS})`,
          })
          .where(
            and(
              eq(schema.durableLearningAttemptClaims.accountId, parsed.accountId),
              eq(schema.durableLearningAttemptClaims.workspaceId, parsed.workspaceId),
              eq(schema.durableLearningAttemptClaims.attemptId, parsed.id),
              eq(schema.durableLearningAttemptClaims.claimId, claimId),
            ),
          )
          .returning({ claimId: schema.durableLearningAttemptClaims.claimId });
        return renewed.length === 1;
      });
    },

    async completeAttempt(
      attempt: DurableLearningAttemptType,
      receipt: DurableLearningReceiptType,
      claimId: string,
    ) {
      const parsedAttempt = DurableLearningAttempt.parse(attempt);
      const parsedReceipt = DurableLearningReceipt.parse(receipt);
      if (
        parsedReceipt.attemptId !== parsedAttempt.id ||
        parsedReceipt.inputHash !== parsedAttempt.inputHash
      ) {
        throw new DurableLearningLedgerConflictError(
          "Durable-learning receipt does not match its immutable attempt",
        );
      }
      return await withWorkspaceRls(db, parsedAttempt.workspaceId, async (scopedDb) => {
        return await scopedDb.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`durable-learning:${parsedAttempt.accountId}:${parsedAttempt.workspaceId}:${parsedAttempt.id}`}, 0::bigint))`,
          );
          const existing = await attemptAndReceipt(tx, parsedAttempt.id);
          if (!existing || existing.attempt.inputHash !== parsedAttempt.inputHash) {
            throw new DurableLearningLedgerConflictError(
              "Durable-learning receipt lost its immutable attempt",
            );
          }
          if (existing.receipt) {
            if (stableJson(existing.receipt) !== stableJson(parsedReceipt)) {
              throw new DurableLearningLedgerConflictError(
                "Durable-learning attempt already has a different terminal receipt",
              );
            }
            return existing.receipt;
          }
          const [claim] = await tx
            .select({ claimId: schema.durableLearningAttemptClaims.claimId })
            .from(schema.durableLearningAttemptClaims)
            .where(
              and(
                eq(schema.durableLearningAttemptClaims.accountId, parsedAttempt.accountId),
                eq(schema.durableLearningAttemptClaims.workspaceId, parsedAttempt.workspaceId),
                eq(schema.durableLearningAttemptClaims.attemptId, parsedAttempt.id),
                eq(schema.durableLearningAttemptClaims.claimId, claimId),
              ),
            )
            .limit(1);
          if (!claim) {
            throw new DurableLearningLedgerConflictError(
              "Durable-learning terminal receipt lost its execution claim",
            );
          }
          const [created] = await tx
            .insert(schema.durableLearningReceipts)
            .values({
              accountId: parsedAttempt.accountId,
              workspaceId: parsedAttempt.workspaceId,
              attemptId: parsedAttempt.id,
              inputHash: parsedAttempt.inputHash,
              outcome: parsedReceipt.outcome,
              destination: parsedReceipt.decision.destination,
              resourceId: parsedReceipt.resource?.id ?? null,
              receipt: parsedReceipt,
              createdAt: new Date(parsedReceipt.createdAt),
            })
            .returning();
          if (!created) throw new Error("Durable-learning receipt was not recorded");
          await tx
            .delete(schema.durableLearningAttemptClaims)
            .where(
              and(
                eq(schema.durableLearningAttemptClaims.accountId, parsedAttempt.accountId),
                eq(schema.durableLearningAttemptClaims.workspaceId, parsedAttempt.workspaceId),
                eq(schema.durableLearningAttemptClaims.attemptId, parsedAttempt.id),
                eq(schema.durableLearningAttemptClaims.claimId, claimId),
              ),
            );
          return receiptFromRow(created);
        });
      });
    },

    async getCompletedAttempt(accountId: string, workspaceId: string, attemptId: string) {
      return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
        const resolved = await attemptAndReceipt(scopedDb, attemptId);
        if (
          !resolved ||
          resolved.receipt === null ||
          resolved.attempt.accountId !== accountId ||
          resolved.attempt.workspaceId !== workspaceId
        ) {
          return null;
        }
        return { attempt: resolved.attempt, receipt: resolved.receipt };
      });
    },
  };
}
