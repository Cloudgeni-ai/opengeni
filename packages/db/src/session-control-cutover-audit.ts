import { createHash } from "node:crypto";
import type postgres from "postgres";

export const SESSION_CONTROL_CUTOVER_CONTRACT = "opengeni/session-control-cutover/v2" as const;

export type CutoverPhase = "baseline" | "migrated" | "final";

export type CutoverTurn = {
  id: string;
  triggerEventId: string;
  temporalWorkflowId: string;
  status: string;
  source: string;
  position: number;
  version: number | null;
  executionGeneration: number | null;
  activeAttemptId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  hasStartedEvidence: boolean;
};

export type CutoverGoal = {
  id: string;
  status: string;
  version: number;
  autoContinuations: number;
  noProgressStreak: number;
  lastContinuationTurnId: string | null;
};

export type CutoverRelationProof = {
  count: number;
  maxOrdinal: number | null;
  stableSha256: string;
  identitySha256: string;
  preservedCount: number;
  preservedThroughOrdinal: number | null;
  preservedStableSha256: string;
  preservedIdentitySha256: string;
};

export type CutoverRunState = {
  id: string;
  turnId: string | null;
  stateVersion: number;
  schemaVersion: string | null;
  pendingApprovalCount: number;
  frozenCodexCredentialId: string | null;
};

export type CutoverCapacityWaiter = {
  id: string;
  goalId: string;
  blockedTurnId: string;
  workflowId: string;
  generation: number;
  status: string;
  goalVersion: number;
  controlGeneration: number;
  wakeRevision: number;
  observedWakeRevision: number;
};

export type CutoverSandboxLease = {
  id: string;
  sandboxGroupId: string;
  liveness: string;
  instanceId: string | null;
  backend: string;
  leaseEpoch: number;
};

export type CutoverSystemUpdate = {
  id: string;
  kind: string;
  sourceId: string;
  dedupeKey: string;
  state: string;
  deliveredTurnId: string | null;
};

export type CutoverPendingToolCall = {
  id: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
  callId: string;
  callType: string;
  resultRecorded: boolean;
};

export type CutoverSession = {
  id: string;
  accountId: string;
  workspaceId: string;
  status: string;
  temporalWorkflowId: string | null;
  activeTurnId: string | null;
  sandboxGroupId: string;
  activeSandboxId: string | null;
  activeEpoch: number;
  controlState: string | null;
  controlGeneration: number | null;
  workspaceRunExceptionGeneration: number | null;
  queueVersion: number | null;
  queueHeadPosition: number | null;
  queueTailPosition: number | null;
  turns: CutoverTurn[];
  goals: CutoverGoal[];
  historyProof: CutoverRelationProof;
  eventProof: CutoverRelationProof;
  runStates: CutoverRunState[];
  capacityWaiters: CutoverCapacityWaiter[];
  sandboxLeases: CutoverSandboxLease[];
  systemUpdates: CutoverSystemUpdate[];
  pendingToolCalls: CutoverPendingToolCall[];
};

export type CutoverWorkspace = {
  id: string;
  accountId: string;
  inferenceState: string | null;
  inferenceGeneration: number | null;
};

export type CutoverInvariantCounts = {
  multipleCurrentInferences: number;
  queuedMachineTurns: number;
  activeOpaqueCompactionItems: number;
  invalidActiveTurnPointers: number;
  runningTurnsWithoutAttempt: number;
  attemptOwnedNonRunningTurns: number;
  duplicateCurrentUsageSources: number;
  invalidDuplicateUsageAssociations: number;
  enrollableSessions: number;
  workerDeathRedispatchExhausted: number;
};

export type SessionControlCutoverSnapshot = {
  contractVersion: typeof SESSION_CONTROL_CUTOVER_CONTRACT;
  phase: CutoverPhase;
  capturedAt: string;
  schemaMigrations: string[];
  workspaces: CutoverWorkspace[];
  sessions: CutoverSession[];
  proofBaselineSha256: string | null;
  invariants: CutoverInvariantCounts;
  identityCount: number;
  sha256: string;
};

export type CutoverReconciliation = {
  contractVersion: typeof SESSION_CONTROL_CUTOVER_CONTRACT;
  mode: "migration" | "final-fate";
  baselineSha256: string;
  observedSha256: string;
  ok: boolean;
  errors: string[];
  fateCounts: Record<string, number>;
  sha256: string;
};

type Row = Record<string, unknown>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is not a string`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, name);
}

function nullableTimestamp(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return stringValue(value, name);
}

function numberValue(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} is not numeric`);
  return parsed;
}

function nullableNumber(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  return numberValue(value, name);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}

async function tableExists(sql: postgres.Sql, table: string): Promise<boolean> {
  const rows = await sql<Row[]>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = current_schema() and table_name = ${table}
    ) as present`;
  return booleanValue(rows[0]?.present);
}

async function columnExists(sql: postgres.Sql, table: string, column: string): Promise<boolean> {
  const rows = await sql<Row[]>`
    select exists (
      select 1 from information_schema.columns
      where table_schema = current_schema() and table_name = ${table} and column_name = ${column}
    ) as present`;
  return booleanValue(rows[0]?.present);
}

async function functionExists(sql: postgres.Sql, signature: string): Promise<boolean> {
  const rows = await sql<Row[]>`select to_regprocedure(${signature}) is not null as present`;
  return booleanValue(rows[0]?.present);
}

async function unsafeRows(sql: postgres.Sql, query: string): Promise<Row[]> {
  return (await sql.unsafe<Row[]>(query)) as unknown as Row[];
}

/**
 * The cutover snapshot crosses every workspace on purpose. FORCE RLS makes a
 * normal runtime role return an empty set rather than throwing, which could
 * otherwise produce a vacuous green reconciliation. Require an explicitly
 * privileged operator connection before reading any identity table.
 */
export async function assertSessionControlCutoverAuditAuthority(sql: postgres.Sql): Promise<void> {
  const rows = await unsafeRows(
    sql,
    `select current_user as role_name, rolsuper, rolbypassrls
     from pg_roles where rolname = current_user`,
  );
  const role = rows[0];
  if (!role || (!booleanValue(role.rolsuper) && !booleanValue(role.rolbypassrls))) {
    throw new Error(
      `session-control cutover audit requires a superuser or BYPASSRLS role; ${String(role?.role_name ?? "unknown")} is not authorized`,
    );
  }
}

function groupBySession<T extends { sessionId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const values = grouped.get(row.sessionId) ?? [];
    values.push(row);
    grouped.set(row.sessionId, values);
  }
  return grouped;
}

type RelationProofAccumulator = {
  count: number;
  maxOrdinal: number | null;
  stable: ReturnType<typeof createHash>;
  identity: ReturnType<typeof createHash>;
  preservedCount: number;
  preservedStable: ReturnType<typeof createHash>;
  preservedIdentity: ReturnType<typeof createHash>;
};

function collectProofGarbage(): void {
  if (typeof Bun !== "undefined") Bun.gc(true);
}

function updateProofHash(hash: ReturnType<typeof createHash>, value: unknown): void {
  const serialized = stableJson(value);
  hash.update(String(Buffer.byteLength(serialized, "utf8")));
  hash.update(":");
  hash.update(serialized);
}

function newProofAccumulator(): RelationProofAccumulator {
  return {
    count: 0,
    maxOrdinal: null,
    stable: createHash("sha256"),
    identity: createHash("sha256"),
    preservedCount: 0,
    preservedStable: createHash("sha256"),
    preservedIdentity: createHash("sha256"),
  };
}

async function captureRelationProofs(
  sql: postgres.Sql,
  query: string,
  ordinalColumn: string,
  stableRow: (row: Row) => Record<string, unknown>,
  reference: SessionControlCutoverSnapshot | undefined,
  referenceProof: (session: CutoverSession) => CutoverRelationProof,
): Promise<Map<string, CutoverRelationProof>> {
  const referenceBoundaries = new Map(
    (reference?.sessions ?? []).map((session) => [session.id, referenceProof(session).maxOrdinal]),
  );
  const accumulators = new Map<string, RelationProofAccumulator>();
  await sql.unsafe<Row[]>(query).cursor(2_048, (rows) => {
    for (const row of rows) {
      const sessionId = stringValue(row.session_id, "relation.session_id");
      const ordinal = numberValue(row[ordinalColumn], `relation.${ordinalColumn}`);
      const identity = { id: stringValue(row.id, "relation.id") };
      const stable = stableRow(row);
      const accumulator = accumulators.get(sessionId) ?? newProofAccumulator();
      accumulator.count += 1;
      accumulator.maxOrdinal = Math.max(accumulator.maxOrdinal ?? ordinal, ordinal);
      updateProofHash(accumulator.stable, stable);
      updateProofHash(accumulator.identity, identity);
      const boundary = referenceBoundaries.get(sessionId);
      const preservesRow = reference
        ? boundary !== undefined && boundary !== null && ordinal <= boundary
        : true;
      if (preservesRow) {
        accumulator.preservedCount += 1;
        updateProofHash(accumulator.preservedStable, stable);
        updateProofHash(accumulator.preservedIdentity, identity);
      }
      accumulators.set(sessionId, accumulator);
    }
    // The callback cursor makes the previous portal Result unreachable before
    // this callback receives the next batch. Collect at that exact ownership
    // boundary: a row-count interval is not a memory bound when event payload
    // sizes vary, and Bun does not observe the pod's cgroup limit soon enough.
    collectProofGarbage();
  });
  collectProofGarbage();

  const proofs = new Map<string, CutoverRelationProof>();
  const sessionIds = new Set([
    ...accumulators.keys(),
    ...(reference?.sessions.map((session) => session.id) ?? []),
  ]);
  for (const sessionId of sessionIds) {
    const accumulator = accumulators.get(sessionId) ?? newProofAccumulator();
    proofs.set(sessionId, {
      count: accumulator.count,
      maxOrdinal: accumulator.maxOrdinal,
      stableSha256: accumulator.stable.digest("hex"),
      identitySha256: accumulator.identity.digest("hex"),
      preservedCount: accumulator.preservedCount,
      preservedThroughOrdinal: reference
        ? (referenceBoundaries.get(sessionId) ?? null)
        : accumulator.maxOrdinal,
      preservedStableSha256: accumulator.preservedStable.digest("hex"),
      preservedIdentitySha256: accumulator.preservedIdentity.digest("hex"),
    });
  }
  return proofs;
}

function emptyRelationProof(): CutoverRelationProof {
  const digest = createHash("sha256").digest("hex");
  return {
    count: 0,
    maxOrdinal: null,
    stableSha256: digest,
    identitySha256: digest,
    preservedCount: 0,
    preservedThroughOrdinal: null,
    preservedStableSha256: digest,
    preservedIdentitySha256: digest,
  };
}

function idsEqual<T extends { id: string }>(before: T[], after: T[]): boolean {
  if (before.length !== after.length) return false;
  const afterIds = new Set(after.map((entry) => entry.id));
  return before.every((entry) => afterIds.has(entry.id));
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let index = 0;
  for (const value of haystack) {
    if (value === needle[index]) index += 1;
  }
  return index === needle.length;
}

function expectedMigratedTurnStatus(turn: CutoverTurn): string {
  if (turn.status === "running" || (turn.status === "queued" && turn.hasStartedEvidence)) {
    return "recovering";
  }
  if (
    turn.status === "queued" &&
    (turn.source === "scheduled_task" || turn.source === "system" || turn.source === "goal")
  ) {
    return "superseded";
  }
  return turn.status;
}

function humanQueue(turns: CutoverTurn[]): string[] {
  return turns
    .filter(
      (turn) =>
        turn.status === "queued" &&
        !turn.hasStartedEvidence &&
        (turn.source === "user" || turn.source === "api"),
    )
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((turn) => turn.id);
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export async function captureSessionControlCutoverSnapshot(
  sql: postgres.Sql,
  phase: CutoverPhase,
  capturedAt = new Date().toISOString(),
  reference?: SessionControlCutoverSnapshot,
): Promise<SessionControlCutoverSnapshot> {
  if (phase === "baseline" && reference) {
    throw new Error("a baseline capture cannot reference an earlier baseline");
  }
  if (phase !== "baseline") {
    if (!reference || reference.contractVersion !== SESSION_CONTROL_CUTOVER_CONTRACT) {
      throw new Error(`${phase} capture requires a v2 baseline proof`);
    }
    if (reference.phase !== "baseline") {
      throw new Error(`${phase} capture reference is not a baseline`);
    }
  }
  await assertSessionControlCutoverAuditAuthority(sql);
  const hasControl = await columnExists(sql, "sessions", "control_state");
  const hasAttempts = await columnExists(sql, "session_turns", "execution_generation");
  const hasWorkspaceControl = await columnExists(sql, "workspaces", "inference_state");
  const hasUpdates = await tableExists(sql, "session_system_updates");
  const hasPendingTools = await tableExists(sql, "session_pending_tool_calls");
  const hasUsageDuplicateAssociation = await columnExists(
    sql,
    "session_events",
    "duplicate_of_event_id",
  );
  const hasEnrollableScan = await functionExists(
    sql,
    "opengeni_private.list_enrollable_sessions(integer)",
  );
  const hasFrozenCredential = await columnExists(
    sql,
    "agent_run_states",
    "frozen_codex_credential_id",
  );

  const migrationRows = await unsafeRows(sql, `select name from schema_migrations order by name`);
  const workspaceRows = await unsafeRows(
    sql,
    `select id, account_id,
      ${hasWorkspaceControl ? "inference_state" : "null::text as inference_state"},
      ${hasWorkspaceControl ? "inference_generation" : "null::integer as inference_generation"}
     from workspaces order by id`,
  );
  const sessionRows = await unsafeRows(
    sql,
    `select id, account_id, workspace_id, status, temporal_workflow_id, active_turn_id,
       sandbox_group_id, active_sandbox_id, active_epoch,
       ${hasControl ? "control_state" : "null::text as control_state"},
       ${hasControl ? "control_generation" : "null::integer as control_generation"},
       ${hasControl ? "workspace_run_exception_generation" : "null::integer as workspace_run_exception_generation"},
       ${hasControl ? "queue_version" : "null::integer as queue_version"},
       ${hasControl ? "queue_head_position" : "null::bigint as queue_head_position"},
       ${hasControl ? "queue_tail_position" : "null::bigint as queue_tail_position"}
     from sessions order by id`,
  );
  const turnRows = await unsafeRows(
    sql,
    `select t.session_id, t.id, t.trigger_event_id, t.temporal_workflow_id, t.status, t.source,
       t.position, ${hasAttempts ? "t.version" : "null::integer as version"},
       ${hasAttempts ? "t.execution_generation" : "null::integer as execution_generation"},
       ${hasAttempts ? "t.active_attempt_id" : "null::uuid as active_attempt_id"},
       t.started_at, t.finished_at,
       exists (
         select 1 from session_events e
         where e.workspace_id = t.workspace_id and e.session_id = t.session_id
           and e.turn_id = t.id and e.type = 'turn.started'
       ) as has_started_evidence
     from session_turns t order by t.session_id, t.position, t.id`,
  );
  const goalRows = await unsafeRows(
    sql,
    `select session_id, id, status, version, auto_continuations, no_progress_streak,
       last_continuation_turn_id from session_goals order by session_id, id`,
  );
  const historyProofs = await captureRelationProofs(
    sql,
    `select session_id, id, turn_id, position, active, producer_codex_credential_id
     from session_history_items order by session_id, position, id`,
    "position",
    (row) => ({
      id: stringValue(row.id, "history.id"),
      turnId: nullableString(row.turn_id, "history.turn_id"),
      position: numberValue(row.position, "history.position"),
      active: booleanValue(row.active),
      producerCodexCredentialId: nullableString(
        row.producer_codex_credential_id,
        "history.producer_codex_credential_id",
      ),
    }),
    reference,
    (session) => session.historyProof,
  );
  const eventProofs = await captureRelationProofs(
    sql,
    `select session_id, id, turn_id, sequence
     from session_events order by session_id, sequence, id`,
    "sequence",
    (row) => ({
      id: stringValue(row.id, "event.id"),
      turnId: nullableString(row.turn_id, "event.turn_id"),
      sequence: numberValue(row.sequence, "event.sequence"),
    }),
    reference,
    (session) => session.eventProof,
  );
  const runStateRows = await unsafeRows(
    sql,
    `select session_id, id, turn_id, state_version,
       case when serialized_run_state ~ '^\\s*\\{' then
         serialized_run_state::jsonb ->> '$schemaVersion'
       else null end as schema_version,
       jsonb_array_length(pending_approvals) as pending_approval_count,
       ${hasFrozenCredential ? "frozen_codex_credential_id" : "null::uuid as frozen_codex_credential_id"}
     from agent_run_states order by session_id, state_version, id`,
  );
  const waiterRows = await unsafeRows(
    sql,
    `select session_id, id, goal_id, blocked_turn_id, workflow_id, generation, status,
       goal_version, control_generation, wake_revision, observed_wake_revision
     from codex_capacity_waiters order by session_id, id`,
  );
  const leaseRows = await unsafeRows(
    sql,
    `select s.id as session_id, l.id, l.sandbox_group_id, l.liveness, l.instance_id,
       l.backend, l.lease_epoch
     from sessions s join sandbox_leases l on l.workspace_id = s.workspace_id
       and l.sandbox_group_id = s.sandbox_group_id
     order by s.id, l.id`,
  );
  const updateRows = hasUpdates
    ? await unsafeRows(
        sql,
        `select session_id, id, kind, source_id, dedupe_key, state, delivered_turn_id
         from session_system_updates order by session_id, created_at, id`,
      )
    : [];
  const pendingToolRows = hasPendingTools
    ? await unsafeRows(
        sql,
        `select session_id, id, turn_id, execution_generation, attempt_id, call_id, call_type,
           result_recorded_at is not null as result_recorded
         from session_pending_tool_calls order by session_id, turn_id, call_id`,
      )
    : [];

  const turns = groupBySession(
    turnRows.map((row) => ({
      sessionId: stringValue(row.session_id, "turn.session_id"),
      id: stringValue(row.id, "turn.id"),
      triggerEventId: stringValue(row.trigger_event_id, "turn.trigger_event_id"),
      temporalWorkflowId: stringValue(row.temporal_workflow_id, "turn.temporal_workflow_id"),
      status: stringValue(row.status, "turn.status"),
      source: stringValue(row.source, "turn.source"),
      position: numberValue(row.position, "turn.position"),
      version: nullableNumber(row.version, "turn.version"),
      executionGeneration: nullableNumber(row.execution_generation, "turn.execution_generation"),
      activeAttemptId: nullableString(row.active_attempt_id, "turn.active_attempt_id"),
      startedAt: nullableTimestamp(row.started_at, "turn.started_at"),
      finishedAt: nullableTimestamp(row.finished_at, "turn.finished_at"),
      hasStartedEvidence: booleanValue(row.has_started_evidence),
    })),
  );
  const goals = groupBySession(
    goalRows.map((row) => ({
      sessionId: stringValue(row.session_id, "goal.session_id"),
      id: stringValue(row.id, "goal.id"),
      status: stringValue(row.status, "goal.status"),
      version: numberValue(row.version, "goal.version"),
      autoContinuations: numberValue(row.auto_continuations, "goal.auto_continuations"),
      noProgressStreak: numberValue(row.no_progress_streak, "goal.no_progress_streak"),
      lastContinuationTurnId: nullableString(
        row.last_continuation_turn_id,
        "goal.last_continuation_turn_id",
      ),
    })),
  );
  const runStates = groupBySession(
    runStateRows.map((row) => ({
      sessionId: stringValue(row.session_id, "run_state.session_id"),
      id: stringValue(row.id, "run_state.id"),
      turnId: nullableString(row.turn_id, "run_state.turn_id"),
      stateVersion: numberValue(row.state_version, "run_state.state_version"),
      schemaVersion: nullableString(row.schema_version, "run_state.schema_version"),
      pendingApprovalCount: numberValue(
        row.pending_approval_count,
        "run_state.pending_approval_count",
      ),
      frozenCodexCredentialId: nullableString(
        row.frozen_codex_credential_id,
        "run_state.frozen_codex_credential_id",
      ),
    })),
  );
  const capacityWaiters = groupBySession(
    waiterRows.map((row) => ({
      sessionId: stringValue(row.session_id, "capacity_waiter.session_id"),
      id: stringValue(row.id, "capacity_waiter.id"),
      goalId: stringValue(row.goal_id, "capacity_waiter.goal_id"),
      blockedTurnId: stringValue(row.blocked_turn_id, "capacity_waiter.blocked_turn_id"),
      workflowId: stringValue(row.workflow_id, "capacity_waiter.workflow_id"),
      generation: numberValue(row.generation, "capacity_waiter.generation"),
      status: stringValue(row.status, "capacity_waiter.status"),
      goalVersion: numberValue(row.goal_version, "capacity_waiter.goal_version"),
      controlGeneration: numberValue(row.control_generation, "capacity_waiter.control_generation"),
      wakeRevision: numberValue(row.wake_revision, "capacity_waiter.wake_revision"),
      observedWakeRevision: numberValue(
        row.observed_wake_revision,
        "capacity_waiter.observed_wake_revision",
      ),
    })),
  );
  const sandboxLeases = groupBySession(
    leaseRows.map((row) => ({
      sessionId: stringValue(row.session_id, "sandbox_lease.session_id"),
      id: stringValue(row.id, "sandbox_lease.id"),
      sandboxGroupId: stringValue(row.sandbox_group_id, "sandbox_lease.sandbox_group_id"),
      liveness: stringValue(row.liveness, "sandbox_lease.liveness"),
      instanceId: nullableString(row.instance_id, "sandbox_lease.instance_id"),
      backend: stringValue(row.backend, "sandbox_lease.backend"),
      leaseEpoch: numberValue(row.lease_epoch, "sandbox_lease.lease_epoch"),
    })),
  );
  const systemUpdates = groupBySession(
    updateRows.map((row) => ({
      sessionId: stringValue(row.session_id, "system_update.session_id"),
      id: stringValue(row.id, "system_update.id"),
      kind: stringValue(row.kind, "system_update.kind"),
      sourceId: stringValue(row.source_id, "system_update.source_id"),
      dedupeKey: stringValue(row.dedupe_key, "system_update.dedupe_key"),
      state: stringValue(row.state, "system_update.state"),
      deliveredTurnId: nullableString(row.delivered_turn_id, "system_update.delivered_turn_id"),
    })),
  );
  const pendingToolCalls = groupBySession(
    pendingToolRows.map((row) => ({
      sessionId: stringValue(row.session_id, "pending_tool.session_id"),
      id: stringValue(row.id, "pending_tool.id"),
      turnId: stringValue(row.turn_id, "pending_tool.turn_id"),
      executionGeneration: numberValue(
        row.execution_generation,
        "pending_tool.execution_generation",
      ),
      attemptId: stringValue(row.attempt_id, "pending_tool.attempt_id"),
      callId: stringValue(row.call_id, "pending_tool.call_id"),
      callType: stringValue(row.call_type, "pending_tool.call_type"),
      resultRecorded: booleanValue(row.result_recorded),
    })),
  );

  const sessions: CutoverSession[] = sessionRows.map((row) => {
    const id = stringValue(row.id, "session.id");
    return {
      id,
      accountId: stringValue(row.account_id, "session.account_id"),
      workspaceId: stringValue(row.workspace_id, "session.workspace_id"),
      status: stringValue(row.status, "session.status"),
      temporalWorkflowId: nullableString(row.temporal_workflow_id, "session.temporal_workflow_id"),
      activeTurnId: nullableString(row.active_turn_id, "session.active_turn_id"),
      sandboxGroupId: stringValue(row.sandbox_group_id, "session.sandbox_group_id"),
      activeSandboxId: nullableString(row.active_sandbox_id, "session.active_sandbox_id"),
      activeEpoch: numberValue(row.active_epoch, "session.active_epoch"),
      controlState: nullableString(row.control_state, "session.control_state"),
      controlGeneration: nullableNumber(row.control_generation, "session.control_generation"),
      workspaceRunExceptionGeneration: nullableNumber(
        row.workspace_run_exception_generation,
        "session.workspace_run_exception_generation",
      ),
      queueVersion: nullableNumber(row.queue_version, "session.queue_version"),
      queueHeadPosition: nullableNumber(row.queue_head_position, "session.queue_head_position"),
      queueTailPosition: nullableNumber(row.queue_tail_position, "session.queue_tail_position"),
      turns: turns.get(id) ?? [],
      goals: goals.get(id) ?? [],
      historyProof: historyProofs.get(id) ?? emptyRelationProof(),
      eventProof: eventProofs.get(id) ?? emptyRelationProof(),
      runStates: runStates.get(id) ?? [],
      capacityWaiters: capacityWaiters.get(id) ?? [],
      sandboxLeases: sandboxLeases.get(id) ?? [],
      systemUpdates: systemUpdates.get(id) ?? [],
      pendingToolCalls: pendingToolCalls.get(id) ?? [],
    };
  });

  const workspaces: CutoverWorkspace[] = workspaceRows.map((row) => ({
    id: stringValue(row.id, "workspace.id"),
    accountId: stringValue(row.account_id, "workspace.account_id"),
    inferenceState: nullableString(row.inference_state, "workspace.inference_state"),
    inferenceGeneration: nullableNumber(row.inference_generation, "workspace.inference_generation"),
  }));

  const currentStatuses = new Set(["running", "requires_action", "recovering", "waiting_capacity"]);
  let multipleCurrentInferences = 0;
  let queuedMachineTurns = 0;
  let invalidActiveTurnPointers = 0;
  for (const session of sessions) {
    const current = session.turns.filter((turn) => currentStatuses.has(turn.status));
    if (current.length > 1) multipleCurrentInferences += 1;
    queuedMachineTurns += session.turns.filter(
      (turn) => turn.status === "queued" && turn.source !== "user" && turn.source !== "api",
    ).length;
    const expected = current[0]?.id ?? null;
    if (session.activeTurnId !== expected) invalidActiveTurnPointers += 1;
  }
  const opaqueRows = await unsafeRows(
    sql,
    `select count(*)::integer as count from session_history_items
     where active = true and item ->> 'type' in ('compaction','compaction_summary')`,
  );
  const ownershipRows = hasAttempts
    ? await unsafeRows(
        sql,
        `select
          count(*) filter (where status = 'running' and active_attempt_id is null)::integer
            as running_without_attempt,
          count(*) filter (where status <> 'running' and active_attempt_id is not null)::integer
            as owned_non_running
         from session_turns`,
      )
    : [{ running_without_attempt: 0, owned_non_running: 0 }];
  const usageRows = hasUsageDuplicateAssociation
    ? await unsafeRows(
        sql,
        `select
          (select count(*)::integer from (
             select workspace_id, session_id, turn_id, payload ->> 'sourceKey'
             from session_events
             where type = 'agent.model.usage' and turn_association = 'current'
               and turn_id is not null and nullif(payload ->> 'sourceKey', '') is not null
             group by workspace_id, session_id, turn_id, payload ->> 'sourceKey'
             having count(*) > 1
           ) duplicate_sources) as duplicate_current_sources,
          (select count(*)::integer from session_events
             where type = 'agent.model.usage' and turn_association = 'duplicate'
               and (duplicate_of_event_id is null or duplicate_reason is null))
            as invalid_duplicate_associations`,
      )
    : [{ duplicate_current_sources: 0, invalid_duplicate_associations: 0 }];
  const enrollableRows = hasEnrollableScan
    ? await unsafeRows(
        sql,
        `select count(*)::integer as count
         from opengeni_private.list_enrollable_sessions(10000)`,
      )
    : [{ count: 0 }];
  const casualtyRows = await unsafeRows(
    sql,
    `select count(*)::integer as count from session_events
     where type = 'turn.failed'
       and payload ->> 'code' = 'worker_death_redispatch_exhausted'`,
  );

  const draft = {
    contractVersion: SESSION_CONTROL_CUTOVER_CONTRACT,
    phase,
    capturedAt,
    schemaMigrations: migrationRows.map((row) => stringValue(row.name, "schema_migration.name")),
    workspaces,
    sessions,
    proofBaselineSha256: reference?.sha256 ?? null,
    invariants: {
      multipleCurrentInferences,
      queuedMachineTurns,
      activeOpaqueCompactionItems: numberValue(opaqueRows[0]?.count ?? 0, "opaque count"),
      invalidActiveTurnPointers,
      runningTurnsWithoutAttempt: numberValue(
        ownershipRows[0]?.running_without_attempt ?? 0,
        "running turns without attempt",
      ),
      attemptOwnedNonRunningTurns: numberValue(
        ownershipRows[0]?.owned_non_running ?? 0,
        "attempt-owned non-running turns",
      ),
      duplicateCurrentUsageSources: numberValue(
        usageRows[0]?.duplicate_current_sources ?? 0,
        "duplicate current usage sources",
      ),
      invalidDuplicateUsageAssociations: numberValue(
        usageRows[0]?.invalid_duplicate_associations ?? 0,
        "invalid duplicate usage associations",
      ),
      enrollableSessions: numberValue(enrollableRows[0]?.count ?? 0, "enrollable sessions"),
      workerDeathRedispatchExhausted: numberValue(
        casualtyRows[0]?.count ?? 0,
        "worker death redispatch casualties",
      ),
    },
    identityCount: sessions.reduce(
      (count, session) =>
        count +
        1 +
        session.turns.length +
        session.goals.length +
        session.historyProof.count +
        session.eventProof.count +
        session.runStates.length +
        session.capacityWaiters.length +
        session.sandboxLeases.length +
        session.systemUpdates.length +
        session.pendingToolCalls.length,
      workspaces.length,
    ),
  };
  return { ...draft, sha256: sha256(draft) };
}

function compareStableRows<T extends { id: string }>(
  errors: string[],
  sessionId: string,
  name: string,
  before: T[],
  after: T[],
  exact: boolean,
): void {
  const afterById = new Map(after.map((row) => [row.id, row]));
  for (const row of before) {
    const observed = afterById.get(row.id);
    if (!observed) {
      errors.push(`${sessionId}: missing ${name} ${row.id}`);
      continue;
    }
    if (exact && stableJson(row) !== stableJson(observed)) {
      errors.push(`${sessionId}: ${name} ${row.id} changed during migration`);
    }
  }
  if (exact && !idsEqual(before, after)) {
    errors.push(`${sessionId}: ${name} identity set changed during migration`);
  }
}

function compareRelationProof(
  errors: string[],
  sessionId: string,
  name: string,
  before: CutoverRelationProof,
  after: CutoverRelationProof,
  mode: "migration" | "final-fate",
): void {
  if (after.preservedThroughOrdinal !== before.maxOrdinal) {
    errors.push(`${sessionId}: ${name} proof used the wrong baseline boundary`);
    return;
  }
  if (mode === "migration") {
    if (
      after.count !== before.count ||
      after.stableSha256 !== before.stableSha256 ||
      after.identitySha256 !== before.identitySha256
    ) {
      errors.push(`${sessionId}: ${name} changed during migration`);
    }
    return;
  }
  if (
    after.preservedCount !== before.count ||
    after.preservedIdentitySha256 !== before.identitySha256
  ) {
    errors.push(`${sessionId}: baseline ${name} identities were not preserved`);
  }
}

export function reconcileSessionControlCutover(
  baseline: SessionControlCutoverSnapshot,
  observed: SessionControlCutoverSnapshot,
  mode: "migration" | "final-fate",
): CutoverReconciliation {
  const errors: string[] = [];
  const fateCounts: Record<string, number> = {};
  if (baseline.contractVersion !== SESSION_CONTROL_CUTOVER_CONTRACT) {
    errors.push(`unsupported baseline contract ${baseline.contractVersion}`);
  }
  if (observed.contractVersion !== SESSION_CONTROL_CUTOVER_CONTRACT) {
    errors.push(`unsupported observed contract ${observed.contractVersion}`);
  }
  if (baseline.phase !== "baseline") errors.push("the first snapshot is not a baseline");
  if (mode === "migration" && observed.phase !== "migrated") {
    errors.push("migration reconciliation requires a migrated snapshot");
  }
  if (mode === "final-fate" && observed.phase !== "final") {
    errors.push("final-fate reconciliation requires a final snapshot");
  }
  if (observed.proofBaselineSha256 !== baseline.sha256) {
    errors.push("observed relation proofs were not derived from this baseline");
  }
  if (observed.invariants.multipleCurrentInferences !== 0) {
    errors.push("observed snapshot has multiple current inferences for a session");
  }
  if (observed.invariants.queuedMachineTurns !== 0) {
    errors.push("observed snapshot still has machine work in the human prompt queue");
  }
  if (observed.invariants.activeOpaqueCompactionItems !== 0) {
    errors.push("observed snapshot has active opaque compaction history");
  }
  if (observed.invariants.invalidActiveTurnPointers !== 0) {
    errors.push("observed snapshot has invalid active-turn pointers");
  }
  if (observed.invariants.runningTurnsWithoutAttempt !== 0) {
    errors.push("observed snapshot has running turns without registered attempts");
  }
  if (observed.invariants.attemptOwnedNonRunningTurns !== 0) {
    errors.push("observed snapshot has non-running turns with attempt owners");
  }
  if (observed.invariants.duplicateCurrentUsageSources !== 0) {
    errors.push("observed snapshot has duplicate current usage sources");
  }
  if (observed.invariants.invalidDuplicateUsageAssociations !== 0) {
    errors.push("observed snapshot has invalid duplicate usage associations");
  }

  const observedWorkspaces = new Map(
    observed.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  for (const workspace of baseline.workspaces) {
    const next = observedWorkspaces.get(workspace.id);
    if (!next) errors.push(`missing workspace ${workspace.id}`);
    else if (next.accountId !== workspace.accountId) {
      errors.push(`workspace ${workspace.id} changed account identity`);
    }
  }

  const observedSessions = new Map(observed.sessions.map((session) => [session.id, session]));
  for (const session of baseline.sessions) {
    const next = observedSessions.get(session.id);
    if (!next) {
      errors.push(`missing session ${session.id}`);
      continue;
    }
    increment(fateCounts, next.status);
    if (next.accountId !== session.accountId || next.workspaceId !== session.workspaceId) {
      errors.push(`${session.id}: account/workspace identity changed`);
    }
    if (
      next.sandboxGroupId !== session.sandboxGroupId ||
      next.activeSandboxId !== session.activeSandboxId ||
      next.activeEpoch !== session.activeEpoch
    ) {
      errors.push(`${session.id}: sandbox routing identity changed`);
    }

    const nextTurns = new Map(next.turns.map((turn) => [turn.id, turn]));
    for (const turn of session.turns) {
      const nextTurn = nextTurns.get(turn.id);
      if (!nextTurn) {
        errors.push(`${session.id}: missing turn ${turn.id}`);
        continue;
      }
      if (
        nextTurn.triggerEventId !== turn.triggerEventId ||
        nextTurn.temporalWorkflowId !== turn.temporalWorkflowId ||
        nextTurn.source !== turn.source
      ) {
        errors.push(`${session.id}: turn ${turn.id} changed causal identity`);
      }
      if (mode === "migration") {
        const expected = expectedMigratedTurnStatus(turn);
        if (nextTurn.status !== expected) {
          errors.push(
            `${session.id}: turn ${turn.id} expected ${expected}, got ${nextTurn.status}`,
          );
        }
        if (expected === "recovering" && nextTurn.activeAttemptId !== null) {
          errors.push(`${session.id}: recovering turn ${turn.id} retained an attempt owner`);
        }
      } else if (
        (turn.status === "running" || (turn.status === "queued" && turn.hasStartedEvidence)) &&
        nextTurn.status === "queued"
      ) {
        errors.push(`${session.id}: current inference ${turn.id} was converted into queue work`);
      }
    }

    const baselineQueue = humanQueue(session.turns);
    const observedQueue = next.turns
      .filter((turn) => turn.status === "queued")
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((turn) => turn.id);
    if (mode === "migration") {
      if (stableJson(baselineQueue) !== stableJson(observedQueue)) {
        errors.push(`${session.id}: human prompt queue order changed during migration`);
      }
    } else {
      const remainingBaseline = observedQueue.filter((id) => baselineQueue.includes(id));
      if (!isSubsequence(remainingBaseline, baselineQueue)) {
        errors.push(`${session.id}: remaining baseline prompts changed relative order`);
      }
    }

    compareStableRows(errors, session.id, "goal", session.goals, next.goals, mode === "migration");
    compareRelationProof(
      errors,
      session.id,
      "history",
      session.historyProof,
      next.historyProof,
      mode,
    );
    compareRelationProof(errors, session.id, "event", session.eventProof, next.eventProof, mode);
    compareStableRows(
      errors,
      session.id,
      "run state",
      session.runStates,
      next.runStates,
      mode === "migration",
    );
    compareStableRows(
      errors,
      session.id,
      "capacity waiter",
      session.capacityWaiters,
      next.capacityWaiters,
      mode === "migration",
    );
    compareStableRows(
      errors,
      session.id,
      "sandbox lease",
      session.sandboxLeases,
      next.sandboxLeases,
      mode === "migration",
    );

    for (const turn of session.turns) {
      if (
        turn.status !== "queued" ||
        turn.hasStartedEvidence ||
        (turn.source !== "scheduled_task" && turn.source !== "system")
      ) {
        continue;
      }
      const migrated = next.systemUpdates.find(
        (update) => update.sourceId === turn.id && update.dedupeKey === `migrated-turn:${turn.id}`,
      );
      if (!migrated) {
        errors.push(`${session.id}: machine turn ${turn.id} has no typed migrated update`);
      }
    }
  }

  const draft = {
    contractVersion: SESSION_CONTROL_CUTOVER_CONTRACT,
    mode,
    baselineSha256: baseline.sha256,
    observedSha256: observed.sha256,
    ok: errors.length === 0,
    errors,
    fateCounts,
  };
  return { ...draft, sha256: sha256(draft) };
}
