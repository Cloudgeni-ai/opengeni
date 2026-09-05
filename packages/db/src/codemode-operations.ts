import {
  AttemptToolCall,
  AttemptToolResult,
  CODEMODE_ARGUMENTS_MAX_BYTES,
  CODEMODE_CLAIM_LEASE_MS,
  CODEMODE_RESULT_MAX_BYTES,
  CODEMODE_OPERATION_VERSION,
  CodemodeOperation,
  type AttemptToolCall as AttemptToolCallValue,
  type AttemptToolResult as AttemptToolResultValue,
  type CodemodeOperation as CodemodeOperationValue,
} from "@opengeni/contracts";
import {
  digestCodemodeOperationRequest,
  parseVerifiedAttemptToolCatalog,
} from "@opengeni/codemode";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext } from "./database";
import * as schema from "./schema";

export class CodemodeOperationConflictError extends Error {
  readonly code = "codemode_operation_conflict";

  constructor() {
    super("Codemode operation id is already bound to a different request");
    this.name = "CodemodeOperationConflictError";
  }
}

export class CodemodeOperationNotExecutableError extends Error {
  readonly code = "codemode_attempt_not_executable";

  constructor() {
    super("Codemode operation does not belong to the active running execution attempt");
    this.name = "CodemodeOperationNotExecutableError";
  }
}

export class CodemodeToolNotInCatalogError extends Error {
  readonly code = "codemode_tool_not_in_catalog";

  constructor() {
    super("Tool is not present in the exact execution attempt catalog");
    this.name = "CodemodeToolNotInCatalogError";
  }
}

export class CodemodeToolApprovalRequiredError extends Error {
  readonly code = "codemode_tool_approval_required";

  constructor() {
    super("Tool requires human approval and must be invoked through the agent");
    this.name = "CodemodeToolApprovalRequiredError";
  }
}

export class CodemodePayloadTooLargeError extends Error {
  readonly code = "codemode_payload_too_large";

  constructor(kind: "arguments" | "result") {
    super(`Codemode ${kind} exceed the maximum serialized size`);
    this.name = "CodemodePayloadTooLargeError";
  }
}

export type SubmitCodemodeOperationInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  call: AttemptToolCallValue;
};

/**
 * Bind one caller-provided operation id to one exact catalog call. Duplicate
 * submission of identical bytes is free and returns the same row; repurposing
 * the id fails. Admission and insert share one turn lock.
 */
export async function submitCodemodeOperation(
  db: Database,
  input: SubmitCodemodeOperationInput,
): Promise<{ operation: CodemodeOperationValue; created: boolean }> {
  const call = AttemptToolCall.parse(input.call);
  if (call.caller.kind !== "codemode") throw new CodemodeOperationNotExecutableError();
  assertJsonBytes(call.arguments, CODEMODE_ARGUMENTS_MAX_BYTES, "arguments");
  const requestDigest = digestCodemodeOperationRequest(call);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        // Serialize the caller-owned id before testing for an existing row.
        // Without this fence, two first submissions can both observe absence
        // and the later insert fails its unique constraint instead of replaying.
        await tx.execute(sql`
          select pg_advisory_xact_lock(
            hashtextextended(${`codemode-operation:${input.workspaceId}:${call.operationId}`}, 0)
          )
        `);
        const [existing] = await tx
          .select()
          .from(schema.sessionAttemptCodemodeCalls)
          .where(eq(schema.sessionAttemptCodemodeCalls.operationId, call.operationId))
          .for("update")
          .limit(1);
        if (existing) {
          assertExistingRequest(existing, input, requestDigest);
          return { operation: mapOperation(existing), created: false };
        }

        const [turn] = await tx
          .select({
            accountId: schema.sessionTurns.accountId,
            sessionId: schema.sessionTurns.sessionId,
            status: schema.sessionTurns.status,
            activeAttemptId: schema.sessionTurns.activeAttemptId,
            executionGeneration: schema.sessionTurns.executionGeneration,
          })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          !turn ||
          turn.accountId !== input.accountId ||
          turn.sessionId !== input.sessionId ||
          turn.status !== "running" ||
          turn.activeAttemptId !== input.attemptId ||
          turn.executionGeneration !== input.executionGeneration
        ) {
          throw new CodemodeOperationNotExecutableError();
        }

        const [catalogRow] = await tx
          .select({ catalog: schema.sessionAttemptToolCatalogs.catalog })
          .from(schema.sessionAttemptToolCatalogs)
          .where(
            and(
              eq(schema.sessionAttemptToolCatalogs.attemptId, input.attemptId),
              eq(schema.sessionAttemptToolCatalogs.digest, call.catalogDigest),
            ),
          )
          .limit(1);
        if (!catalogRow) throw new CodemodeOperationNotExecutableError();
        const catalog = parseVerifiedAttemptToolCatalog(catalogRow.catalog);
        if (
          catalog.accountId !== input.accountId ||
          catalog.workspaceId !== input.workspaceId ||
          catalog.sessionId !== input.sessionId ||
          catalog.turnId !== input.turnId ||
          catalog.attemptId !== input.attemptId ||
          catalog.executionGeneration !== input.executionGeneration
        ) {
          throw new CodemodeOperationNotExecutableError();
        }
        const catalogEntry = catalog.entries.find(
          (entry) =>
            entry.identity.serverId === call.identity.serverId &&
            entry.identity.toolName === call.identity.toolName,
        );
        if (!catalogEntry) {
          throw new CodemodeToolNotInCatalogError();
        }
        if (catalogEntry.approval === "human") {
          throw new CodemodeToolApprovalRequiredError();
        }

        const [created] = await tx
          .insert(schema.sessionAttemptCodemodeCalls)
          .values({
            operationId: call.operationId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            attemptId: input.attemptId,
            executionGeneration: input.executionGeneration,
            catalogDigest: call.catalogDigest,
            requestDigest,
            serverId: call.identity.serverId,
            toolName: call.identity.toolName,
            arguments: call.arguments,
            callerSubjectId: call.caller.subjectId,
          })
          .returning();
        if (!created) throw new Error("Failed to create Codemode operation");
        return { operation: mapOperation(created), created: true };
      }),
  );
}

export async function getCodemodeOperation(
  db: Database,
  input: { accountId: string; workspaceId: string; attemptId: string; operationId: string },
): Promise<CodemodeOperationValue | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.sessionAttemptCodemodeCalls)
        .where(
          and(
            eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
            eq(schema.sessionAttemptCodemodeCalls.attemptId, input.attemptId),
          ),
        )
        .limit(1);
      return row ? mapOperation(row) : null;
    },
  );
}

export type ClaimCodemodeOperationResult =
  | {
      status: "claimed";
      operation: CodemodeOperationValue;
      claimId: string;
      reclaimed: boolean;
    }
  | { status: "execution_owner_lost"; operation: CodemodeOperationValue; claimId: string }
  | { status: "already_running" | "terminal"; operation: CodemodeOperationValue }
  | { status: "rejected"; operation: CodemodeOperationValue | null };

/** Exactly one worker may cross the side-effect boundary for an operation. */
export async function claimCodemodeOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    catalogDigest: string;
    operationId: string;
    claimId: string;
    now?: Date;
    claimLeaseMs?: number;
  },
): Promise<ClaimCodemodeOperationResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        let [row] = await tx
          .select()
          .from(schema.sessionAttemptCodemodeCalls)
          .where(eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId))
          .for("update")
          .limit(1);
        if (!row || !operationMatchesAuthority(row, input)) {
          return { status: "rejected", operation: row ? mapOperation(row) : null };
        }
        const now = input.now ?? new Date();
        const claimExpiresAt = new Date(now.getTime() + boundedClaimLeaseMs(input.claimLeaseMs));
        let reclaimed = false;
        if (row.state === "running") {
          if (!row.claimExpiresAt || row.claimExpiresAt.getTime() > now.getTime()) {
            return { status: "already_running", operation: mapOperation(row) };
          }
          if (row.executionStartedAt) {
            if (!row.claimId) {
              throw new Error("Codemode running operation is missing its claim id");
            }
            return {
              status: "execution_owner_lost",
              operation: mapOperation(row),
              claimId: row.claimId,
            };
          }
          const [requeued] = await tx
            .update(schema.sessionAttemptCodemodeCalls)
            .set({
              state: "queued",
              claimId: null,
              claimedAt: null,
              claimExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
                eq(schema.sessionAttemptCodemodeCalls.state, "running"),
                eq(schema.sessionAttemptCodemodeCalls.claimId, row.claimId!),
              ),
            )
            .returning();
          if (!requeued) throw new Error("Codemode expired claim recovery lost its row lock");
          row = requeued;
          reclaimed = true;
        }
        if (isTerminalState(row.state)) return { status: "terminal", operation: mapOperation(row) };

        const [turn] = await tx
          .select({
            status: schema.sessionTurns.status,
            activeAttemptId: schema.sessionTurns.activeAttemptId,
            executionGeneration: schema.sessionTurns.executionGeneration,
          })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          !turn ||
          turn.status !== "running" ||
          turn.activeAttemptId !== input.attemptId ||
          turn.executionGeneration !== input.executionGeneration
        ) {
          const [cancelled] = await tx
            .update(schema.sessionAttemptCodemodeCalls)
            .set({
              state: "cancelled",
              errorCode: "attempt_not_executable",
              errorMessage: "Execution attempt ended before the Codemode call started",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
                eq(schema.sessionAttemptCodemodeCalls.state, "queued"),
              ),
            )
            .returning();
          return { status: "terminal", operation: mapOperation(cancelled ?? row) };
        }
        const [claimed] = await tx
          .update(schema.sessionAttemptCodemodeCalls)
          .set({
            state: "running",
            claimId: input.claimId,
            claimedAt: now,
            claimExpiresAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
              eq(schema.sessionAttemptCodemodeCalls.state, "queued"),
            ),
          )
          .returning();
        if (!claimed) throw new Error("Codemode operation claim lost its row lock");
        return {
          status: "claimed",
          operation: mapOperation(claimed),
          claimId: input.claimId,
          reclaimed,
        };
      }),
  );
}

/** Durable side-effect boundary. A stale claim before this marker may be retried. */
export async function markCodemodeOperationExecutionStarted(
  db: Database,
  input: CodemodeCompletionAuthority & { now?: Date; claimLeaseMs?: number },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = input.now ?? new Date();
      const rows = await scopedDb
        .update(schema.sessionAttemptCodemodeCalls)
        .set({
          executionStartedAt: sql`coalesce(${schema.sessionAttemptCodemodeCalls.executionStartedAt}, now())`,
          claimExpiresAt: new Date(now.getTime() + boundedClaimLeaseMs(input.claimLeaseMs)),
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
            eq(schema.sessionAttemptCodemodeCalls.attemptId, input.attemptId),
            eq(schema.sessionAttemptCodemodeCalls.state, "running"),
            eq(schema.sessionAttemptCodemodeCalls.claimId, input.claimId),
          ),
        )
        .returning({ id: schema.sessionAttemptCodemodeCalls.operationId });
      return rows.length === 1;
    },
  );
}

export async function renewCodemodeOperationClaim(
  db: Database,
  input: CodemodeCompletionAuthority & { now?: Date; claimLeaseMs?: number },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = input.now ?? new Date();
      const rows = await scopedDb
        .update(schema.sessionAttemptCodemodeCalls)
        .set({
          claimExpiresAt: new Date(now.getTime() + boundedClaimLeaseMs(input.claimLeaseMs)),
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
            eq(schema.sessionAttemptCodemodeCalls.attemptId, input.attemptId),
            eq(schema.sessionAttemptCodemodeCalls.state, "running"),
            eq(schema.sessionAttemptCodemodeCalls.claimId, input.claimId),
          ),
        )
        .returning({ id: schema.sessionAttemptCodemodeCalls.operationId });
      return rows.length === 1;
    },
  );
}

export async function completeCodemodeOperation(
  db: Database,
  input: CodemodeCompletionAuthority & { result: AttemptToolResultValue },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await completeCodemodeOperationInTransaction(scopedDb, input),
  );
}

/** Internal transaction primitive used when the terminal timeline event must commit atomically. */
export async function completeCodemodeOperationInTransaction(
  tx: Database,
  input: CodemodeCompletionAuthority & { result: AttemptToolResultValue },
): Promise<boolean> {
  const result = AttemptToolResult.parse(input.result);
  assertJsonBytes(result, CODEMODE_RESULT_MAX_BYTES, "result");
  return await settleClaimedCodemodeOperationInTransaction(tx, input, {
    state: "completed",
    result,
    errorCode: null,
    errorMessage: null,
  });
}

export async function failCodemodeOperation(
  db: Database,
  input: CodemodeCompletionAuthority & {
    state: "failed" | "outcome_unknown";
    errorCode: string;
    errorMessage: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await failCodemodeOperationInTransaction(scopedDb, input),
  );
}

/** Internal transaction primitive used when the terminal timeline event must commit atomically. */
export async function failCodemodeOperationInTransaction(
  tx: Database,
  input: CodemodeCompletionAuthority & {
    state: "failed" | "outcome_unknown";
    errorCode: string;
    errorMessage: string;
  },
): Promise<boolean> {
  return await settleClaimedCodemodeOperationInTransaction(tx, input, {
    state: input.state,
    result: null,
    errorCode: boundedText(input.errorCode, 128),
    errorMessage: boundedText(input.errorMessage, 4_096),
  });
}

export async function cancelQueuedCodemodeOperationsForAttempt(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    attemptId: string;
    reason: string;
  },
): Promise<number> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = new Date();
      const rows = await scopedDb
        .update(schema.sessionAttemptCodemodeCalls)
        .set({
          state: "cancelled",
          errorCode: "attempt_ended",
          errorMessage: boundedText(input.reason, 4_096),
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessionAttemptCodemodeCalls.attemptId, input.attemptId),
            eq(schema.sessionAttemptCodemodeCalls.state, "queued"),
          ),
        )
        .returning({ id: schema.sessionAttemptCodemodeCalls.operationId });
      return rows.length;
    },
  );
}

type CodemodeCompletionAuthority = {
  accountId: string;
  workspaceId: string;
  attemptId: string;
  operationId: string;
  claimId: string;
};

async function settleClaimedCodemodeOperationInTransaction(
  tx: Database,
  input: CodemodeCompletionAuthority,
  settlement: {
    state: "completed" | "failed" | "outcome_unknown";
    result: AttemptToolResultValue | null;
    errorCode: string | null;
    errorMessage: string | null;
  },
): Promise<boolean> {
  const now = new Date();
  const rows = await tx
    .update(schema.sessionAttemptCodemodeCalls)
    .set({ ...settlement, completedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.sessionAttemptCodemodeCalls.operationId, input.operationId),
        eq(schema.sessionAttemptCodemodeCalls.attemptId, input.attemptId),
        eq(schema.sessionAttemptCodemodeCalls.state, "running"),
        eq(schema.sessionAttemptCodemodeCalls.claimId, input.claimId),
      ),
    )
    .returning({ id: schema.sessionAttemptCodemodeCalls.operationId });
  return rows.length === 1;
}

function assertExistingRequest(
  row: typeof schema.sessionAttemptCodemodeCalls.$inferSelect,
  input: SubmitCodemodeOperationInput,
  requestDigest: string,
): void {
  if (
    row.accountId !== input.accountId ||
    row.workspaceId !== input.workspaceId ||
    row.sessionId !== input.sessionId ||
    row.turnId !== input.turnId ||
    row.attemptId !== input.attemptId ||
    row.executionGeneration !== input.executionGeneration ||
    row.catalogDigest !== input.call.catalogDigest ||
    row.requestDigest !== requestDigest
  ) {
    throw new CodemodeOperationConflictError();
  }
}

function operationMatchesAuthority(
  row: typeof schema.sessionAttemptCodemodeCalls.$inferSelect,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    catalogDigest: string;
  },
): boolean {
  return (
    row.accountId === input.accountId &&
    row.workspaceId === input.workspaceId &&
    row.sessionId === input.sessionId &&
    row.turnId === input.turnId &&
    row.attemptId === input.attemptId &&
    row.executionGeneration === input.executionGeneration &&
    row.catalogDigest === input.catalogDigest
  );
}

function mapOperation(
  row: typeof schema.sessionAttemptCodemodeCalls.$inferSelect,
): CodemodeOperationValue {
  return CodemodeOperation.parse({
    version: CODEMODE_OPERATION_VERSION,
    operationId: row.operationId,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    attemptId: row.attemptId,
    executionGeneration: row.executionGeneration,
    catalogDigest: row.catalogDigest,
    requestDigest: row.requestDigest,
    identity: { serverId: row.serverId, toolName: row.toolName },
    arguments: row.arguments,
    caller: { kind: "codemode", subjectId: row.callerSubjectId },
    state: row.state,
    result: row.result,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    claimedAt: row.claimedAt?.toISOString() ?? null,
    executionStartedAt: row.executionStartedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function isTerminalState(state: string): boolean {
  return ["completed", "failed", "outcome_unknown", "cancelled"].includes(state);
}

function assertJsonBytes(value: unknown, maximum: number, kind: "arguments" | "result"): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) {
    throw new CodemodePayloadTooLargeError(kind);
  }
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.trim() || "Codemode operation failed";
  return normalized.length <= maximum ? normalized : normalized.slice(0, maximum);
}

function boundedClaimLeaseMs(value: number | undefined): number {
  const candidate = value ?? CODEMODE_CLAIM_LEASE_MS;
  if (!Number.isSafeInteger(candidate) || candidate < 1_000 || candidate > 10 * 60_000) {
    throw new Error("Codemode claim lease must be between 1 second and 10 minutes");
  }
  return candidate;
}
