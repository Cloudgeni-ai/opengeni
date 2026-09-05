import type {
  SessionBackgroundCommand,
  SessionBackgroundCommandActivity,
} from "@opengeni/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database, SessionActivityDatabase } from "./database";
import { withRlsContext, withSessionActivityRlsContext } from "./database";
import * as schema from "./schema";

export type ConnectedMachineBackgroundCommandProof = {
  outcome: "exited" | "lost";
  exitCode: number | null;
  reason: string;
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
    startedAt: row.startedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
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
  input: { accountId: string; workspaceId: string; sessionId: string },
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
  },
): Promise<SessionBackgroundCommand> {
  const [process] = await db
    .select({
      accountId: schema.sandboxRetainedProcesses.accountId,
      workspaceId: schema.sandboxRetainedProcesses.workspaceId,
      sessionId: schema.sandboxRetainedProcesses.sessionId,
      state: schema.sandboxRetainedProcesses.state,
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
    })
    .onConflictDoUpdate({
      target: schema.sessionBackgroundCommands.retainedProcessId,
      targetWhere: sql`${schema.sessionBackgroundCommands.retainedProcessId} is not null`,
      set: { updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Managed background command adoption returned no row");
  if (
    row.accountId !== input.accountId ||
    row.workspaceId !== input.workspaceId ||
    row.sessionId !== input.sessionId ||
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
  const reason = boundedSessionBackgroundCommandReason(
    input.proof.reason,
    "Connected command proof reason",
  );
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
  },
  mutateTerminal: SessionBackgroundCommandTerminalMutation,
): Promise<SessionBackgroundCommand | null> {
  const reason = boundedSessionBackgroundCommandReason(
    input.reason,
    "Connected command settlement reason",
  );
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
