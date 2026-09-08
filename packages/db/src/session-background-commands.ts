import type {
  SessionBackgroundCommand,
  SessionBackgroundCommandActivity,
} from "@opengeni/contracts";
import { SessionCommandFailure } from "@opengeni/contracts";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";

import type { Database, SessionActivityDatabase } from "./database";
import { withRlsContext, withSessionActivityRlsContext } from "./database";
import * as schema from "./schema";
import { lockSessionEventWriteRows } from "./session-control";
import { fromPostgresLosslessJson } from "./lossless-json";

export type ConnectedMachineBackgroundCommandProof = {
  outcome: "exited" | "lost";
  exitCode: number | null;
  reason: string;
  failure?: SessionCommandFailure;
  observedAt: Date;
};

export const SESSION_BACKGROUND_COMMAND_REASON_MAX_BYTES = 512;

export function boundedSessionBackgroundCommandReason(value: string, label: string): string {
  const normalized = value.trim();
  let bounded = "";
  let bytes = 0;
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > SESSION_BACKGROUND_COMMAND_REASON_MAX_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  if (!bounded) throw new Error(`${label} must not be empty`);
  return bounded;
}

export type SessionBackgroundCommandTerminalMutation = {
  prepare: (tx: SessionActivityDatabase) => Promise<void>;
  commit: (tx: SessionActivityDatabase, command: SessionBackgroundCommand) => Promise<void>;
};

export type ConnectedMachineBackgroundCommandClaim = {
  commandId: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  claimId: string;
  state: "running" | "stopping";
  controlWorkspaceId: string;
  enrollmentId: string;
  connectionInstanceId: string;
  opId: string;
  reconcileAttempts: number;
  proof: ConnectedMachineBackgroundCommandProof | null;
};

type ConnectedMachineBackgroundCommandClaimRow = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  commandId: string;
  claimId: string;
  commandState: string;
  controlWorkspaceId: string;
  enrollmentId: string;
  connectionInstanceId: string;
  opId: string;
  reconcileAttempts: number | string;
  reconcileProofOutcome: string | null;
  reconcileProofExitCode: number | string | null;
  reconcileProofReason: string | null;
  reconcileProofObservedAt: Date | string | null;
};

function commandPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return Array.from(normalized).slice(0, 512).join("");
}

function mapCommand(
  row: typeof schema.sessionBackgroundCommands.$inferSelect,
): SessionBackgroundCommand {
  const terminal = row.state === "exited" || row.state === "lost";
  const legacyFailureCode =
    row.provider === "connected_machine"
      ? /^op_failure_([A-Za-z0-9_-]{1,128})$/.exec(row.settlementReason ?? "")?.[1]
      : undefined;
  // Application writes validate exact detail bounds. Older/restored rows may
  // meet the wider storage envelope without meeting that contract: preserve
  // failure truth and readable output rather than throwing on every read.
  const storedFailure = row.runnerFailure
    ? SessionCommandFailure.safeParse(row.runnerFailure)
    : null;
  const failure = !terminal
    ? undefined
    : row.runnerFailure
      ? storedFailure?.success
        ? storedFailure.data
        : {
            code: /^[A-Za-z0-9_-]{1,128}$/.test(row.runnerFailure.code)
              ? row.runnerFailure.code
              : "INVALID_RUNNER_FAILURE",
            detail: {
              metadata_error: "Stored runner failure details do not match the retained contract.",
            },
            retryable: false as const,
          }
      : legacyFailureCode
        ? { code: legacyFailureCode, retryable: false as const }
        : undefined;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    provider: row.provider,
    state: row.state,
    commandPreview: row.commandPreview,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    exitCode: row.exitCode ?? null,
    settlementReason: row.settlementReason ?? null,
    ...(failure ? { failure } : {}),
    startedAt: row.startedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    completionObservedAt: row.completionObservedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function backgroundCommandActivityForSessions(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionIds: string[] },
): Promise<Map<string, SessionBackgroundCommandActivity>> {
  if (input.sessionIds.length === 0) return new Map();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select({
          sessionId: schema.sessionBackgroundCommands.sessionId,
          count: sql<number>`count(*)::int`,
          stoppingCount: sql<number>`count(*) filter (where ${schema.sessionBackgroundCommands.state} = 'stopping')::int`,
        })
        .from(schema.sessionBackgroundCommands)
        .where(
          and(
            eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
            inArray(schema.sessionBackgroundCommands.sessionId, input.sessionIds),
            inArray(schema.sessionBackgroundCommands.state, ["running", "stopping"]),
          ),
        )
        .groupBy(schema.sessionBackgroundCommands.sessionId);
      return new Map(
        rows.map((row) => [
          row.sessionId,
          {
            state: Number(row.stoppingCount) > 0 ? ("stopping" as const) : ("running" as const),
            count: Number(row.count),
          },
        ]),
      );
    },
  );
}

export async function listSessionBackgroundCommands(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; activeOnly?: boolean },
): Promise<SessionBackgroundCommand[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select()
        .from(schema.sessionBackgroundCommands)
        .where(
          and(
            eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
            eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
            ...(input.activeOnly
              ? [inArray(schema.sessionBackgroundCommands.state, ["running", "stopping"])]
              : []),
          ),
        )
        .orderBy(
          desc(schema.sessionBackgroundCommands.startedAt),
          desc(schema.sessionBackgroundCommands.id),
        )
        .limit(1000);
      return rows.map(mapCommand);
    },
  );
}

/** @internal Caller must already hold the canonical session/control fence. */
export async function insertManagedSessionBackgroundCommandInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    commandId: string;
    retainedProcessId: string;
    command: string;
    turnId?: string;
    attemptId?: string;
    executionGeneration?: number;
  },
): Promise<SessionBackgroundCommand> {
  const [process] = await db
    .select({
      accountId: schema.sandboxRetainedProcesses.accountId,
      workspaceId: schema.sandboxRetainedProcesses.workspaceId,
      sessionId: schema.sandboxRetainedProcesses.sessionId,
      state: schema.sandboxRetainedProcesses.state,
      ownerActorKind: schema.sandboxRetainedProcesses.ownerActorKind,
      ownerActorId: schema.sandboxRetainedProcesses.ownerActorId,
      ownerTurnId: schema.sandboxRetainedProcesses.ownerTurnId,
      ownerAttemptId: schema.sandboxRetainedProcesses.ownerAttemptId,
      ownerExecutionGeneration: schema.sandboxRetainedProcesses.ownerExecutionGeneration,
    })
    .from(schema.sandboxRetainedProcesses)
    .where(eq(schema.sandboxRetainedProcesses.id, input.retainedProcessId))
    .for("update")
    .limit(1);
  if (
    !process ||
    process.accountId !== input.accountId ||
    process.workspaceId !== input.workspaceId ||
    process.sessionId !== input.sessionId ||
    process.state !== "active"
  ) {
    throw new Error("Managed background command requires its exact active retained process");
  }
  const [row] = await db
    .insert(schema.sessionBackgroundCommands)
    .values({
      id: input.commandId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      provider: "managed",
      state: "running",
      retainedProcessId: input.retainedProcessId,
      commandPreview: commandPreview(input.command),
      launchTurnId: input.turnId ?? null,
      launchAttemptId: input.attemptId ?? null,
      launchExecutionGeneration: input.executionGeneration ?? null,
    })
    .onConflictDoUpdate({
      target: schema.sessionBackgroundCommands.retainedProcessId,
      targetWhere: sql`${schema.sessionBackgroundCommands.retainedProcessId} is not null`,
      set: { updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Managed background command adoption returned no row");
  const legacyReplayMatches =
    row.launchTurnId === null &&
    row.launchAttemptId === null &&
    row.launchExecutionGeneration === null &&
    process.ownerActorKind === "turn" &&
    process.ownerActorId === input.attemptId &&
    process.ownerTurnId === input.turnId &&
    process.ownerAttemptId === input.attemptId &&
    process.ownerExecutionGeneration === input.executionGeneration;
  if (
    row.accountId !== input.accountId ||
    row.workspaceId !== input.workspaceId ||
    row.sessionId !== input.sessionId ||
    (!legacyReplayMatches &&
      (row.launchTurnId !== (input.turnId ?? null) ||
        row.launchAttemptId !== (input.attemptId ?? null) ||
        row.launchExecutionGeneration !== (input.executionGeneration ?? null))) ||
    row.provider !== "managed" ||
    row.retainedProcessId !== input.retainedProcessId
  ) {
    throw new Error("Managed background command adoption conflicted with another identity");
  }
  return mapCommand(row);
}

/** @internal Caller must already hold the canonical exact-attempt fence. */
export async function insertConnectedMachineSessionBackgroundCommandInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    commandId: string;
    controlWorkspaceId: string;
    enrollmentId: string;
    connectionInstanceId: string;
    opId: string;
    command: string;
    turnId?: string;
    attemptId?: string;
    executionGeneration?: number;
  },
): Promise<SessionBackgroundCommand> {
  const [row] = await db
    .insert(schema.sessionBackgroundCommands)
    .values({
      id: input.commandId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      provider: "connected_machine",
      state: "running",
      controlWorkspaceId: input.controlWorkspaceId,
      enrollmentId: input.enrollmentId,
      connectionInstanceId: input.connectionInstanceId,
      opId: input.opId,
      commandPreview: commandPreview(input.command),
      launchTurnId: input.turnId ?? null,
      launchAttemptId: input.attemptId ?? null,
      launchExecutionGeneration: input.executionGeneration ?? null,
    })
    .onConflictDoUpdate({
      target: [
        schema.sessionBackgroundCommands.controlWorkspaceId,
        schema.sessionBackgroundCommands.enrollmentId,
        schema.sessionBackgroundCommands.connectionInstanceId,
        schema.sessionBackgroundCommands.opId,
      ],
      targetWhere: sql`${schema.sessionBackgroundCommands.provider} = 'connected_machine'`,
      set: { updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Connected Machine background command adoption returned no row");
  if (
    row.accountId !== input.accountId ||
    row.workspaceId !== input.workspaceId ||
    row.sessionId !== input.sessionId ||
    row.launchTurnId !== (input.turnId ?? null) ||
    row.launchAttemptId !== (input.attemptId ?? null) ||
    row.launchExecutionGeneration !== (input.executionGeneration ?? null) ||
    row.provider !== "connected_machine" ||
    row.controlWorkspaceId !== input.controlWorkspaceId ||
    row.enrollmentId !== input.enrollmentId ||
    row.connectionInstanceId !== input.connectionInstanceId ||
    row.opId !== input.opId
  ) {
    throw new Error(
      "Connected Machine background command adoption conflicted with another identity",
    );
  }
  return mapCommand(row);
}

/** Claim exact Connected Machine locators globally for provider reconciliation.
 * The SECURITY DEFINER SQL function owns the bounded SKIP LOCKED inventory;
 * claim expiry is coordination recovery only and never implies command loss. */
export async function claimConnectedMachineSessionBackgroundCommands(
  db: Database,
  input: { claimId: string; limit: number; claimTtlMs: number; dueBefore?: Date },
): Promise<ConnectedMachineBackgroundCommandClaim[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Connected command reconciliation limit must be between 1 and 100");
  }
  if (
    !Number.isSafeInteger(input.claimTtlMs) ||
    input.claimTtlMs < 0 ||
    input.claimTtlMs > 3_600_000
  ) {
    throw new Error("Connected command reconciliation claim TTL is invalid");
  }
  const rows = await db.execute<ConnectedMachineBackgroundCommandClaimRow>(sql`
    select account_id as "accountId",
      workspace_id as "workspaceId",
      session_id as "sessionId",
      command_id as "commandId",
      claim_id as "claimId",
      command_state as "commandState",
      control_workspace_id as "controlWorkspaceId",
      enrollment_id as "enrollmentId",
      connection_instance_id as "connectionInstanceId",
      op_id as "opId",
      reconcile_attempts as "reconcileAttempts",
      reconcile_proof_outcome as "reconcileProofOutcome",
      reconcile_proof_exit_code as "reconcileProofExitCode",
      reconcile_proof_reason as "reconcileProofReason",
      reconcile_proof_observed_at as "reconcileProofObservedAt"
    from opengeni_private.claim_connected_machine_background_commands(
      ${input.claimId}::uuid, ${input.limit}::integer, ${input.claimTtlMs}::bigint,
      ${(input.dueBefore ?? new Date()).toISOString()}::timestamptz
    )
  `);
  return rows.map((row: ConnectedMachineBackgroundCommandClaimRow) => {
    if (row.commandState !== "running" && row.commandState !== "stopping") {
      throw new Error(`Connected command claim returned invalid state ${row.commandState}`);
    }
    const proof =
      row.reconcileProofOutcome === null
        ? null
        : row.reconcileProofOutcome === "exited" || row.reconcileProofOutcome === "lost"
          ? {
              outcome: row.reconcileProofOutcome,
              exitCode:
                row.reconcileProofExitCode === null ? null : Number(row.reconcileProofExitCode),
              reason: row.reconcileProofReason!,
              observedAt:
                row.reconcileProofObservedAt instanceof Date
                  ? row.reconcileProofObservedAt
                  : new Date(row.reconcileProofObservedAt!),
            }
          : (() => {
              throw new Error(
                `Connected command claim returned invalid proof ${row.reconcileProofOutcome}`,
              );
            })();
    return {
      commandId: row.commandId,
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      claimId: row.claimId,
      state: row.commandState,
      controlWorkspaceId: row.controlWorkspaceId,
      enrollmentId: row.enrollmentId,
      connectionInstanceId: row.connectionInstanceId,
      opId: row.opId,
      reconcileAttempts: Number(row.reconcileAttempts),
      proof,
    };
  });
}

function connectedClaimIdentityWhere(claim: ConnectedMachineBackgroundCommandClaim) {
  return and(
    eq(schema.sessionBackgroundCommands.id, claim.commandId),
    eq(schema.sessionBackgroundCommands.accountId, claim.accountId),
    eq(schema.sessionBackgroundCommands.workspaceId, claim.workspaceId),
    eq(schema.sessionBackgroundCommands.sessionId, claim.sessionId),
    eq(schema.sessionBackgroundCommands.provider, "connected_machine"),
    eq(schema.sessionBackgroundCommands.controlWorkspaceId, claim.controlWorkspaceId),
    eq(schema.sessionBackgroundCommands.enrollmentId, claim.enrollmentId),
    eq(schema.sessionBackgroundCommands.connectionInstanceId, claim.connectionInstanceId),
    eq(schema.sessionBackgroundCommands.opId, claim.opId),
    eq(schema.sessionBackgroundCommands.reconcileClaimId, claim.claimId),
    inArray(schema.sessionBackgroundCommands.state, ["running", "stopping"]),
  );
}

/** Checkpoint one exact terminal provider observation before lifecycle settlement.
 * A retry may reuse an identical proof; a divergent proof is a hard identity fault. */
export async function recordConnectedMachineBackgroundCommandProof(
  db: Database,
  input: {
    claim: ConnectedMachineBackgroundCommandClaim;
    proof: ConnectedMachineBackgroundCommandProof;
  },
): Promise<void> {
  const failure = input.proof.failure ? SessionCommandFailure.parse(input.proof.failure) : null;
  const reason = boundedSessionBackgroundCommandReason(
    input.proof.reason,
    "Connected command proof reason",
  );
  if (failure && reason !== `op_failure_${failure.code}`)
    throw new Error("Connected command failure code conflicts with proof reason");
  if (input.proof.outcome === "exited" && input.proof.exitCode === null) {
    throw new Error("Connected command exit proof requires an exit code");
  }
  if (input.proof.outcome === "lost" && input.proof.exitCode !== null) {
    throw new Error("Connected command loss proof cannot carry an exit code");
  }
  await withRlsContext(
    db,
    { accountId: input.claim.accountId, workspaceId: input.claim.workspaceId },
    async (scopedDb) => {
      const [current] = await scopedDb
        .select()
        .from(schema.sessionBackgroundCommands)
        .where(connectedClaimIdentityWhere(input.claim))
        .for("update")
        .limit(1);
      if (!current) throw new Error("Connected command proof was fenced by newer lifecycle state");
      if (current.reconcileProofOutcome !== null) {
        const observedAt = current.reconcileProofObservedAt?.getTime() ?? null;
        if (
          current.reconcileProofOutcome !== input.proof.outcome ||
          current.reconcileProofExitCode !== input.proof.exitCode ||
          current.reconcileProofReason !== reason ||
          !isDeepStrictEqual(current.runnerFailure, failure) ||
          observedAt !== input.proof.observedAt.getTime()
        ) {
          throw new Error("Connected command reconciliation proof conflicts with durable proof");
        }
        return;
      }
      const rows = await scopedDb
        .update(schema.sessionBackgroundCommands)
        .set({
          reconcileProofOutcome: input.proof.outcome,
          reconcileProofExitCode: input.proof.exitCode,
          reconcileProofReason: reason,
          runnerFailure: failure,
          reconcileProofObservedAt: input.proof.observedAt,
          lastReconcileOutcome: `proof_${input.proof.outcome}`,
          updatedAt: new Date(),
        })
        .where(connectedClaimIdentityWhere(input.claim))
        .returning({ id: schema.sessionBackgroundCommands.id });
      if (rows.length !== 1) {
        throw new Error("Connected command proof lost its exact claim during checkpoint");
      }
    },
  );
}

export async function deferConnectedMachineBackgroundCommandReconciliation(
  db: Database,
  input: {
    claim: ConnectedMachineBackgroundCommandClaim;
    outcome: string;
    retryAfterMs: number;
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0) {
    throw new Error("Connected command reconciliation retry delay is invalid");
  }
  const outcome = input.outcome.trim().slice(0, 64);
  if (!outcome) throw new Error("Connected command reconciliation outcome must not be empty");
  return await withRlsContext(
    db,
    { accountId: input.claim.accountId, workspaceId: input.claim.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .update(schema.sessionBackgroundCommands)
        .set({
          reconcileAfter: new Date(Date.now() + input.retryAfterMs),
          reconcileClaimId: null,
          reconcileClaimedAt: null,
          lastReconcileOutcome: outcome,
          updatedAt: new Date(),
        })
        .where(connectedClaimIdentityWhere(input.claim))
        .returning({ id: schema.sessionBackgroundCommands.id });
      return rows.length === 1;
    },
  );
}

/** Settle only from the proof already checkpointed under this exact claim. */
export async function settleClaimedConnectedMachineBackgroundCommandWithMutation(
  db: Database,
  input: { claim: ConnectedMachineBackgroundCommandClaim },
  mutateTerminal: SessionBackgroundCommandTerminalMutation,
): Promise<boolean> {
  return await withSessionActivityRlsContext(
    db,
    { accountId: input.claim.accountId, workspaceId: input.claim.workspaceId },
    async (tx) => {
      await mutateTerminal.prepare(tx);
      const rows = await tx.execute<{ id: string }>(sql`
          update ${schema.sessionBackgroundCommands} command set
            state = command.reconcile_proof_outcome,
            exit_code = case
              when command.reconcile_proof_outcome = 'exited'
                then command.reconcile_proof_exit_code
              else null
            end,
            settlement_reason = command.reconcile_proof_reason,
            settled_at = command.reconcile_proof_observed_at,
            reconcile_claim_id = null,
            reconcile_claimed_at = null,
            last_reconcile_outcome = 'settled_' || command.reconcile_proof_outcome,
            updated_at = clock_timestamp()
          where command.id = ${input.claim.commandId}
            and command.account_id = ${input.claim.accountId}
            and command.workspace_id = ${input.claim.workspaceId}
            and command.session_id = ${input.claim.sessionId}
            and command.provider = 'connected_machine'
            and command.control_workspace_id = ${input.claim.controlWorkspaceId}
            and command.enrollment_id = ${input.claim.enrollmentId}
            and command.connection_instance_id = ${input.claim.connectionInstanceId}
            and command.op_id = ${input.claim.opId}
            and command.reconcile_claim_id = ${input.claim.claimId}
            and command.state in ('running', 'stopping')
            and command.reconcile_proof_outcome in ('exited', 'lost')
            and command.reconcile_proof_observed_at is not null
          returning command.id
        `);
      if (rows.length !== 1) return false;
      const [row] = await tx
        .select()
        .from(schema.sessionBackgroundCommands)
        .where(eq(schema.sessionBackgroundCommands.id, input.claim.commandId))
        .limit(1);
      if (!row) throw new Error("Settled Connected Machine command disappeared");
      await mutateTerminal.commit(tx, mapCommand(row));
      return true;
    },
  );
}

export async function requestSessionBackgroundCommandCancellation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    commandId: string;
    subjectId: string;
  },
): Promise<{ command: SessionBackgroundCommand | null; accepted: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.sessionBackgroundCommands)
          .where(
            and(
              eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
              eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
              eq(schema.sessionBackgroundCommands.id, input.commandId),
            ),
          )
          .for("update")
          .limit(1);
        if (!current) return { command: null, accepted: false };
        if (current.state !== "running") {
          return { command: mapCommand(current), accepted: false };
        }
        const [updated] = await tx
          .update(schema.sessionBackgroundCommands)
          .set({
            state: "stopping",
            cancelRequestedAt: new Date(),
            cancelRequestedBy: input.subjectId.slice(0, 1024),
            reconcileAfter: new Date(),
            reconcileClaimId: null,
            reconcileClaimedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.sessionBackgroundCommands.id, current.id))
          .returning();
        if (current.retainedProcessId) {
          await tx
            .update(schema.sandboxRetainedProcesses)
            .set({ reconcileAfter: new Date(), lastReconcileOutcome: "cancel_requested" })
            .where(
              and(
                eq(schema.sandboxRetainedProcesses.id, current.retainedProcessId),
                eq(schema.sandboxRetainedProcesses.state, "active"),
                sql`${schema.sandboxRetainedProcesses.reconcileClaimId} is null`,
              ),
            );
        }
        return { command: mapCommand(updated!), accepted: true };
      }),
  );
}

/**
 * Transfer every active command in one or more session subtrees to the
 * provider-neutral stopping state inside the caller's existing control
 * transaction. The workspace-control mutation already excludes concurrent
 * session-tree changes, so the recursive walk and state transition are one
 * atomic Pause/Cancel effect. Steer deliberately never calls this seam.
 */
export async function requestSessionBackgroundCommandCancellationsInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    rootSessionIds: string[];
    subjectId: string;
  },
): Promise<number> {
  const rootSessionIds = [...new Set(input.rootSessionIds)];
  if (rootSessionIds.length === 0) return 0;
  const rows = await db.execute<{ commandCount: number | string }>(sql`
    with recursive roots(id) as (
      values ${sql.join(
        rootSessionIds.map((sessionId) => sql`(${sessionId}::uuid)`),
        sql`, `,
      )}
    ), subtree(id, path, cycle) as (
      select session.id, array[session.id]::uuid[], false
      from roots root
      join ${schema.sessions} session
        on session.workspace_id = ${input.workspaceId}
       and session.id = root.id
      union all
      select child.id, parent.path || child.id, child.id = any(parent.path)
      from subtree parent
      join ${schema.sessions} child
        on child.workspace_id = ${input.workspaceId}
       and child.parent_session_id = parent.id
      where not parent.cycle
    ), stopped as (
      update ${schema.sessionBackgroundCommands} command set
        state = 'stopping',
        cancel_requested_at = clock_timestamp(),
        cancel_requested_by = left(${input.subjectId}, 1024),
        reconcile_after = clock_timestamp(),
        reconcile_claim_id = null,
        reconcile_claimed_at = null,
        updated_at = clock_timestamp()
      where command.workspace_id = ${input.workspaceId}
        and command.session_id in (select id from subtree where not cycle)
        and command.state = 'running'
      returning command.retained_process_id
    ), nudged as (
      update ${schema.sandboxRetainedProcesses} process set
        reconcile_after = clock_timestamp(),
        reconcile_claim_id = null,
        reconcile_claimed_at = null,
        last_reconcile_outcome = 'cancel_requested'
      where process.id in (
        select stopped.retained_process_id
        from stopped
        where stopped.retained_process_id is not null
      )
        and process.state = 'active'
      returning process.id
    )
    select count(*)::integer as "commandCount" from stopped
  `);
  return Number(rows[0]?.commandCount ?? 0);
}

/** Workspace Pause owns every active command in that workspace. */
export async function requestWorkspaceBackgroundCommandCancellationsInTransaction(
  db: Database,
  input: { workspaceId: string; subjectId: string },
): Promise<number> {
  const rows = await db.execute<{ commandCount: number | string }>(sql`
    with stopped as (
      update ${schema.sessionBackgroundCommands} command set
        state = 'stopping',
        cancel_requested_at = clock_timestamp(),
        cancel_requested_by = left(${input.subjectId}, 1024),
        reconcile_after = clock_timestamp(),
        reconcile_claim_id = null,
        reconcile_claimed_at = null,
        updated_at = clock_timestamp()
      where command.workspace_id = ${input.workspaceId}
        and command.state = 'running'
      returning command.retained_process_id
    ), nudged as (
      update ${schema.sandboxRetainedProcesses} process set
        reconcile_after = clock_timestamp(),
        reconcile_claim_id = null,
        reconcile_claimed_at = null,
        last_reconcile_outcome = 'cancel_requested'
      where process.id in (
        select stopped.retained_process_id
        from stopped
        where stopped.retained_process_id is not null
      )
        and process.state = 'active'
      returning process.id
    )
    select count(*)::integer as "commandCount" from stopped
  `);
  return Number(rows[0]?.commandCount ?? 0);
}

export async function settleSessionBackgroundCommandForRetainedProcessInTransaction(
  tx: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    retainedProcessId: string;
    outcome: "exited" | "lost";
    exitCode: number | null;
    reason: string;
  },
  mutateTerminal: SessionBackgroundCommandTerminalMutation,
): Promise<SessionBackgroundCommand | null> {
  const reason = boundedSessionBackgroundCommandReason(
    input.reason,
    "Managed command settlement reason",
  );
  await mutateTerminal.prepare(tx);
  const [updatedRow] = await tx
    .update(schema.sessionBackgroundCommands)
    .set({
      state: input.outcome,
      exitCode: input.outcome === "exited" ? input.exitCode : null,
      settlementReason: reason,
      settledAt: new Date(),
      reconcileClaimId: null,
      reconcileClaimedAt: null,
      lastReconcileOutcome: `settled_${input.outcome}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
        eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
        eq(schema.sessionBackgroundCommands.retainedProcessId, input.retainedProcessId),
        inArray(schema.sessionBackgroundCommands.state, ["running", "stopping"]),
      ),
    )
    .returning();
  let row = updatedRow;
  if (!row) {
    const [current] = await tx
      .select()
      .from(schema.sessionBackgroundCommands)
      .where(
        and(
          eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
          eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
          eq(schema.sessionBackgroundCommands.retainedProcessId, input.retainedProcessId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) return null;
    if (
      current.state !== input.outcome ||
      current.exitCode !== (input.outcome === "exited" ? input.exitCode : null)
    ) {
      throw new Error("Managed background command terminal state conflicts with process proof");
    }
    const [existingEvent] = await tx
      .select({ id: schema.sessionEvents.id })
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, input.workspaceId),
          eq(schema.sessionEvents.sessionId, input.sessionId),
          eq(schema.sessionEvents.type, "session.command.finished"),
          sql`${schema.sessionEvents.payload} ->> 'commandId' = ${current.id}`,
        ),
      )
      .limit(1);
    if (existingEvent) return mapCommand(current);
    row = current;
  }
  const command = mapCommand(row);
  await mutateTerminal.commit(tx, command);
  return command;
}

export async function settleConnectedMachineSessionBackgroundCommandWithMutation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    commandId: string;
    controlWorkspaceId: string;
    enrollmentId: string;
    connectionInstanceId: string;
    opId: string;
    outcome: "exited" | "lost";
    exitCode: number | null;
    reason: string;
    failure?: SessionCommandFailure | undefined;
  },
  mutateTerminal: SessionBackgroundCommandTerminalMutation,
): Promise<SessionBackgroundCommand | null> {
  const failure = input.failure ? SessionCommandFailure.parse(input.failure) : null;
  const reason = boundedSessionBackgroundCommandReason(
    input.reason,
    "Connected command settlement reason",
  );
  if (failure && reason !== `op_failure_${failure.code}`)
    throw new Error("Connected command failure code conflicts with settlement reason");
  if (input.outcome === "exited" && input.exitCode === null) {
    throw new Error("Connected command exit settlement requires an exit code");
  }
  if (input.outcome === "lost" && input.exitCode !== null) {
    throw new Error("Connected command loss settlement cannot carry an exit code");
  }
  return await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await mutateTerminal.prepare(tx);
      const settledAt = new Date();
      const [row] = await tx
        .update(schema.sessionBackgroundCommands)
        .set({
          state: input.outcome,
          exitCode: input.outcome === "exited" ? input.exitCode : null,
          settlementReason: reason,
          runnerFailure: failure,
          settledAt,
          reconcileClaimId: null,
          reconcileClaimedAt: null,
          reconcileProofOutcome: input.outcome,
          reconcileProofExitCode: input.outcome === "exited" ? input.exitCode : null,
          reconcileProofReason: reason,
          reconcileProofObservedAt: settledAt,
          lastReconcileOutcome: `settled_${input.outcome}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
            eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
            eq(schema.sessionBackgroundCommands.id, input.commandId),
            eq(schema.sessionBackgroundCommands.provider, "connected_machine"),
            eq(schema.sessionBackgroundCommands.controlWorkspaceId, input.controlWorkspaceId),
            eq(schema.sessionBackgroundCommands.enrollmentId, input.enrollmentId),
            eq(schema.sessionBackgroundCommands.connectionInstanceId, input.connectionInstanceId),
            eq(schema.sessionBackgroundCommands.opId, input.opId),
            // A fast owner settlement cannot erase or replace metadata already
            // checkpointed by the reconciler under the exact command identity.
            sql`(${schema.sessionBackgroundCommands.runnerFailure} is null or
              ${schema.sessionBackgroundCommands.runnerFailure} = ${failure ? JSON.stringify(failure) : null}::jsonb)`,
            inArray(schema.sessionBackgroundCommands.state, ["running", "stopping"]),
          ),
        )
        .returning();
      if (!row) return null;
      const command = mapCommand(row);
      await mutateTerminal.commit(tx, command);
      return command;
    },
  );
}

export async function getSessionBackgroundCommand(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; commandId: string },
): Promise<SessionBackgroundCommand | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.sessionBackgroundCommands)
        .where(
          and(
            eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
            eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
            eq(schema.sessionBackgroundCommands.id, input.commandId),
          ),
        )
        .limit(1);
      return row ? mapCommand(row) : null;
    },
  );
}

export type SessionCommandIdentity = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  commandId: string;
};

/** Observe terminal state, not output consumption. Native terminal-result adapters
 * call this after settlement. Session-first ordering serializes settlement and
 * inbox claiming; already delivered history is never rewritten. */
export async function observeSessionBackgroundCommandCompletion(
  db: Database,
  input: SessionCommandIdentity,
): Promise<SessionBackgroundCommand | null> {
  return await withSessionActivityRlsContext(db, input, async (tx) => {
    const locks = await lockSessionEventWriteRows(tx, {
      workspaceId: input.workspaceId,
      controlLock: "share",
      sessionIds: [input.sessionId],
    });
    if (locks.sessions[0]?.accountId !== input.accountId) return null;
    const identity = and(
      eq(schema.sessionBackgroundCommands.accountId, input.accountId),
      eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
      eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
      eq(schema.sessionBackgroundCommands.id, input.commandId),
    );
    const [command] = await tx
      .select()
      .from(schema.sessionBackgroundCommands)
      .where(identity)
      .for("update")
      .limit(1);
    if (!command) return null;
    if (command.state !== "exited" && command.state !== "lost") return mapCommand(command);
    const observedAt = command.completionObservedAt ?? new Date();
    await tx
      .update(schema.sessionBackgroundCommands)
      .set({ completionObservedAt: observedAt })
      .where(identity);
    await tx
      .update(schema.sessionSystemUpdates)
      .set({ state: "superseded" })
      .where(
        and(
          eq(schema.sessionSystemUpdates.accountId, input.accountId),
          eq(schema.sessionSystemUpdates.workspaceId, input.workspaceId),
          eq(schema.sessionSystemUpdates.sessionId, input.sessionId),
          eq(schema.sessionSystemUpdates.kind, "background_command_result"),
          eq(schema.sessionSystemUpdates.sourceId, input.commandId),
          eq(schema.sessionSystemUpdates.dedupeKey, `background-command-result:${input.commandId}`),
          eq(schema.sessionSystemUpdates.state, "pending"),
        ),
      );
    return mapCommand({ ...command, completionObservedAt: observedAt });
  });
}

export const COMMAND_OUTPUT_DEFAULT_BYTES = 16_384;
export const COMMAND_OUTPUT_MAX_BYTES = 65_536;
export const COMMAND_OUTPUT_PAGE_ROWS = 64;

export function parseCommandOutputCursor(cursor: string | undefined, commandId: string) {
  if (cursor === undefined) return { sequence: 0, offset: 0 };
  if (cursor.length > 128) throw new Error("Invalid command output cursor");
  const parts = cursor.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== commandId ||
    !/^\d+$/.test(parts[1]!) ||
    !/^\d+$/.test(parts[2]!)
  ) {
    throw new Error("Invalid command output cursor");
  }
  const sequence = Number(parts[1]);
  const offset = Number(parts[2]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(offset))
    throw new Error("Invalid command output cursor");
  return { sequence, offset };
}

export type CommandOutputRow = {
  sequence: number;
  payload: unknown;
  payloadCodecVersion: number | null;
};

/** Cursor offsets are UTF-16 positions at code-point boundaries; budgets are UTF-8 bytes. */
export function projectCommandOutputPage(input: {
  commandId: string;
  cursor?: string | undefined;
  maxOutputBytes?: number | undefined;
  rows: CommandOutputRow[];
}) {
  const start = parseCommandOutputCursor(input.cursor, input.commandId);
  const budget = input.maxOutputBytes ?? COMMAND_OUTPUT_DEFAULT_BYTES;
  if (!Number.isSafeInteger(budget) || budget < 4 || budget > COMMAND_OUTPUT_MAX_BYTES)
    throw new Error("maxOutputBytes must be between 4 and 65536");
  let remaining = budget;
  let sequence = start.sequence;
  let offset = start.offset;
  const chunks: {
    sequence: number;
    stream: "stdout" | "stderr";
    streamFidelity: "separate" | "merged" | "unknown";
    chunk: string;
  }[] = [];
  const gaps: string[] = [];
  if (start.offset > 0 && input.rows[0]?.sequence !== start.sequence)
    gaps.push("cursor_output_no_longer_retained");
  let consumed = 0;
  for (const row of input.rows.slice(0, COMMAND_OUTPUT_PAGE_ROWS)) {
    const payload = fromPostgresLosslessJson(row.payload, row.payloadCodecVersion) as Record<
      string,
      unknown
    >;
    const text = typeof payload?.chunk === "string" ? payload.chunk : "";
    if (typeof payload?.chunk !== "string") gaps.push("retained_event_has_no_output_chunk");
    if (payload?.commandReadProjectionGap === true) gaps.push("retained_event_exceeds_read_limit");
    if (payload?.truncation && typeof payload.truncation === "object")
      gaps.push("output_truncated_at_retention_boundary");
    const begin = row.sequence === start.sequence ? start.offset : 0;
    if (
      begin > 0 &&
      begin < text.length &&
      text.charCodeAt(begin - 1) >= 0xd800 &&
      text.charCodeAt(begin - 1) <= 0xdbff &&
      text.charCodeAt(begin) >= 0xdc00 &&
      text.charCodeAt(begin) <= 0xdfff
    ) {
      throw new Error("Invalid command output cursor: offset splits a Unicode code point");
    }
    if (begin > text.length) gaps.push("cursor_output_no_longer_retained");
    let end = Math.min(begin, text.length);
    for (const character of text.slice(end)) {
      const bytes = Buffer.byteLength(character, "utf8");
      if (bytes > remaining) break;
      remaining -= bytes;
      end += character.length;
    }
    if (end > begin)
      chunks.push({
        sequence: row.sequence,
        stream: payload.stream === "stderr" ? "stderr" : "stdout",
        streamFidelity:
          payload.streamFidelity === "merged"
            ? "merged"
            : payload.streamFidelity === "separate"
              ? "separate"
              : "unknown",
        chunk: text.slice(begin, end),
      });
    if (end < text.length) {
      sequence = row.sequence;
      offset = end;
      break;
    }
    sequence = row.sequence + 1;
    offset = 0;
    consumed++;
  }
  return {
    chunks,
    nextCursor: `${input.commandId}:${sequence}:${offset}`,
    hasMore: consumed < input.rows.length,
    retention: {
      source: "retained_session_events" as const,
      completeness: "unknown" as const,
      gaps: [...new Set(gaps)],
    },
  };
}

export async function readSessionBackgroundCommandOutput(
  db: Database,
  input: SessionCommandIdentity & {
    cursor?: string | undefined;
    maxOutputBytes?: number | undefined;
  },
) {
  const cursor = parseCommandOutputCursor(input.cursor, input.commandId);
  // Validate the budget before any observation mutation.
  projectCommandOutputPage({ ...input, rows: [] });
  const command = await getSessionBackgroundCommand(db, input);
  if (!command) throw new Error("Background command not found in this session");
  const rows = await withRlsContext(
    db,
    input,
    async (tx) =>
      await tx
        .select({
          sequence: schema.sessionEvents.sequence,
          // Bound legacy payloads in SQL too: LIMIT alone cannot bound one old event.
          // Oversized historical rows carry explicit loss rather than allocating an
          // unbounded JSON value in the API process.
          payload: sql<unknown>`case when octet_length(${schema.sessionEvents.payload}::text) <= 262144
      then ${schema.sessionEvents.payload}
      else jsonb_build_object('commandReadProjectionGap', true) end`,
          payloadCodecVersion: schema.sessionEvents.payloadCodecVersion,
        })
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.sessionId, input.sessionId),
            eq(schema.sessionEvents.type, "sandbox.command.output.delta"),
            sql`${schema.sessionEvents.payload} ->> 'commandId' = ${input.commandId}`,
            gte(schema.sessionEvents.sequence, cursor.sequence),
          ),
        )
        .orderBy(asc(schema.sessionEvents.sequence))
        .limit(COMMAND_OUTPUT_PAGE_ROWS + 1),
  );
  const page = projectCommandOutputPage({ ...input, rows });
  // Only observe the terminal state actually used by this read. A finish racing
  // a running read must leave its notification pending.
  const terminal = command.state === "exited" || command.state === "lost";
  const observed = terminal ? await observeSessionBackgroundCommandCompletion(db, input) : command;
  return {
    commandId: command.id,
    state: command.state,
    exitCode: command.exitCode,
    settlementReason: command.settlementReason,
    ...(command.failure ? { failure: command.failure } : {}),
    terminal,
    completionObservedAt: observed?.completionObservedAt ?? null,
    ...page,
  };
}
