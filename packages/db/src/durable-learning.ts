import { createHash } from "node:crypto";
import {
  DurableLearningAttemptReceipt,
  DurableLearningExecutionAuthority,
  DurableLearningRouteDecision,
  canonicalDurableLearningInput,
  type DurableLearningAttemptReceipt as DurableLearningAttemptReceiptType,
  type DurableLearningExecutionAuthority as DurableLearningExecutionAuthorityType,
  type DurableLearningRouteDecision as DurableLearningRouteDecisionType,
} from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext } from "./database";
import { runIdempotentPersistenceTransaction } from "./persistence-errors";
import * as schema from "./schema";

export class DurableLearningAttemptAuthorityError extends Error {
  readonly code = "DURABLE_LEARNING_ATTEMPT_REJECTED";
  readonly name = "DurableLearningAttemptAuthorityError";
}

export class DurableLearningAttemptReuseError extends Error {
  readonly code = "DURABLE_LEARNING_ATTEMPT_REUSED";
  readonly name = "DurableLearningAttemptReuseError";
}

export type DurableLearningLedgerRequest = Record<string, unknown> & {
  operation: "write" | "rollback";
  attemptId: string;
  targetSurface: "company_profile" | "workspace_instruction_policy" | "preference_registry";
};

export type DurableLearningAttemptAdmission = {
  id: string;
  inputHash: string;
  initiatingHumanSubjectId: string;
  authority: DurableLearningExecutionAuthorityType;
  request: DurableLearningLedgerRequest;
  decision: DurableLearningRouteDecisionType;
};

export type DurableLearningAuthorityResult = Pick<
  DurableLearningAttemptReceiptType,
  "outcome" | "resource" | "effectiveBoundary" | "rollback"
>;

function nestedSqlState(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string" && /^[0-9A-Z]{5}$/.test(record.code)) return record.code;
    current = record.cause;
  }
  return null;
}

function translateAttemptError(error: unknown): never {
  const state = nestedSqlState(error);
  if (state === "23505") {
    throw new DurableLearningAttemptReuseError(
      "Durable-learning attempt id already identifies different immutable input",
    );
  }
  if (state === "42501") {
    throw new DurableLearningAttemptAuthorityError(
      "Durable-learning requires the exact current accepted attempt and authorized initiating human",
    );
  }
  throw error;
}

export async function runDurableLearningAttempt(
  db: Database,
  input: {
    operationId: string;
    authority: DurableLearningExecutionAuthorityType;
    request: DurableLearningLedgerRequest;
    decision: DurableLearningRouteDecisionType;
  },
  apply: (
    db: Database,
    admission: DurableLearningAttemptAdmission,
  ) => Promise<DurableLearningAuthorityResult>,
): Promise<DurableLearningAttemptReceiptType> {
  const authority = DurableLearningExecutionAuthority.parse(input.authority);
  const decision = DurableLearningRouteDecision.parse(input.decision);
  const canonicalInput = canonicalDurableLearningInput({
    operationId: input.operationId,
    authority,
    request: input.request,
    decision,
  });
  const inputHash = createHash("sha256").update(canonicalInput, "utf8").digest("hex");
  try {
    return await runIdempotentPersistenceTransaction(
      {
        stage: "durable_learning_attempt",
        eventTypes: [input.request.targetSurface, input.request.operation],
        correlationId: input.operationId,
      },
      async () =>
        await withRlsContext(
          db,
          { accountId: authority.accountId, workspaceId: authority.workspaceId },
          async (scopedDb) => {
            const beginRows = (await scopedDb.execute(sql`
          SELECT initiating_human_subject_id AS "initiatingHumanSubjectId",
            existing_receipt AS "existingReceipt"
          FROM durable_learning_begin_attempt(
            ${input.operationId}::uuid,
            ${authority.accountId}::uuid,
            ${authority.workspaceId}::uuid,
            ${authority.sessionId}::uuid,
            ${authority.turnId}::uuid,
            ${authority.attemptId}::uuid,
            ${authority.executionGeneration}::integer,
            ${input.request.operation},
            ${input.request.targetSurface},
            ${canonicalInput},
            ${inputHash},
            ${JSON.stringify(input.request)}::jsonb,
            ${JSON.stringify(decision)}::jsonb
          )
            `)) as unknown as Array<{
              initiatingHumanSubjectId: string;
              existingReceipt: unknown | null;
            }>;
            const begun = beginRows[0];
            if (!begun)
              throw new DurableLearningAttemptAuthorityError("Attempt admission returned no row");
            if (begun.existingReceipt !== null) {
              return DurableLearningAttemptReceipt.parse(begun.existingReceipt);
            }
            const result = await apply(scopedDb, {
              id: input.operationId,
              inputHash,
              initiatingHumanSubjectId: begun.initiatingHumanSubjectId,
              authority,
              request: input.request,
              decision,
            });
            const completeRows = (await scopedDb.execute(sql`
          SELECT receipt
          FROM durable_learning_complete_attempt(
            ${input.operationId}::uuid,
            ${inputHash},
            ${JSON.stringify(result)}::jsonb
          )
            `)) as unknown as Array<{ receipt: unknown }>;
            return DurableLearningAttemptReceipt.parse(completeRows[0]?.receipt);
          },
          { isolationLevel: "read committed" },
        ),
    );
  } catch (error) {
    translateAttemptError(error);
  }
}

export async function getDurableLearningAttemptWithReceipt(
  db: Database,
  input: { accountId: string; workspaceId: string; attemptId: string },
): Promise<{
  initiatingHumanSubjectId: string;
  decision: DurableLearningRouteDecisionType;
  receipt: DurableLearningAttemptReceiptType;
} | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select({
          initiatingHumanSubjectId: schema.durableLearningAttempts.initiatingHumanSubjectId,
          decision: schema.durableLearningAttempts.decision,
          receipt: schema.durableLearningAttemptReceipts.receipt,
        })
        .from(schema.durableLearningAttempts)
        .innerJoin(
          schema.durableLearningAttemptReceipts,
          and(
            eq(schema.durableLearningAttemptReceipts.attemptId, schema.durableLearningAttempts.id),
            eq(
              schema.durableLearningAttemptReceipts.workspaceId,
              schema.durableLearningAttempts.workspaceId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.durableLearningAttempts.accountId, input.accountId),
            eq(schema.durableLearningAttempts.workspaceId, input.workspaceId),
            eq(schema.durableLearningAttempts.id, input.attemptId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        initiatingHumanSubjectId: row.initiatingHumanSubjectId,
        decision: DurableLearningRouteDecision.parse(row.decision),
        receipt: DurableLearningAttemptReceipt.parse(row.receipt),
      };
    },
  );
}
