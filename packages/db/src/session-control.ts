import { createHash } from "node:crypto";
import {
  boundWorkspaceControlEvent,
  McpPersonalConnectionDelegations,
  workspaceControlUtf8Bytes,
  type SessionMcpApprovalPolicy,
  type TurnInitiatorContext,
} from "@opengeni/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";
import { closePendingSessionToolCallsInTransaction } from "./session-tool-call-settlement";
import {
  mirrorSessionRealtimeContextInTransaction,
  renderRealtimeHumanInputResponseContext,
} from "./session-realtime-mirror";

export const SESSION_ANCESTRY_LIMIT = 10_000;

export type WorkspaceControlLockMode = "none" | "share" | "update";
export type EffectiveControlState = "active" | "paused";
export type SessionCommandActor =
  | { type: "human" | "operator"; subjectId: string }
  | {
      type: "service";
      subjectId: string;
      subjectLabel?: string;
      context?: TurnInitiatorContext;
    }
  | {
      type: "agent_attempt";
      attemptId: string;
      sessionId: string;
      turnId: string;
      executionGeneration: number;
    };
export type SessionTurnAttemptOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "requires_action"
  | "waiting_capacity"
  | "interrupted_recoverable"
  | "lease_lost_recoverable"
  | "pre_cutover_closed";

export type EffectiveControlBlocker = {
  kind: "session" | "workspace";
  sessionId?: string;
  displayName: string;
  actor: string | null;
  reason: string | null;
  changedAt: Date | null;
  revision: number;
};

export type EffectiveControlResumeOption = {
  scope: "selected" | "session" | "workspace";
  targetId?: string;
  selectedStateAfter: EffectiveControlState;
  remainingPrimaryBlocker?: EffectiveControlBlocker;
  impactCopy: string;
};

export type EffectiveSessionControl = {
  state: EffectiveControlState;
  controlVersion: number;
  controlEtag: string;
  directState: EffectiveControlState;
  primaryBlocker: EffectiveControlBlocker | null;
  additionalBlockerCount: number;
  blockers: EffectiveControlBlocker[];
  resumeOptions: EffectiveControlResumeOption[];
  override: { rootSessionId: string; revision: number } | null;
  settlement: {
    state: "stopping";
    attemptCount: number;
    interruptionPendingCount: number;
    quiescencePendingCount: number;
  } | null;
};

type SettlementAttemptCounts = {
  attemptCount: number;
  interruptionPendingCount: number;
  quiescencePendingCount: number;
};

const NO_SETTLEMENT_ATTEMPTS: SettlementAttemptCounts = {
  attemptCount: 0,
  interruptionPendingCount: 0,
  quiescencePendingCount: 0,
};

export const SESSION_DISCOVERY_CONTROL_TITLE_MAX_CHARS = 200;
export const SESSION_DISCOVERY_CONTROL_TARGET_LIMIT = 100;

/**
 * Purpose-built control projection for session discovery. Full blocker evidence,
 * actors/reasons, resume options, etags, and settlement state remain available
 * from the ordinary session detail APIs; this shape is intentionally only what
 * `sessions_list` renders.
 */
export type SessionDiscoveryControl = {
  state: EffectiveControlState;
  primaryBlocker: {
    kind: "session" | "workspace";
    sessionId?: string;
    displayName: string;
    displayNameOriginalChars: number;
  } | null;
  additionalBlockerCount: number;
};

export function serializeEffectiveSessionControl(control: EffectiveSessionControl) {
  const blocker = (
    value: EffectiveControlBlocker,
  ): Omit<EffectiveControlBlocker, "changedAt"> & {
    changedAt: string | null;
  } => ({
    ...value,
    changedAt: value.changedAt?.toISOString() ?? null,
  });
  return {
    ...control,
    primaryBlocker: control.primaryBlocker ? blocker(control.primaryBlocker) : null,
    blockers: control.blockers.map(blocker),
    resumeOptions: control.resumeOptions.map(({ remainingPrimaryBlocker, ...option }) => ({
      ...option,
      ...(remainingPrimaryBlocker
        ? { remainingPrimaryBlocker: blocker(remainingPrimaryBlocker) }
        : {}),
    })),
  };
}

export type WorkspaceControlRow = {
  workspaceId: string;
  accountId: string;
  revision: number | string;
  workspaceState: string;
  workspacePauseRevision: number | string | null;
  reason: string | null;
  changedBy: string | null;
  changedAt: Date | string | null;
};

type AncestryRow = {
  targetId: string;
  sessionId: string;
  parentSessionId: string | null;
  title: string | null;
  directState: string;
  directPauseRevision: number | string | null;
  subtreeRunOverrideRevision: number | string | null;
  controlVersion: number | string;
  directControlChangedBy: string | null;
  directControlReason: string | null;
  directControlChangedAt: Date | string | null;
  depth: number | string;
  cycle: boolean;
};

type AncestryNode = Omit<AncestryRow, "targetId" | "depth" | "cycle">;

export type SessionCommandReceiptRow = typeof schema.sessionCommandReceipts.$inferSelect;

export class SessionControlInvariantError extends Error {
  readonly code = "SESSION_CONTROL_INVARIANT";

  constructor(message: string) {
    super(message);
    this.name = "SessionControlInvariantError";
  }
}

export class SessionControlConflictError extends Error {
  readonly code = "CONTROL_CHANGED";

  constructor(message = "The workstream control changed") {
    super(message);
    this.name = "SessionControlConflictError";
  }
}

export class SessionCommandIdempotencyError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("The operation key was already used with different input");
    this.name = "SessionCommandIdempotencyError";
  }
}

export class AgentCommandAuthorityError extends Error {
  constructor(
    readonly code: "CALLER_STALE" | "CALLER_INTERRUPTED" | "SELF_OR_ANCESTOR_PAUSE" | "SELF_STEER",
    message: string,
  ) {
    super(message);
    this.name = "AgentCommandAuthorityError";
  }
}

export async function assertAgentCommandAuthorityInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    actor: Extract<SessionCommandActor, { type: "agent_attempt" }>;
    targetSessionId: string;
    action: "pause" | "resume" | "steer" | "message" | "goal";
  },
): Promise<void> {
  if (input.action === "goal" && input.targetSessionId !== input.actor.sessionId) {
    throw new SessionControlInvariantError("An agent goal command must target its own session");
  }
  // Every command caller establishes the control/workspace prefix first.
  // Reusing the event-write helper here keeps cross-session actor authority on
  // the same UUID-ordered session -> exact turn -> exact attempt suffix.
  const authorityLocks = await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    sessionIds: [input.actor.sessionId, input.targetSessionId],
    turnIds: [input.actor.turnId],
    attemptIds: [input.actor.attemptId],
  });
  const lockedSessions = authorityLocks.sessions;
  if (!lockedSessions.some((row) => row.id === input.actor.sessionId)) {
    throw new AgentCommandAuthorityError("CALLER_STALE", "The calling session no longer exists");
  }
  if (!lockedSessions.some((row) => row.id === input.targetSessionId)) {
    throw new SessionControlInvariantError(`Target session not found: ${input.targetSessionId}`);
  }
  const rows = await db.execute<{
    attemptId: string;
    attemptState: string;
    attemptSessionId: string;
    attemptTurnId: string;
    executionGeneration: number;
    activeAttemptId: string | null;
    turnStatus: string;
    activeTurnId: string | null;
    interrupted: boolean;
  }>(sql`
    select
      attempt.id as "attemptId",
      attempt.state as "attemptState",
      attempt.session_id as "attemptSessionId",
      attempt.turn_id as "attemptTurnId",
      attempt.execution_generation as "executionGeneration",
      turn.active_attempt_id as "activeAttemptId",
      turn.status as "turnStatus",
      session.active_turn_id as "activeTurnId",
      exists (
        select 1
        from ${schema.sessionAttemptInterruptions} interruption
        where interruption.workspace_id = ${input.workspaceId}
          and interruption.attempt_id = attempt.id
          and interruption.state in ('pending', 'delivered', 'acknowledged')
      ) as interrupted
    from ${schema.sessionTurnAttempts} attempt
    join ${schema.sessionTurns} turn
      on turn.workspace_id = attempt.workspace_id and turn.id = attempt.turn_id
    join ${schema.sessions} session
      on session.workspace_id = attempt.workspace_id and session.id = attempt.session_id
    where attempt.workspace_id = ${input.workspaceId}
      and attempt.id = ${input.actor.attemptId}
  `);
  const caller = rows[0];
  if (
    !caller ||
    !["claimed", "running"].includes(caller.attemptState) ||
    caller.attemptSessionId !== input.actor.sessionId ||
    caller.attemptTurnId !== input.actor.turnId ||
    Number(caller.executionGeneration) !== input.actor.executionGeneration ||
    caller.activeAttemptId !== input.actor.attemptId ||
    caller.activeTurnId !== input.actor.turnId ||
    !["running", "requires_action", "recovering", "waiting_capacity"].includes(caller.turnStatus)
  ) {
    throw new AgentCommandAuthorityError(
      "CALLER_STALE",
      "The calling agent attempt no longer owns its turn",
    );
  }
  if (caller.interrupted) {
    throw new AgentCommandAuthorityError(
      "CALLER_INTERRUPTED",
      "The calling agent attempt is being interrupted",
    );
  }
  if (input.action === "steer" && input.targetSessionId === input.actor.sessionId) {
    throw new AgentCommandAuthorityError("SELF_STEER", "An agent cannot steer its own session");
  }
  if (input.action !== "pause") return;
  const ancestry = await db.execute<{
    containsCaller: boolean;
    invalid: boolean;
  }>(sql`
    with recursive caller_ancestry(id, parent_id, depth, path, cycle) as (
      select session.id, session.parent_session_id, 0, array[session.id], false
      from ${schema.sessions} session
      where session.workspace_id = ${input.workspaceId}
        and session.id = ${input.actor.sessionId}
      union all
      select parent.id, parent.parent_session_id, child.depth + 1,
             child.path || parent.id, parent.id = any(child.path)
      from caller_ancestry child
      join ${schema.sessions} parent
        on parent.workspace_id = ${input.workspaceId} and parent.id = child.parent_id
      where child.depth < ${SESSION_ANCESTRY_LIMIT} and not child.cycle
    )
    select
      coalesce(bool_or(id = ${input.targetSessionId}), false) as "containsCaller",
      coalesce(bool_or(cycle), false) or coalesce(max(depth), 0) >= ${SESSION_ANCESTRY_LIMIT}
        as invalid
    from caller_ancestry
  `);
  if (ancestry[0]?.invalid) {
    throw new SessionControlInvariantError("Caller ancestry is invalid");
  }
  if (ancestry[0]?.containsCaller) {
    throw new AgentCommandAuthorityError(
      "SELF_OR_ANCESTOR_PAUSE",
      "An agent cannot pause its own session or an ancestor workstream",
    );
  }
}

function asSafeRevision(value: number | string | null, label: string): number | null {
  if (value === null) return null;
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new SessionControlInvariantError(`${label} is not a safe non-negative revision`);
  }
  return revision;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalSessionCommandHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function controlEtag(value: unknown): string {
  return `sc1:${canonicalSessionCommandHash(value)}`;
}

function lockClause(mode: WorkspaceControlLockMode) {
  if (mode === "none") return sql.empty();
  return mode === "update" ? sql.raw("for update") : sql.raw("for share");
}

export async function lockWorkspaceInferenceControl(
  db: Database,
  workspaceId: string,
  mode: WorkspaceControlLockMode,
): Promise<WorkspaceControlRow> {
  const rows = await db.execute<WorkspaceControlRow>(sql`
    select
      workspace_id as "workspaceId",
      account_id as "accountId",
      revision,
      workspace_state as "workspaceState",
      workspace_pause_revision as "workspacePauseRevision",
      reason,
      changed_by as "changedBy",
      changed_at as "changedAt"
    from ${schema.workspaceInferenceControls}
    where workspace_id = ${workspaceId}
    ${lockClause(mode)}
  `);
  const row = rows[0];
  if (!row) {
    throw new SessionControlInvariantError(
      `Workspace ${workspaceId} has no mandatory inference-control row`,
    );
  }
  return row;
}

export type SessionEventWriteLockInput = {
  workspaceId: string;
  /**
   * Control-aware writes take this lock first. Callers that already hold the
   * workspace control row (for example a Pause mutation under FOR UPDATE) say
   * `already_locked`; ordinary audit/title appends explicitly use `none`.
   */
  controlLock: WorkspaceControlLockMode | "already_locked" | "none";
  /** Used only when a staged caller already established the workspace prefix. */
  workspaceLock?: "key_share" | "already_locked";
  sessionIds?: string[];
  turnIds?: string[];
  attemptIds?: string[];
};

export type SessionEventWriteLocks = {
  control: WorkspaceControlRow | null;
  workspace: typeof schema.workspaces.$inferSelect | null;
  sessions: Array<typeof schema.sessions.$inferSelect>;
  turns: Array<typeof schema.sessionTurns.$inferSelect>;
  attempts: Array<typeof schema.sessionTurnAttempts.$inferSelect>;
};

/**
 * Establish the one canonical lock prefix for every `session_events` writer:
 *
 *   workspace_inference_controls (when control-aware)
 *     -> actual workspaces row FOR KEY SHARE
 *     -> session rows FOR UPDATE, UUID ordered
 *     -> exact turn rows FOR UPDATE, UUID ordered
 *     -> exact attempt rows FOR UPDATE, UUID ordered
 *
 * `FOR KEY SHARE` is deliberate. Event inserts need the workspace key to remain
 * stable for their FK, but they do not mutate the workspace. The old generic
 * `FOR UPDATE` lock serialized unrelated sessions and inverted the activity
 * path's session -> implicit workspace-FK edge.
 *
 * Complex lifecycle transactions may acquire allocator/control locks before
 * this helper and may discover exact turn IDs only after locking the session.
 * They use the explicit `already_locked` stages, while retaining the same
 * monotonic table order. New event writers should prefer one complete call.
 */
export async function lockSessionEventWriteRows(
  db: Database,
  input: SessionEventWriteLockInput,
): Promise<SessionEventWriteLocks> {
  const controlLock = input.controlLock;
  const control =
    controlLock === "share" || controlLock === "update"
      ? await lockWorkspaceInferenceControl(db, input.workspaceId, controlLock)
      : null;

  let workspace: typeof schema.workspaces.$inferSelect | null = null;
  if ((input.workspaceLock ?? "key_share") === "key_share") {
    const [lockedWorkspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
      .for("key share")
      .limit(1);
    workspace = lockedWorkspace ?? null;
  }

  const sessionIds = [...new Set(input.sessionIds ?? [])].sort();
  const sessions =
    sessionIds.length > 0
      ? await db
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              inArray(schema.sessions.id, sessionIds),
            ),
          )
          .orderBy(schema.sessions.id)
          .for("update")
      : [];

  const turnIds = [...new Set(input.turnIds ?? [])].sort();
  const turns =
    turnIds.length > 0
      ? await db
          .select()
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              inArray(schema.sessionTurns.id, turnIds),
            ),
          )
          .orderBy(schema.sessionTurns.id)
          .for("update")
      : [];

  const attemptIds = [...new Set(input.attemptIds ?? [])].sort();
  const attempts =
    attemptIds.length > 0
      ? await db
          .select()
          .from(schema.sessionTurnAttempts)
          .where(
            and(
              eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
              inArray(schema.sessionTurnAttempts.id, attemptIds),
            ),
          )
          .orderBy(schema.sessionTurnAttempts.id)
          .for("update")
      : [];

  return { control, workspace, sessions, turns, attempts };
}

export async function registerSessionTurnAttemptClaim(
  db: Database,
  input: {
    id: string;
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    temporalWorkflowId: string;
    temporalWorkflowRunId: string;
    temporalActivityId: string;
    verifiedControlRevision: number;
    mcpApprovalPolicies: Record<string, SessionMcpApprovalPolicy>;
    connectorActionPolicies: schema.ConnectorActionPolicySnapshotEntry[];
  },
): Promise<typeof schema.sessionTurnAttempts.$inferSelect> {
  const [inserted] = await db
    .insert(schema.sessionTurnAttempts)
    .values({
      ...input,
      state: "claimed",
    })
    // Only an idempotent replay of this exact preallocated attempt ID may
    // enter the comparison path below. A collision on live-session, live-turn,
    // or Temporal dispatch ownership is a distinct invariant violation and
    // must not be disguised as an attempt-ID conflict.
    .onConflictDoNothing({ target: schema.sessionTurnAttempts.id })
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(schema.sessionTurnAttempts)
    .where(
      and(
        eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
        eq(schema.sessionTurnAttempts.id, input.id),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !existing ||
    existing.accountId !== input.accountId ||
    existing.sessionId !== input.sessionId ||
    existing.turnId !== input.turnId ||
    existing.executionGeneration !== input.executionGeneration ||
    existing.temporalWorkflowId !== input.temporalWorkflowId ||
    existing.temporalWorkflowRunId !== input.temporalWorkflowRunId ||
    existing.temporalActivityId !== input.temporalActivityId ||
    JSON.stringify(existing.connectorActionPolicies) !==
      JSON.stringify(input.connectorActionPolicies) ||
    existing.state === "closed"
  ) {
    throw new SessionControlInvariantError(
      `Attempt ${input.id} conflicts with a different or closed ownership chain`,
    );
  }
  return existing;
}

/**
 * Close the exact first-class owner while the caller still holds the owning
 * session/turn locks. Every path that clears `session_turns.active_attempt_id`
 * must call this in the same transaction; otherwise a later claim would either
 * collide with a zombie live owner or have to weaken the ownership fence.
 */
export async function closeSessionTurnAttemptInTransaction(
  db: Database,
  input: {
    id: string;
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    outcome: SessionTurnAttemptOutcome;
    closedAt?: Date;
  },
): Promise<{ action: "closed" | "already_closed" }> {
  const [attempt] = await db
    .select()
    .from(schema.sessionTurnAttempts)
    .where(
      and(
        eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
        eq(schema.sessionTurnAttempts.id, input.id),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !attempt ||
    attempt.accountId !== input.accountId ||
    attempt.sessionId !== input.sessionId ||
    attempt.turnId !== input.turnId ||
    attempt.executionGeneration !== input.executionGeneration
  ) {
    throw new SessionControlInvariantError(
      `Attempt ${input.id} does not own the expected session turn generation`,
    );
  }
  if (attempt.state === "closed") {
    if (attempt.outcome !== input.outcome) {
      throw new SessionControlInvariantError(
        `Attempt ${input.id} is already closed as ${attempt.outcome ?? "unknown"}`,
      );
    }
    return { action: "already_closed" };
  }
  if (attempt.state !== "claimed" && attempt.state !== "running") {
    throw new SessionControlInvariantError(
      `Attempt ${input.id} has invalid live state ${attempt.state}`,
    );
  }
  const now = input.closedAt ?? new Date();
  const [closed] = await db
    .update(schema.sessionTurnAttempts)
    .set({
      state: "closed",
      outcome: input.outcome,
      workerId: null,
      leaseId: null,
      leaseExpiresAt: null,
      closedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
        eq(schema.sessionTurnAttempts.id, input.id),
        sql`${schema.sessionTurnAttempts.state} in ('claimed', 'running')`,
      ),
    )
    .returning({ id: schema.sessionTurnAttempts.id });
  if (!closed) {
    throw new SessionControlInvariantError(`Attempt ${input.id} changed while locked`);
  }
  return { action: "closed" };
}

function targetValues(sessionIds: string[]) {
  if (sessionIds.length === 0) {
    throw new SessionControlInvariantError("At least one target session is required");
  }
  return sql.join(
    sessionIds.map((id) => sql`(${id}::uuid)`),
    sql`, `,
  );
}

const TARGET_PATH_PROJECTION_LIMIT = 128;

async function loadTargetAncestryRows(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
): Promise<AncestryRow[]> {
  return await db.execute<AncestryRow>(sql`
    with recursive targets(id) as (values ${targetValues(sessionIds)}),
    ancestry as (
      select
        target.id as target_id,
        session.id as session_id,
        session.parent_session_id,
        session.title,
        session.direct_control_state,
        session.direct_pause_revision,
        session.subtree_run_override_revision,
        session.control_version,
        session.direct_control_changed_by,
        session.direct_control_reason,
        session.direct_control_changed_at,
        0::integer as depth,
        array[session.id]::uuid[] as path,
        false as cycle
      from targets target
      join ${schema.sessions} session
        on session.workspace_id = ${workspaceId} and session.id = target.id
      union all
      select
        child.target_id,
        parent.id,
        parent.parent_session_id,
        parent.title,
        parent.direct_control_state,
        parent.direct_pause_revision,
        parent.subtree_run_override_revision,
        parent.control_version,
        parent.direct_control_changed_by,
        parent.direct_control_reason,
        parent.direct_control_changed_at,
        child.depth + 1,
        child.path || parent.id,
        parent.id = any(child.path)
      from ancestry child
      join ${schema.sessions} parent
        on parent.workspace_id = ${workspaceId} and parent.id = child.parent_session_id
      where child.parent_session_id is not null
        and not child.cycle
        and child.depth < ${SESSION_ANCESTRY_LIMIT}
    )
    select
      target_id as "targetId",
      session_id as "sessionId",
      parent_session_id as "parentSessionId",
      title,
      direct_control_state as "directState",
      direct_pause_revision as "directPauseRevision",
      subtree_run_override_revision as "subtreeRunOverrideRevision",
      control_version as "controlVersion",
      direct_control_changed_by as "directControlChangedBy",
      direct_control_reason as "directControlReason",
      direct_control_changed_at as "directControlChangedAt",
      depth,
      cycle
    from ancestry
    order by target_id, depth
  `);
}

async function loadAncestryNodes(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
): Promise<Map<string, AncestryNode>> {
  const rows = await db.execute<AncestryNode>(sql`
    with recursive targets(id) as (values ${targetValues(sessionIds)}),
    ancestry_ids(id) as (
      select session.id
      from targets target
      join ${schema.sessions} session
        on session.workspace_id = ${workspaceId} and session.id = target.id
      union
      select parent.id
      from ancestry_ids child
      join ${schema.sessions} current
        on current.workspace_id = ${workspaceId} and current.id = child.id
      join ${schema.sessions} parent
        on parent.workspace_id = current.workspace_id
       and parent.id = current.parent_session_id
    )
    select
      session.id as "sessionId",
      session.parent_session_id as "parentSessionId",
      session.title,
      session.direct_control_state as "directState",
      session.direct_pause_revision as "directPauseRevision",
      session.subtree_run_override_revision as "subtreeRunOverrideRevision",
      session.control_version as "controlVersion",
      session.direct_control_changed_by as "directControlChangedBy",
      session.direct_control_reason as "directControlReason",
      session.direct_control_changed_at as "directControlChangedAt"
    from ancestry_ids ancestry
    join ${schema.sessions} session
      on session.workspace_id = ${workspaceId} and session.id = ancestry.id
  `);
  return new Map(rows.map((row: AncestryNode) => [row.sessionId, row]));
}

function ancestryRowsForTarget(targetId: string, nodes: Map<string, AncestryNode>): AncestryRow[] {
  const rows: AncestryRow[] = [];
  const path = new Set<string>();
  let sessionId: string | null = targetId;
  for (let depth = 0; sessionId !== null; depth += 1) {
    const node = nodes.get(sessionId);
    if (!node) break;
    const cycle = path.has(sessionId);
    rows.push({ ...node, targetId, depth, cycle });
    if (cycle || depth >= SESSION_ANCESTRY_LIMIT) break;
    path.add(sessionId);
    sessionId = node.parentSessionId;
  }
  return rows;
}

function assertCompleteAncestry(sessionId: string, rows: AncestryRow[]): void {
  if (rows.length === 0) {
    throw new SessionControlInvariantError(`Session ${sessionId} does not exist in its workspace`);
  }
  if (rows.some((row) => row.cycle)) {
    throw new SessionControlInvariantError(`Session ${sessionId} has cyclic ancestry`);
  }
  const last = rows.at(-1)!;
  const depth = Number(last.depth);
  if (last.parentSessionId !== null) {
    throw new SessionControlInvariantError(
      depth >= SESSION_ANCESTRY_LIMIT
        ? `Session ${sessionId} ancestry exceeds ${SESSION_ANCESTRY_LIMIT}`
        : `Session ${sessionId} has a missing ancestor ${last.parentSessionId}`,
    );
  }
}

function blockerForSession(row: AncestryRow, revision: number): EffectiveControlBlocker {
  return {
    kind: "session",
    sessionId: row.sessionId,
    displayName: row.title?.trim() || "Untitled session",
    actor: row.directControlChangedBy,
    reason: row.directControlReason,
    changedAt: asDate(row.directControlChangedAt),
    revision,
  };
}

function projectEffectiveControl(
  workspace: WorkspaceControlRow,
  targetId: string,
  rows: AncestryRow[],
  settlementAttempts: SettlementAttemptCounts,
): EffectiveSessionControl {
  assertCompleteAncestry(targetId, rows);
  const workspaceRevision = asSafeRevision(workspace.revision, "workspace control revision")!;
  const path = rows.map((row) => ({
    row,
    depth: Number(row.depth),
    pauseRevision: asSafeRevision(row.directPauseRevision, "direct pause revision"),
    overrideRevision: asSafeRevision(
      row.subtreeRunOverrideRevision,
      "subtree run override revision",
    ),
    controlVersion: asSafeRevision(row.controlVersion, "session control version")!,
  }));

  const undefeated: Array<{ blocker: EffectiveControlBlocker; depth: number }> = [];
  for (const candidate of path) {
    if (candidate.row.directState !== "paused" || candidate.pauseRevision === null) continue;
    const defeated = path.some(
      (possibleOverride) =>
        possibleOverride.depth < candidate.depth &&
        possibleOverride.overrideRevision !== null &&
        possibleOverride.overrideRevision > candidate.pauseRevision!,
    );
    if (!defeated) {
      undefeated.push({
        blocker: blockerForSession(candidate.row, candidate.pauseRevision),
        depth: candidate.depth,
      });
    }
  }

  const workspacePauseRevision = asSafeRevision(
    workspace.workspacePauseRevision,
    "workspace pause revision",
  );
  if (workspace.workspaceState === "paused") {
    if (workspacePauseRevision === null) {
      throw new SessionControlInvariantError("Paused workspace is missing its pause revision");
    }
    const defeated = path.some(
      (candidate) =>
        candidate.overrideRevision !== null && candidate.overrideRevision > workspacePauseRevision,
    );
    if (!defeated) {
      undefeated.push({
        blocker: {
          kind: "workspace",
          displayName: "Workspace",
          actor: workspace.changedBy,
          reason: workspace.reason,
          changedAt: asDate(workspace.changedAt),
          revision: workspacePauseRevision,
        },
        depth: Number.POSITIVE_INFINITY,
      });
    }
  }

  undefeated.sort((left, right) => left.depth - right.depth);
  const blockers = undefeated.map(({ blocker }) => blocker);
  const primaryBlocker = blockers[0] ?? null;
  const target = path[0]!;
  const override = path
    .filter((candidate) => candidate.overrideRevision !== null)
    .sort((left, right) => right.overrideRevision! - left.overrideRevision!)[0];

  const options: EffectiveControlResumeOption[] = [];
  if (blockers.length > 0) {
    options.push({
      scope: "selected",
      targetId,
      selectedStateAfter: "active",
      impactCopy: "Resume this session and its descendants without changing sibling workstreams.",
    });
    for (const entry of undefeated) {
      if (entry.blocker.kind !== "session" || entry.blocker.sessionId === targetId) continue;
      const remaining = undefeated.find(
        (candidate) =>
          candidate.depth < entry.depth && candidate.blocker.sessionId !== entry.blocker.sessionId,
      )?.blocker;
      options.push({
        scope: "session",
        targetId: entry.blocker.sessionId!,
        selectedStateAfter: remaining ? "paused" : "active",
        ...(remaining ? { remainingPrimaryBlocker: remaining } : {}),
        impactCopy: `Resume the workstream rooted at ${entry.blocker.displayName}.`,
      });
    }
    if (workspace.workspaceState === "paused") {
      const remaining = undefeated.find((entry) => entry.blocker.kind === "session")?.blocker;
      options.push({
        scope: "workspace",
        selectedStateAfter: remaining ? "paused" : "active",
        ...(remaining ? { remainingPrimaryBlocker: remaining } : {}),
        impactCopy: "Resume the entire workspace; narrower session pauses remain in force.",
      });
    }
  }

  const etagFacts = {
    workspace: {
      state: workspace.workspaceState,
      pauseRevision: workspacePauseRevision,
    },
    path: path.map((candidate) => ({
      sessionId: candidate.row.sessionId,
      directState: candidate.row.directState,
      pauseRevision: candidate.pauseRevision,
      overrideRevision: candidate.overrideRevision,
    })),
  };

  return {
    state: blockers.length > 0 ? "paused" : "active",
    controlVersion: Math.max(
      workspaceRevision,
      ...path.map((candidate) => candidate.controlVersion),
    ),
    controlEtag: controlEtag(etagFacts),
    directState: target.row.directState === "paused" ? "paused" : "active",
    primaryBlocker,
    additionalBlockerCount: Math.max(0, blockers.length - 1),
    blockers,
    resumeOptions: options,
    override:
      override?.overrideRevision === null || !override
        ? null
        : {
            rootSessionId: override.row.sessionId,
            revision: override.overrideRevision,
          },
    settlement:
      settlementAttempts.attemptCount > 0 ? { state: "stopping", ...settlementAttempts } : null,
  };
}

async function settlementAttemptCounts(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
): Promise<Map<string, SettlementAttemptCounts>> {
  const rows = await db.execute<{
    sessionId: string;
    attemptCount: number | string;
    interruptionPendingCount: number | string;
    quiescencePendingCount: number | string;
  }>(sql`
    with recursive targets(id) as (values ${targetValues(sessionIds)}),
    interruptions as (
      select
        interruption.session_id,
        interruption.attempt_id,
        bool_or(interruption.state in ('pending', 'delivered', 'acknowledged'))
          as interruption_pending,
        bool_or(
          interruption.state in ('settled', 'rejected_stale')
          and attempt.quiesced_at is null
        ) as quiescence_pending
      from ${schema.sessionAttemptInterruptions} interruption
      join ${schema.sessionTurnAttempts} attempt
        on attempt.workspace_id = interruption.workspace_id
       and attempt.id = interruption.attempt_id
      where interruption.workspace_id = ${workspaceId}
        and (
          interruption.state in ('pending', 'delivered', 'acknowledged')
          or (
            interruption.state in ('settled', 'rejected_stale')
            and attempt.quiesced_at is null
          )
        )
      group by interruption.session_id, interruption.attempt_id
    ), interruption_ancestry(
      session_id,
      ancestor_id,
      attempt_id,
      interruption_pending,
      quiescence_pending,
      depth,
      path
    ) as (
      select
        interruption.session_id,
        interruption.session_id,
        interruption.attempt_id,
        interruption.interruption_pending,
        interruption.quiescence_pending,
        0::integer,
        array[interruption.session_id]::uuid[]
      from interruptions interruption
      union all
      select
        ancestry.session_id,
        current.parent_session_id,
        ancestry.attempt_id,
        ancestry.interruption_pending,
        ancestry.quiescence_pending,
        ancestry.depth + 1,
        ancestry.path || current.parent_session_id
      from interruption_ancestry ancestry
      join ${schema.sessions} current
        on current.workspace_id = ${workspaceId} and current.id = ancestry.ancestor_id
      where current.parent_session_id is not null
        and not current.parent_session_id = any(ancestry.path)
        and ancestry.depth < ${SESSION_ANCESTRY_LIMIT}
    )
    select
      target.id as "sessionId",
      count(distinct ancestry.attempt_id)::integer as "attemptCount",
      count(distinct ancestry.attempt_id)
        filter (where ancestry.interruption_pending)::integer as "interruptionPendingCount",
      count(distinct ancestry.attempt_id)
        filter (where ancestry.quiescence_pending)::integer as "quiescencePendingCount"
    from targets target
    join interruption_ancestry ancestry on ancestry.ancestor_id = target.id
    group by target.id
  `);
  return new Map(
    rows.map(
      (row: {
        sessionId: string;
        attemptCount: number | string;
        interruptionPendingCount: number | string;
        quiescencePendingCount: number | string;
      }) => [
        row.sessionId,
        {
          attemptCount: Number(row.attemptCount),
          interruptionPendingCount: Number(row.interruptionPendingCount),
          quiescencePendingCount: Number(row.quiescencePendingCount),
        },
      ],
    ),
  );
}

export async function evaluateSessionControls(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
  options: {
    lock?: WorkspaceControlLockMode;
    /** Reuse a control row already locked before workspace/session/turn rows. */
    workspaceControl?: WorkspaceControlRow | undefined;
  } = {},
): Promise<Map<string, EffectiveSessionControl>> {
  const uniqueIds = [...new Set(sessionIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }
  if (options.workspaceControl && options.workspaceControl.workspaceId !== workspaceId) {
    throw new SessionControlInvariantError(
      `Locked workspace control ${options.workspaceControl.workspaceId} does not match ${workspaceId}`,
    );
  }
  const workspace =
    options.workspaceControl ??
    (await lockWorkspaceInferenceControl(db, workspaceId, options.lock ?? "share"));
  const stopping = await settlementAttemptCounts(db, workspaceId, uniqueIds);
  const result = new Map<string, EffectiveSessionControl>();
  if (uniqueIds.length <= TARGET_PATH_PROJECTION_LIMIT) {
    // PostgreSQL's direct target-path plan is substantially faster for the
    // ordinary one-session and paged-list cases. Keep its bounded row shape.
    const ancestry = await loadTargetAncestryRows(db, workspaceId, uniqueIds);
    const ancestryByTarget = new Map<string, AncestryRow[]>();
    for (const row of ancestry) {
      const rows = ancestryByTarget.get(row.targetId);
      if (rows) rows.push(row);
      else ancestryByTarget.set(row.targetId, [row]);
    }
    for (const sessionId of uniqueIds) {
      result.set(
        sessionId,
        projectEffectiveControl(
          workspace,
          sessionId,
          ancestryByTarget.get(sessionId) ?? [],
          stopping.get(sessionId) ?? NO_SETTLEMENT_ATTEMPTS,
        ),
      );
    }
    return result;
  }

  // Large sets fetch each shared ancestor exactly once. Returning one row per
  // target/ancestor pair makes a 10k-session tree explode into millions of
  // protocol objects even though the tree itself contains only 10k nodes.
  const ancestry = await loadAncestryNodes(db, workspaceId, uniqueIds);
  for (const sessionId of uniqueIds) {
    result.set(
      sessionId,
      projectEffectiveControl(
        workspace,
        sessionId,
        ancestryRowsForTarget(sessionId, ancestry),
        stopping.get(sessionId) ?? NO_SETTLEMENT_ATTEMPTS,
      ),
    );
  }
  return result;
}

type SessionDiscoveryControlRow = {
  targetId: string;
  ancestryCount: number | string;
  reachedRoot: boolean;
  maxDepth: number | string | null;
  blockerCount: number | string;
  primaryKind: "session" | "workspace" | null;
  primarySessionId: string | null;
  primaryDisplayName: string | null;
  primaryDisplayNameOriginalChars: number | string | null;
};

/**
 * Return one compact aggregate row per target for `sessions_list`.
 *
 * Unlike `evaluateSessionControls`, the database boundary never returns a row
 * per blocker/ancestor, nor does application code construct blocker or resume
 * option arrays. The recursive walk carries no growing visited-path array: a
 * missing ancestor stops below the limit, while a cycle cannot reach a root and
 * therefore runs into the hard `SESSION_ANCESTRY_LIMIT`. The externally
 * supplied target set is capped by `SESSION_DISCOVERY_CONTROL_TARGET_LIMIT`.
 */
export async function evaluateSessionDiscoveryControls(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
): Promise<Map<string, SessionDiscoveryControl>> {
  const uniqueIds = [...new Set(sessionIds)];
  if (uniqueIds.length === 0) return new Map();
  if (uniqueIds.length > SESSION_DISCOVERY_CONTROL_TARGET_LIMIT) {
    throw new SessionControlInvariantError(
      `Session discovery control projection exceeds ${SESSION_DISCOVERY_CONTROL_TARGET_LIMIT} targets`,
    );
  }

  const workspace = await lockWorkspaceInferenceControl(db, workspaceId, "share");
  const workspacePauseRevision = asSafeRevision(
    workspace.workspacePauseRevision,
    "workspace pause revision",
  );
  if (workspace.workspaceState === "paused" && workspacePauseRevision === null) {
    throw new SessionControlInvariantError("Paused workspace is missing its pause revision");
  }

  const rows = await db.execute<SessionDiscoveryControlRow>(sql`
    with recursive targets(id) as (values ${targetValues(uniqueIds)}),
    ancestry as (
      select
        target.id as target_id,
        session.id as session_id,
        session.parent_session_id,
        left(coalesce(nullif(btrim(session.title), ''), 'Untitled session'), ${SESSION_DISCOVERY_CONTROL_TITLE_MAX_CHARS}) as display_name,
        char_length(coalesce(nullif(btrim(session.title), ''), 'Untitled session'))::integer as display_name_original_chars,
        session.direct_control_state,
        session.direct_pause_revision,
        session.subtree_run_override_revision,
        0::integer as depth
      from targets target
      join ${schema.sessions} session
        on session.workspace_id = ${workspaceId} and session.id = target.id
      union all
      select
        child.target_id,
        parent.id,
        parent.parent_session_id,
        left(coalesce(nullif(btrim(parent.title), ''), 'Untitled session'), ${SESSION_DISCOVERY_CONTROL_TITLE_MAX_CHARS}),
        char_length(coalesce(nullif(btrim(parent.title), ''), 'Untitled session'))::integer,
        parent.direct_control_state,
        parent.direct_pause_revision,
        parent.subtree_run_override_revision,
        child.depth + 1
      from ancestry child
      join ${schema.sessions} parent
        on parent.workspace_id = ${workspaceId} and parent.id = child.parent_session_id
      where child.parent_session_id is not null
        and child.depth < ${SESSION_ANCESTRY_LIMIT}
    ),
    path as (
      select
        ancestry.*,
        max(ancestry.subtree_run_override_revision) over (
          partition by ancestry.target_id
          order by ancestry.depth
          rows between unbounded preceding and 1 preceding
        ) as descendant_override_revision
      from ancestry
    ),
    session_blockers as (
      select
        path.target_id,
        'session'::text as kind,
        path.session_id,
        path.display_name,
        path.display_name_original_chars,
        path.depth
      from path
      where path.direct_control_state = 'paused'
        and path.direct_pause_revision is not null
        and (
          path.descendant_override_revision is null
          or path.descendant_override_revision <= path.direct_pause_revision
        )
    ),
    workspace_blockers as (
      select
        target.id as target_id,
        'workspace'::text as kind,
        null::uuid as session_id,
        'Workspace'::text as display_name,
        9::integer as display_name_original_chars,
        ${SESSION_ANCESTRY_LIMIT + 1}::integer as depth
      from targets target
      where ${workspace.workspaceState === "paused"}
        and not exists (
          select 1
          from path
          where path.target_id = target.id
            and path.subtree_run_override_revision is not null
            and path.subtree_run_override_revision > ${workspacePauseRevision}
        )
    ),
    blockers as (
      select * from session_blockers
      union all
      select * from workspace_blockers
    ),
    primary_blockers as (
      select distinct on (blockers.target_id)
        blockers.target_id,
        blockers.kind,
        blockers.session_id,
        blockers.display_name,
        blockers.display_name_original_chars
      from blockers
      order by blockers.target_id, blockers.depth
    ),
    blocker_counts as (
      select blockers.target_id, count(*)::integer as blocker_count
      from blockers
      group by blockers.target_id
    ),
    ancestry_metadata as (
      select
        ancestry.target_id,
        count(*)::integer as ancestry_count,
        bool_or(ancestry.parent_session_id is null) as reached_root,
        max(ancestry.depth)::integer as max_depth
      from ancestry
      group by ancestry.target_id
    )
    select
      target.id as "targetId",
      coalesce(metadata.ancestry_count, 0)::integer as "ancestryCount",
      coalesce(metadata.reached_root, false) as "reachedRoot",
      metadata.max_depth as "maxDepth",
      coalesce(counts.blocker_count, 0)::integer as "blockerCount",
      primary_blocker.kind as "primaryKind",
      primary_blocker.session_id as "primarySessionId",
      primary_blocker.display_name as "primaryDisplayName",
      primary_blocker.display_name_original_chars as "primaryDisplayNameOriginalChars"
    from targets target
    left join ancestry_metadata metadata on metadata.target_id = target.id
    left join blocker_counts counts on counts.target_id = target.id
    left join primary_blockers primary_blocker on primary_blocker.target_id = target.id
    order by target.id
  `);

  const result = new Map<string, SessionDiscoveryControl>();
  for (const row of rows) {
    const ancestryCount = Number(row.ancestryCount);
    const maxDepth = row.maxDepth === null ? null : Number(row.maxDepth);
    if (ancestryCount === 0) {
      throw new SessionControlInvariantError(
        `Session ${row.targetId} does not exist in its workspace`,
      );
    }
    if (!row.reachedRoot) {
      throw new SessionControlInvariantError(
        maxDepth !== null && maxDepth >= SESSION_ANCESTRY_LIMIT
          ? `Session ${row.targetId} ancestry exceeds ${SESSION_ANCESTRY_LIMIT}`
          : `Session ${row.targetId} has a missing ancestor`,
      );
    }

    const blockerCount = Number(row.blockerCount);
    const primaryBlocker = row.primaryKind
      ? {
          kind: row.primaryKind,
          ...(row.primarySessionId ? { sessionId: row.primarySessionId } : {}),
          displayName:
            row.primaryDisplayName ??
            (row.primaryKind === "workspace" ? "Workspace" : "Untitled session"),
          displayNameOriginalChars: Number(
            row.primaryDisplayNameOriginalChars ??
              (row.primaryKind === "workspace" ? 9 : "Untitled session".length),
          ),
        }
      : null;
    if (blockerCount > 0 !== (primaryBlocker !== null)) {
      throw new SessionControlInvariantError(
        `Session ${row.targetId} discovery blocker aggregate is inconsistent`,
      );
    }
    result.set(row.targetId, {
      state: blockerCount > 0 ? "paused" : "active",
      primaryBlocker,
      additionalBlockerCount: Math.max(0, blockerCount - 1),
    });
  }
  if (result.size !== uniqueIds.length) {
    throw new SessionControlInvariantError("Session discovery control projection is incomplete");
  }
  return result;
}

export async function evaluateSessionControl(
  db: Database,
  workspaceId: string,
  sessionId: string,
  options: {
    lock?: WorkspaceControlLockMode;
    workspaceControl?: WorkspaceControlRow | undefined;
  } = {},
): Promise<EffectiveSessionControl> {
  return (await evaluateSessionControls(db, workspaceId, [sessionId], options)).get(sessionId)!;
}

async function findCommandReceipt(
  db: Database,
  input: {
    workspaceId: string;
    actor: SessionCommandActor;
    action: string;
    targetSessionId: string | null;
    targetTurnId: string | null;
    operationKey: string;
    identityScope: "actor" | "goal_operation";
  },
): Promise<SessionCommandReceiptRow | null> {
  const actorSubjectId = input.actor.type === "agent_attempt" ? null : input.actor.subjectId;
  const actorAttemptId = input.actor.type === "agent_attempt" ? input.actor.attemptId : null;
  const identity =
    input.identityScope === "goal_operation"
      ? and(
          eq(schema.sessionCommandReceipts.workspaceId, input.workspaceId),
          eq(schema.sessionCommandReceipts.actorType, "agent_attempt"),
          eq(schema.sessionCommandReceipts.action, input.action),
          eq(schema.sessionCommandReceipts.targetSessionId, input.targetSessionId!),
          sql`${schema.sessionCommandReceipts.targetTurnId} is null`,
          eq(schema.sessionCommandReceipts.operationKey, input.operationKey),
        )
      : and(
          eq(schema.sessionCommandReceipts.workspaceId, input.workspaceId),
          eq(schema.sessionCommandReceipts.actorType, input.actor.type),
          sql`${schema.sessionCommandReceipts.actorSubjectId} is not distinct from ${actorSubjectId}`,
          sql`${schema.sessionCommandReceipts.actorAttemptId} is not distinct from ${actorAttemptId}::uuid`,
          eq(schema.sessionCommandReceipts.action, input.action),
          sql`${schema.sessionCommandReceipts.targetSessionId} is not distinct from ${input.targetSessionId}::uuid`,
          sql`${schema.sessionCommandReceipts.targetTurnId} is not distinct from ${input.targetTurnId}::uuid`,
          eq(schema.sessionCommandReceipts.operationKey, input.operationKey),
        );
  const rows = await db.select().from(schema.sessionCommandReceipts).where(identity).for("update");
  return rows[0] ?? null;
}

export async function reserveSessionCommandReceipt(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actor: SessionCommandActor;
    action: string;
    targetSessionId: string | null;
    targetTurnId: string | null;
    operationKey: string;
    canonicalRequestHash: string;
    identityScope?: "actor" | "goal_operation";
  },
): Promise<{ receipt: SessionCommandReceiptRow; replay: boolean }> {
  if (!input.operationKey.trim()) throw new Error("operationKey must not be empty");
  const identityScope = input.identityScope ?? "actor";
  if (
    identityScope === "goal_operation" &&
    (input.actor.type !== "agent_attempt" ||
      input.action !== "goal.update" ||
      input.targetSessionId === null ||
      input.targetTurnId !== null)
  ) {
    throw new SessionControlInvariantError(
      "Target-scoped receipt identity is reserved for agent goal.update commands",
    );
  }
  const actorSubjectId = input.actor.type === "agent_attempt" ? null : input.actor.subjectId;
  const actorAttemptId = input.actor.type === "agent_attempt" ? input.actor.attemptId : null;
  const [inserted] = await db
    .insert(schema.sessionCommandReceipts)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      actorType: input.actor.type,
      actorSubjectId,
      actorAttemptId,
      action: input.action,
      targetSessionId: input.targetSessionId,
      targetTurnId: input.targetTurnId,
      operationKey: input.operationKey,
      canonicalRequestHash: input.canonicalRequestHash,
    })
    .onConflictDoNothing()
    .returning();
  const receipt =
    inserted ??
    (await findCommandReceipt(db, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: input.action,
      targetSessionId: input.targetSessionId,
      targetTurnId: input.targetTurnId,
      operationKey: input.operationKey,
      identityScope,
    }));
  if (!receipt) throw new SessionControlInvariantError("Command receipt conflict was not readable");
  if (receipt.canonicalRequestHash !== input.canonicalRequestHash) {
    throw new SessionCommandIdempotencyError();
  }
  return { receipt, replay: !inserted };
}

function nextRevision(workspace: WorkspaceControlRow): number {
  const current = asSafeRevision(workspace.revision, "workspace control revision")!;
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new SessionControlInvariantError("Workspace control revision is exhausted");
  }
  return current + 1;
}

async function advanceWorkspaceRevision(
  db: Database,
  workspaceId: string,
  revision: number,
): Promise<void> {
  const rows = await db
    .update(schema.workspaceInferenceControls)
    .set({ revision, updatedAt: new Date() })
    .where(
      and(
        eq(schema.workspaceInferenceControls.workspaceId, workspaceId),
        eq(schema.workspaceInferenceControls.revision, revision - 1),
      ),
    )
    .returning({ workspaceId: schema.workspaceInferenceControls.workspaceId });
  if (rows.length !== 1) {
    throw new SessionControlInvariantError(
      "Workspace control revision did not advance exactly once",
    );
  }
}

async function registerContinuableWakes(
  db: Database,
  input: { workspaceId: string; rootSessionId: string | null; reason: string },
): Promise<number> {
  const rows = await db.execute<{ wakeCount: number | string }>(sql`
    with eligible as (
      select *
      from opengeni_private.list_continuable_sessions(
        ${input.workspaceId}::uuid,
        ${input.rootSessionId}::uuid
      )
    ), upserted as (
      insert into ${schema.sessionWorkflowWakeOutbox} (
        session_id, account_id, workspace_id, temporal_workflow_id, reason
      )
      select session_id, account_id, workspace_id, temporal_workflow_id, ${input.reason}
      from eligible
      on conflict (session_id) do update set
        wake_revision = ${schema.sessionWorkflowWakeOutbox}.wake_revision + 1,
        temporal_workflow_id = excluded.temporal_workflow_id,
        reason = excluded.reason,
        attempts = 0,
        next_attempt_at = now(),
        last_error = null,
        updated_at = now()
      returning session_id
    )
    select count(*)::bigint as "wakeCount" from upserted
  `);
  return Number(rows[0]?.wakeCount ?? 0);
}

async function registerDescendantWakes(
  db: Database,
  input: { workspaceId: string; sessionId: string; reason: string },
): Promise<number> {
  return await registerContinuableWakes(db, {
    workspaceId: input.workspaceId,
    rootSessionId: input.sessionId,
    reason: input.reason,
  });
}

async function registerWorkspaceWakes(
  db: Database,
  input: { workspaceId: string; reason: string },
): Promise<number> {
  return await registerContinuableWakes(db, {
    workspaceId: input.workspaceId,
    rootSessionId: null,
    reason: input.reason,
  });
}

/**
 * Pause never needs to rediscover ordinary continuable work: it closes
 * admission. Only workflows owning an interruption created by this exact
 * command must wake so they can settle their in-flight attempt. The operation
 * receipt is indexed and bounds this to the number of affected attempts rather
 * than the size or depth of the paused tree.
 */
async function registerInterruptionWakes(
  db: Database,
  input: { operationId: string; reason: string },
): Promise<number> {
  const rows = await db.execute<{ wakeCount: number | string }>(sql`
    with eligible as (
      select distinct
        session.id as session_id,
        session.account_id,
        session.workspace_id,
        coalesce(session.temporal_workflow_id, 'session-' || session.id::text)
          as temporal_workflow_id
      from ${schema.sessionAttemptInterruptions} interruption
      join ${schema.sessions} session
        on session.workspace_id = interruption.workspace_id
       and session.id = interruption.session_id
      where interruption.operation_id = ${input.operationId}::uuid
        and interruption.state in ('pending', 'delivered', 'acknowledged')
    ), upserted as (
      insert into ${schema.sessionWorkflowWakeOutbox} (
        session_id, account_id, workspace_id, temporal_workflow_id, reason
      )
      select session_id, account_id, workspace_id, temporal_workflow_id, ${input.reason}
      from eligible
      on conflict (session_id) do update set
        wake_revision = ${schema.sessionWorkflowWakeOutbox}.wake_revision + 1,
        temporal_workflow_id = excluded.temporal_workflow_id,
        reason = excluded.reason,
        attempts = 0,
        next_attempt_at = now(),
        last_error = null,
        updated_at = now()
      returning session_id
    )
    select count(*)::bigint as "wakeCount" from upserted
  `);
  return Number(rows[0]?.wakeCount ?? 0);
}

/**
 * Terminal cancellation must wake every affected workflow, including sessions
 * parked at an approval, capacity, or other no-active-attempt boundary. Those
 * sessions have no new interruption row, so the ordinary Pause wake selector
 * cannot discover them. Signal-with-start is intentional here: a closed
 * workflow cheaply re-reads the terminal row and exits, while an open workflow
 * is released from an otherwise unbounded durable wait.
 */
async function registerCancellationWakes(
  db: Database,
  input: { workspaceId: string; sessionIds: string[] },
): Promise<number> {
  if (input.sessionIds.length === 0) return 0;
  const sessionIds = sql.join(
    input.sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await db.execute<{ wakeCount: number | string }>(sql`
    with eligible as (
      select
        session.id as session_id,
        session.account_id,
        session.workspace_id,
        coalesce(session.temporal_workflow_id, 'session-' || session.id::text)
          as temporal_workflow_id
      from ${schema.sessions} session
      where session.workspace_id = ${input.workspaceId}
        and session.id in (${sessionIds})
    ), upserted as (
      insert into ${schema.sessionWorkflowWakeOutbox} (
        session_id, account_id, workspace_id, temporal_workflow_id, reason
      )
      select session_id, account_id, workspace_id, temporal_workflow_id, 'session_cancelled'
      from eligible
      on conflict (session_id) do update set
        wake_revision = ${schema.sessionWorkflowWakeOutbox}.wake_revision + 1,
        temporal_workflow_id = excluded.temporal_workflow_id,
        reason = excluded.reason,
        attempts = 0,
        next_attempt_at = now(),
        last_error = null,
        updated_at = now()
      returning session_id
    )
    select count(*)::bigint as "wakeCount" from upserted
  `);
  return Number(rows[0]?.wakeCount ?? 0);
}

/** Register one exact post-commit Temporal nudge without encoding eligibility in
 * the transport. The workflow re-reads canonical Postgres state; coalescing is
 * revisioned so a lost or stale delivery cannot hide a later mutation. */
export async function registerSessionWorkflowWakeInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    temporalWorkflowId: string;
    reason: string;
  },
): Promise<number> {
  const [row] = await db
    .insert(schema.sessionWorkflowWakeOutbox)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      temporalWorkflowId: input.temporalWorkflowId,
      reason: input.reason,
    })
    .onConflictDoUpdate({
      target: schema.sessionWorkflowWakeOutbox.sessionId,
      set: {
        temporalWorkflowId: input.temporalWorkflowId,
        wakeRevision: sql`${schema.sessionWorkflowWakeOutbox.wakeRevision} + 1`,
        reason: input.reason,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      },
    })
    .returning({ wakeRevision: schema.sessionWorkflowWakeOutbox.wakeRevision });
  if (!row) {
    throw new SessionControlInvariantError(`Failed to register wake for ${input.sessionId}`);
  }
  return Number(row.wakeRevision);
}

/**
 * Internal producers share one outstanding session-level receipt. While a wake
 * remains undelivered, another update makes that same batch richer instead of
 * manufacturing another transport revision or sequential model turn.
 */
export async function registerInternalUpdateWakeInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    temporalWorkflowId: string;
  },
): Promise<{ wakeRevision: number; shouldSignal: boolean }> {
  const [existing] = await db
    .select()
    .from(schema.sessionWorkflowWakeOutbox)
    .where(
      and(
        eq(schema.sessionWorkflowWakeOutbox.workspaceId, input.workspaceId),
        eq(schema.sessionWorkflowWakeOutbox.sessionId, input.sessionId),
      ),
    )
    .for("update")
    .limit(1);
  if (existing && existing.wakeRevision > existing.deliveredRevision) {
    await db
      .update(schema.sessionWorkflowWakeOutbox)
      .set({
        temporalWorkflowId: input.temporalWorkflowId,
        reason: "internal_update_batch",
        nextAttemptAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.sessionWorkflowWakeOutbox.sessionId, input.sessionId));
    return { wakeRevision: existing.wakeRevision, shouldSignal: false };
  }
  return {
    wakeRevision: await registerSessionWorkflowWakeInTransaction(db, {
      ...input,
      reason: "internal_update_batch",
    }),
    shouldSignal: true,
  };
}

async function interruptDescendantAttempts(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    operationId: string;
    kind: "session_pause" | "steer" | "maintenance";
    controlRevision: number;
  },
): Promise<number> {
  const rows = await db.execute<{ count: number | string }>(sql`
    with recursive live_attempts as (
      select attempt.id, attempt.account_id, attempt.workspace_id, attempt.session_id
      from ${schema.sessionTurnAttempts} attempt
      where attempt.workspace_id = ${input.workspaceId}
        and attempt.state in ('claimed', 'running')
    ), attempt_ancestry(attempt_id, account_id, workspace_id, session_id, ancestor_id, depth, path) as (
      select
        attempt.id,
        attempt.account_id,
        attempt.workspace_id,
        attempt.session_id,
        attempt.session_id,
        0::integer,
        array[attempt.session_id]::uuid[]
      from live_attempts attempt
      union all
      select
        ancestry.attempt_id,
        ancestry.account_id,
        ancestry.workspace_id,
        ancestry.session_id,
        current.parent_session_id,
        ancestry.depth + 1,
        ancestry.path || current.parent_session_id
      from attempt_ancestry ancestry
      join ${schema.sessions} current
        on current.workspace_id = ${input.workspaceId} and current.id = ancestry.ancestor_id
      where current.parent_session_id is not null
        and not current.parent_session_id = any(ancestry.path)
        and ancestry.depth < ${SESSION_ANCESTRY_LIMIT}
    ), inserted as (
      insert into ${schema.sessionAttemptInterruptions} (
        account_id, workspace_id, session_id, operation_id, attempt_id,
        kind, control_revision
      )
      select ancestry.account_id, ancestry.workspace_id, ancestry.session_id,
             ${input.operationId}::uuid, ancestry.attempt_id, ${input.kind}, ${input.controlRevision}
      from attempt_ancestry ancestry
      where ancestry.ancestor_id = ${input.sessionId}
      on conflict (operation_id, attempt_id) do nothing
      returning id
    )
    select count(*)::integer as count from inserted
  `);
  return Number(rows[0]?.count ?? 0);
}

async function interruptWorkspaceAttempts(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    controlRevision: number;
  },
): Promise<number> {
  const rows = await db.execute<{ count: number | string }>(sql`
    with inserted as (
      insert into ${schema.sessionAttemptInterruptions} (
        account_id, workspace_id, session_id, operation_id, attempt_id,
        kind, control_revision
      )
      select attempt.account_id, attempt.workspace_id, attempt.session_id,
             ${input.operationId}::uuid, attempt.id, 'workspace_pause',
             ${input.controlRevision}
      from ${schema.sessionTurnAttempts} attempt
      where attempt.workspace_id = ${input.workspaceId}
        and attempt.state in ('claimed', 'running')
      on conflict (operation_id, attempt_id) do nothing
      returning id
    )
    select count(*)::integer as count from inserted
  `);
  return Number(rows[0]?.count ?? 0);
}

export async function updateSessionCommandReceiptResult(
  db: Database,
  receiptId: string,
  input: {
    controlRevision?: number | null;
    queueVersion?: number | null;
    turnVersion?: number | null;
    draftRevision?: number | null;
    result: Record<string, unknown>;
  },
): Promise<SessionCommandReceiptRow> {
  const [receipt] = await db
    .update(schema.sessionCommandReceipts)
    .set({
      ...(input.controlRevision !== undefined
        ? { appliedControlRevision: input.controlRevision }
        : {}),
      ...(input.queueVersion !== undefined ? { appliedQueueVersion: input.queueVersion } : {}),
      ...(input.turnVersion !== undefined ? { appliedTurnVersion: input.turnVersion } : {}),
      ...(input.draftRevision !== undefined ? { appliedDraftRevision: input.draftRevision } : {}),
      result: input.result,
      updatedAt: new Date(),
    })
    .where(eq(schema.sessionCommandReceipts.id, receiptId))
    .returning();
  if (!receipt) throw new SessionControlInvariantError("Command receipt disappeared");
  return receipt;
}

export type SessionControlMutationResult = {
  receipt: SessionCommandReceiptRow;
  control: EffectiveSessionControl;
  sessionControlEventId: string;
  workspaceControlEventId: string;
  interruptionCount: number;
  wakeCount: number;
  cancelledSessionCount: number;
  cancelledTurnCount: number;
  affectedSessionEvents: Array<{ sessionId: string; eventIds: string[] }>;
  replay: boolean;
};

async function loadSessionSubtreeIds(
  db: Database,
  workspaceId: string,
  rootSessionId: string,
): Promise<{ sessionIds: string[]; rootParentSessionId: string | null }> {
  const rows: Array<{
    id: string;
    rootParentSessionId: string | null;
    depth: number | string;
    cycle: boolean;
  }> = await db.execute(sql`
    with recursive subtree(id, root_parent_session_id, depth, path, cycle) as (
      select session.id, session.parent_session_id, 0::integer, array[session.id]::uuid[], false
      from ${schema.sessions} session
      where session.workspace_id = ${workspaceId} and session.id = ${rootSessionId}
      union all
      select child.id, parent.root_parent_session_id, parent.depth + 1,
             parent.path || child.id, child.id = any(parent.path)
      from subtree parent
      join ${schema.sessions} child
        on child.workspace_id = ${workspaceId} and child.parent_session_id = parent.id
      where parent.depth < ${SESSION_ANCESTRY_LIMIT} and not parent.cycle
    )
    select id, root_parent_session_id as "rootParentSessionId", depth, cycle
    from subtree
    order by id
  `);
  if (rows.length === 0) {
    throw new SessionControlInvariantError(`Session ${rootSessionId} does not exist`);
  }
  if (rows.some((row) => row.cycle || Number(row.depth) >= SESSION_ANCESTRY_LIMIT)) {
    throw new SessionControlInvariantError(`Session ${rootSessionId} subtree is invalid`);
  }
  return {
    sessionIds: rows.map((row) => row.id),
    rootParentSessionId: rows[0]?.rootParentSessionId ?? null,
  };
}

const TERMINAL_CANCELLATION_LIVE_TURN_STATUSES = [
  "queued",
  "running",
  "requires_action",
  "recovering",
  "waiting_capacity",
];

async function loadCancellationTurnIds(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.sessionTurns.id })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        inArray(schema.sessionTurns.sessionId, sessionIds),
        inArray(schema.sessionTurns.status, TERMINAL_CANCELLATION_LIVE_TURN_STATUSES),
      ),
    )
    .orderBy(schema.sessionTurns.id);
  return rows.map((row) => row.id);
}

async function enqueueCancelledChildOutboxInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    rootSession: typeof schema.sessions.$inferSelect;
    parentSession: typeof schema.sessions.$inferSelect | null;
  },
): Promise<void> {
  const parentSessionId = input.rootSession.parentSessionId;
  if (!parentSessionId) return;
  if (!input.parentSession || input.parentSession.id !== parentSessionId) {
    throw new SessionControlInvariantError(
      `Parent session ${parentSessionId} was not locked with cancellation root ${input.rootSession.id}`,
    );
  }
  if (input.parentSession.status === "cancelled") return;
  let personalConnectionDelegations: (typeof schema.sessionTurns.$inferSelect)["personalConnectionDelegations"] =
    [];
  if (input.rootSession.parentTurnId) {
    const [parentTurn] = await db
      .select({ delegations: schema.sessionTurns.personalConnectionDelegations })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
          eq(schema.sessionTurns.sessionId, parentSessionId),
          eq(schema.sessionTurns.id, input.rootSession.parentTurnId),
        ),
      )
      .limit(1);
    if (parentTurn) {
      const parsed = McpPersonalConnectionDelegations.safeParse(parentTurn.delegations);
      if (!parsed.success) {
        throw new SessionControlInvariantError(
          `Invalid personal MCP delegation snapshot at session_turns:${input.workspaceId}:${parentSessionId}:${input.rootSession.parentTurnId}`,
        );
      }
      personalConnectionDelegations = parsed.data.map((delegation) => ({ ...delegation }));
    }
  }
  await db
    .insert(schema.sessionSystemUpdateOutbox)
    .values({
      accountId: input.rootSession.accountId,
      workspaceId: input.workspaceId,
      sourceSessionId: input.rootSession.id,
      targetSessionId: parentSessionId,
      dedupeKey: `child-completion:${input.rootSession.id}:cancelled`,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: input.rootSession.id,
      summary: "Child session was terminally cancelled.",
      payload: {
        type: "child_terminal_result",
        childSessionId: input.rootSession.id,
        status: "cancelled",
      },
      lineage: {
        childSessionId: input.rootSession.id,
        parentSessionId,
        ...(input.rootSession.parentTurnId ? { parentTurnId: input.rootSession.parentTurnId } : {}),
      },
      personalConnectionDelegations,
    })
    .onConflictDoNothing({
      target: [
        schema.sessionSystemUpdateOutbox.workspaceId,
        schema.sessionSystemUpdateOutbox.dedupeKey,
      ],
    });
}

async function assertSessionBranchIsNotCancelled(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const rows = await db.execute<{
    cancelled: boolean;
    invalid: boolean;
  }>(sql`
    with recursive ancestry(id, parent_id, status, depth, path, cycle) as (
      select session.id, session.parent_session_id, session.status, 0::integer,
             array[session.id]::uuid[], false
      from ${schema.sessions} session
      where session.workspace_id = ${workspaceId} and session.id = ${sessionId}
      union all
      select parent.id, parent.parent_session_id, parent.status, child.depth + 1,
             child.path || parent.id, parent.id = any(child.path)
      from ancestry child
      join ${schema.sessions} parent
        on parent.workspace_id = ${workspaceId} and parent.id = child.parent_id
      where child.depth < ${SESSION_ANCESTRY_LIMIT} and not child.cycle
    )
    select
      coalesce(bool_or(status = 'cancelled'), false) as cancelled,
      count(*) = 0 or coalesce(bool_or(cycle), false)
        or coalesce(max(depth), 0) >= ${SESSION_ANCESTRY_LIMIT} as invalid
    from ancestry
  `);
  if (rows[0]?.invalid) {
    throw new SessionControlInvariantError(`Session ${sessionId} ancestry is invalid`);
  }
  if (rows[0]?.cancelled) {
    throw new SessionControlConflictError("Cancelled session subtree cannot accept work");
  }
}

async function cancelSessionSubtreeInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    rootSessionId: string;
    sessionIds: string[];
    lockedSessions: Array<typeof schema.sessions.$inferSelect>;
    candidateTurnIds: string[];
    lockedTurns: Array<typeof schema.sessionTurns.$inferSelect>;
    actor: string;
    reason: string | null;
    operationId: string;
    rootControlEventId: string;
  },
): Promise<{
  cancelledSessionCount: number;
  cancelledTurnCount: number;
  affectedSessionEvents: Array<{ sessionId: string; eventIds: string[] }>;
}> {
  const candidateTurnIdSet = new Set(input.candidateTurnIds);
  const candidateTurns = input.lockedTurns.filter((turn) => candidateTurnIdSet.has(turn.id));
  if (candidateTurns.length !== candidateTurnIdSet.size) {
    throw new SessionControlInvariantError("Cancellation candidate turns changed while locking");
  }
  // The outer command acquired every session and candidate turn in one UUID-
  // sorted call before the actor attempt. Repeat only those already-held locks
  // so this event-writing suffix retains a directly auditable lock contract;
  // this call must never discover or acquire a new row.
  const suffixLocks = await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    sessionIds: input.lockedSessions.map((session) => session.id),
    turnIds: input.candidateTurnIds,
  });
  if (
    suffixLocks.sessions.length !== input.lockedSessions.length ||
    suffixLocks.turns.length !== candidateTurnIdSet.size
  ) {
    throw new SessionControlInvariantError("Cancellation rows changed under canonical locks");
  }
  const sessionIdSet = new Set(input.sessionIds);
  const rootSession = input.lockedSessions.find((session) => session.id === input.rootSessionId);
  if (!rootSession) {
    throw new SessionControlInvariantError(
      `Cancellation root ${input.rootSessionId} was not locked with its subtree`,
    );
  }
  const rootParentSession = rootSession.parentSessionId
    ? (input.lockedSessions.find((session) => session.id === rootSession.parentSessionId) ?? null)
    : null;
  const candidateTurnById = new Map(candidateTurns.map((turn) => [turn.id, turn]));
  const liveTurnIds = new Set(
    input.lockedSessions
      .filter((session) => session.activeTurnId !== null)
      .flatMap((session) => {
        const turn = session.activeTurnId ? candidateTurnById.get(session.activeTurnId) : undefined;
        if (turn?.activeAttemptId === null) return [];
        return turn ? [turn.id] : [];
      }),
  );
  const immediatelyCancelledTurns = candidateTurns.filter((turn) => !liveTurnIds.has(turn.id));
  const cancelledTurnsBySession = new Map<string, typeof immediatelyCancelledTurns>();
  for (const turn of immediatelyCancelledTurns) {
    const turns = cancelledTurnsBySession.get(turn.sessionId);
    if (turns) turns.push(turn);
    else cancelledTurnsBySession.set(turn.sessionId, [turn]);
  }
  const immediatelyCancelledTurnIds = immediatelyCancelledTurns.map((turn) => turn.id);
  const now = new Date();
  let cancelledHumanInputs: Array<{
    id: string;
    sessionId: string;
    turnId: string;
    questions: (typeof schema.sessionHumanInputRequests.$inferSelect)["questions"];
  }> = [];
  if (immediatelyCancelledTurnIds.length > 0) {
    await db
      .update(schema.sessionTurns)
      .set({
        status: "cancelled",
        activeAttemptId: null,
        cancelledBy: input.actor,
        cancelReason: input.reason ?? "session_cancelled",
        version: sql`${schema.sessionTurns.version} + 1`,
        finishedAt: now,
        updatedAt: now,
      })
      .where(inArray(schema.sessionTurns.id, immediatelyCancelledTurnIds));
    cancelledHumanInputs = await db
      .update(schema.sessionHumanInputRequests)
      .set({
        status: "cancelled",
        response: { outcome: "cancelled" },
        respondedBy: input.actor,
        respondedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sessionHumanInputRequests.workspaceId, input.workspaceId),
          inArray(schema.sessionHumanInputRequests.turnId, immediatelyCancelledTurnIds),
          eq(schema.sessionHumanInputRequests.status, "pending"),
        ),
      )
      .returning({
        id: schema.sessionHumanInputRequests.id,
        sessionId: schema.sessionHumanInputRequests.sessionId,
        turnId: schema.sessionHumanInputRequests.turnId,
        questions: schema.sessionHumanInputRequests.questions,
      });
    await db
      .update(schema.codexCapacityWaiters)
      .set({ status: "superseded", lastWakeReason: "session_cancelled", updatedAt: now })
      .where(
        and(
          eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
          inArray(schema.codexCapacityWaiters.blockedTurnId, immediatelyCancelledTurnIds),
          eq(schema.codexCapacityWaiters.status, "waiting"),
        ),
      );
  }
  const cancelledSystemUpdates = await db
    .update(schema.sessionSystemUpdates)
    .set({ state: "cancelled" })
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, input.workspaceId),
        inArray(schema.sessionSystemUpdates.sessionId, input.sessionIds),
        eq(schema.sessionSystemUpdates.state, "pending"),
      ),
    )
    .returning({
      id: schema.sessionSystemUpdates.id,
      sessionId: schema.sessionSystemUpdates.sessionId,
    });
  const humanInputsByTurn = new Map<string, typeof cancelledHumanInputs>();
  for (const humanInput of cancelledHumanInputs) {
    const inputs = humanInputsByTurn.get(humanInput.turnId);
    if (inputs) inputs.push(humanInput);
    else humanInputsByTurn.set(humanInput.turnId, [humanInput]);
  }
  const systemUpdatesBySession = new Map<string, typeof cancelledSystemUpdates>();
  for (const update of cancelledSystemUpdates) {
    const updates = systemUpdatesBySession.get(update.sessionId);
    if (updates) updates.push(update);
    else systemUpdatesBySession.set(update.sessionId, [update]);
  }

  const affectedSessionEvents: Array<{ sessionId: string; eventIds: string[] }> = [];
  for (const session of input.lockedSessions) {
    if (!sessionIdSet.has(session.id)) continue;
    let sequence = session.lastSequence + (session.id === input.rootSessionId ? 1 : 0);
    const cancelledTurns = cancelledTurnsBySession.get(session.id) ?? [];
    const preinsertedEvents: Array<{ id: string; sequence: number }> = [];
    const eventValues: Array<typeof schema.sessionEvents.$inferInsert> = [];
    for (const update of (systemUpdatesBySession.get(session.id) ?? []).sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      eventValues.push({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: session.id,
        sequence: ++sequence,
        type: "system.update.cancelled",
        payload: { updateId: update.id, reason: "session_cancelled" },
        occurredAt: now,
      });
    }
    for (const turn of cancelledTurns) {
      const closedTools = await closePendingSessionToolCallsInTransaction(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: session.id,
        turnId: turn.id,
        reason: "session_cancelled",
        sequence,
        now,
      });
      sequence = closedTools.sequence;
      preinsertedEvents.push(
        ...closedTools.events.map((event) => ({ id: event.id, sequence: event.sequence })),
      );
      for (const humanInput of (humanInputsByTurn.get(turn.id) ?? []).sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        eventValues.push({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: session.id,
          sequence: ++sequence,
          type: "user.humanInputResponse",
          turnId: turn.id,
          turnGeneration: turn.executionGeneration,
          ...(turn.id === session.activeTurnId ? { turnAssociation: "current" as const } : {}),
          payload: { requestId: humanInput.id, response: { outcome: "cancelled" } },
          occurredAt: now,
        });
      }
      eventValues.push({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: session.id,
        sequence: ++sequence,
        type: "turn.cancelled",
        turnId: turn.id,
        turnGeneration: turn.executionGeneration,
        ...(turn.id === session.activeTurnId ? { turnAssociation: "current" as const } : {}),
        payload: {
          reason: input.reason ?? "session_cancelled",
          operationId: input.operationId,
        },
        occurredAt: now,
      });
    }
    if (session.status !== "cancelled") {
      eventValues.push({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: session.id,
        sequence: ++sequence,
        type: "session.status.changed",
        payload: {
          status: "cancelled",
          reason: input.reason ?? "session_cancelled",
          operationId: input.operationId,
        },
        occurredAt: now,
      });
    }
    const inserted =
      eventValues.length > 0
        ? await db.insert(schema.sessionEvents).values(eventValues).returning({
            id: schema.sessionEvents.id,
            sequence: schema.sessionEvents.sequence,
            type: schema.sessionEvents.type,
            turnId: schema.sessionEvents.turnId,
            payload: schema.sessionEvents.payload,
          })
        : [];
    const cancelledHumanInputsById = new Map(
      cancelledHumanInputs
        .filter((request) => request.sessionId === session.id)
        .map((request) => [request.id, request]),
    );
    for (const event of inserted) {
      if (event.type !== "user.humanInputResponse") continue;
      const payload = event.payload as { requestId?: unknown };
      const request =
        typeof payload.requestId === "string"
          ? cancelledHumanInputsById.get(payload.requestId)
          : null;
      if (!request) continue;
      await mirrorSessionRealtimeContextInTransaction(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: session.id,
        sourceKind: "human_input_response",
        sourceId: event.id,
        turnId: event.turnId,
        channel: null,
        text: renderRealtimeHumanInputResponseContext({
          requestId: request.id,
          questions: request.questions,
          response: { outcome: "cancelled" },
        }),
        payload: {
          requestId: request.id,
          outcome: "cancelled",
          sourceEventId: event.id,
        },
        now,
      });
    }
    const liveTurnId =
      session.activeTurnId && liveTurnIds.has(session.activeTurnId) ? session.activeTurnId : null;
    await db
      .update(schema.sessions)
      .set({
        status: "cancelled",
        activeTurnId: liveTurnId,
        queueVersion: sql`${schema.sessions.queueVersion} + 1`,
        queueHeadPosition: 0,
        queueTailPosition: 0,
        lastSequence: sequence,
        updatedAt: now,
      })
      .where(
        and(eq(schema.sessions.workspaceId, input.workspaceId), eq(schema.sessions.id, session.id)),
      );
    const eventIds = [...preinsertedEvents, ...inserted]
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => event.id);
    if (session.id === input.rootSessionId) eventIds.unshift(input.rootControlEventId);
    if (eventIds.length > 0) affectedSessionEvents.push({ sessionId: session.id, eventIds });
  }
  await enqueueCancelledChildOutboxInTransaction(db, {
    workspaceId: input.workspaceId,
    rootSession,
    parentSession: rootParentSession,
  });
  return {
    cancelledSessionCount: input.sessionIds.length,
    cancelledTurnCount: candidateTurns.length,
    affectedSessionEvents,
  };
}

export async function mutateSessionControlInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    actor: SessionCommandActor;
    operationKey: string;
    action: "pause" | "resume" | "cancel";
    reason?: string | null;
    expectedControlEtag?: string | null;
  },
): Promise<SessionControlMutationResult> {
  const workspace = await lockWorkspaceInferenceControl(db, input.workspaceId, "update");
  const cancellationSubtree =
    input.action === "cancel"
      ? await loadSessionSubtreeIds(db, input.workspaceId, input.sessionId)
      : { sessionIds: [input.sessionId], rootParentSessionId: null };
  const cancellationSessionIds = cancellationSubtree.sessionIds;
  const cancellationTurnIds =
    input.action === "cancel"
      ? await loadCancellationTurnIds(db, input.workspaceId, cancellationSessionIds)
      : [];
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    sessionIds:
      input.actor.type === "agent_attempt"
        ? [
            input.actor.sessionId,
            ...cancellationSessionIds,
            ...(cancellationSubtree.rootParentSessionId
              ? [cancellationSubtree.rootParentSessionId]
              : []),
          ]
        : [
            ...cancellationSessionIds,
            ...(cancellationSubtree.rootParentSessionId
              ? [cancellationSubtree.rootParentSessionId]
              : []),
          ],
    turnIds:
      input.actor.type === "agent_attempt"
        ? [input.actor.turnId, ...cancellationTurnIds]
        : cancellationTurnIds,
    attemptIds: input.actor.type === "agent_attempt" ? [input.actor.attemptId] : [],
  });
  if (input.action === "cancel") {
    const rootSession = locks.sessions.find((session) => session.id === input.sessionId);
    if (!rootSession || rootSession.parentSessionId !== cancellationSubtree.rootParentSessionId) {
      throw new SessionControlInvariantError(
        `Session ${input.sessionId} parent changed while establishing cancellation locks`,
      );
    }
  }
  const hash = canonicalSessionCommandHash({
    action: input.action,
    reason: input.reason ?? null,
    expectedControlEtag: input.expectedControlEtag ?? null,
  });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: `session.${input.action}`,
    targetSessionId: input.sessionId,
    targetTurnId: null,
    operationKey: input.operationKey,
    canonicalRequestHash: hash,
  });
  if (reserved.replay && reserved.receipt.appliedControlRevision !== null) {
    const workspaceControlEventId = String(reserved.receipt.result.workspaceControlEventId ?? "");
    if (!workspaceControlEventId) {
      throw new SessionControlInvariantError("Replayed session control receipt has no event");
    }
    const sessionControlEventId = String(reserved.receipt.result.eventId ?? "");
    if (!sessionControlEventId) {
      throw new SessionControlInvariantError(
        "Replayed session control receipt has no session event",
      );
    }
    return {
      receipt: reserved.receipt,
      control: await evaluateSessionControl(db, input.workspaceId, input.sessionId, {
        workspaceControl: workspace,
      }),
      sessionControlEventId,
      workspaceControlEventId,
      interruptionCount: Number(reserved.receipt.result.interruptionCount ?? 0),
      wakeCount: Number(reserved.receipt.result.wakeCount ?? 0),
      cancelledSessionCount: Number(reserved.receipt.result.cancelledSessionCount ?? 0),
      cancelledTurnCount: Number(reserved.receipt.result.cancelledTurnCount ?? 0),
      affectedSessionEvents: Array.isArray(reserved.receipt.result.affectedSessionEvents)
        ? (reserved.receipt.result.affectedSessionEvents as Array<{
            sessionId: string;
            eventIds: string[];
          }>)
        : [{ sessionId: input.sessionId, eventIds: [sessionControlEventId] }],
      replay: true,
    };
  }
  if (input.actor.type === "agent_attempt") {
    await assertAgentCommandAuthorityInTransaction(db, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      targetSessionId: input.sessionId,
      action: input.action === "cancel" ? "pause" : input.action,
    });
  }
  if (input.action === "resume") {
    await assertSessionBranchIsNotCancelled(db, input.workspaceId, input.sessionId);
  }
  const before = await evaluateSessionControl(db, input.workspaceId, input.sessionId, {
    workspaceControl: workspace,
  });
  if (input.expectedControlEtag && input.expectedControlEtag !== before.controlEtag) {
    throw new SessionControlConflictError();
  }

  const revision = nextRevision(workspace);
  await advanceWorkspaceRevision(db, input.workspaceId, revision);
  const updatedRows = await db
    .update(schema.sessions)
    .set(
      input.action === "pause" || input.action === "cancel"
        ? {
            directControlState: "paused",
            directPauseRevision: revision,
            controlVersion: revision,
            directControlReason: input.reason ?? null,
            directControlChangedBy:
              input.actor.type === "agent_attempt"
                ? `attempt:${input.actor.attemptId}`
                : input.actor.subjectId,
            directControlChangedAt: new Date(),
            updatedAt: new Date(),
          }
        : {
            directControlState: "active",
            directPauseRevision: null,
            subtreeRunOverrideRevision: revision,
            controlVersion: revision,
            directControlReason: input.reason ?? null,
            directControlChangedBy:
              input.actor.type === "agent_attempt"
                ? `attempt:${input.actor.attemptId}`
                : input.actor.subjectId,
            directControlChangedAt: new Date(),
            updatedAt: new Date(),
          },
    )
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        input.action === "cancel"
          ? inArray(schema.sessions.id, cancellationSessionIds)
          : eq(schema.sessions.id, input.sessionId),
      ),
    )
    .returning({
      id: schema.sessions.id,
      lastSequence: schema.sessions.lastSequence,
    });
  const updated = updatedRows.find((row) => row.id === input.sessionId);
  if (!updated) throw new SessionControlInvariantError(`Session ${input.sessionId} disappeared`);

  const actor =
    input.actor.type === "agent_attempt"
      ? `attempt:${input.actor.attemptId}`
      : input.actor.subjectId;
  const workspaceControlEventId = await insertWorkspaceControlEventInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    revision,
    scope: "session",
    rootSessionId: input.sessionId,
    action: input.action === "cancel" ? "pause" : input.action,
    automatic: false,
    reason: input.reason ?? null,
    actor,
  });

  const interruptionCount =
    input.action === "pause" || input.action === "cancel"
      ? await interruptDescendantAttempts(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          operationId: reserved.receipt.id,
          kind: "session_pause",
          controlRevision: revision,
        })
      : 0;
  const wakeCount =
    input.action === "cancel"
      ? await registerCancellationWakes(db, {
          workspaceId: input.workspaceId,
          sessionIds: cancellationSessionIds,
        })
      : input.action === "pause"
        ? await registerInterruptionWakes(db, {
            operationId: reserved.receipt.id,
            reason: "session_pause_interruption",
          })
        : await registerDescendantWakes(db, {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            reason: "session_resume",
          });
  const [controlEvent] = await db
    .insert(schema.sessionEvents)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: updated.lastSequence + 1,
      type:
        input.action === "pause" || input.action === "cancel"
          ? "session.control.paused"
          : "session.control.resumed",
      payload: {
        operationId: reserved.receipt.id,
        revision,
        actor,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.action === "cancel" ? { terminal: true } : {}),
        interruptionCount,
      },
      occurredAt: new Date(),
    })
    .returning({ id: schema.sessionEvents.id });
  if (!controlEvent)
    throw new SessionControlInvariantError("Session control event was not inserted");
  await db
    .update(schema.sessions)
    .set({ lastSequence: updated.lastSequence + 1, updatedAt: new Date() })
    .where(eq(schema.sessions.id, input.sessionId));
  await db.insert(schema.auditEvents).values({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: actor,
    action: `session.control.${input.action}`,
    targetType: "session",
    targetId: input.sessionId,
    metadata: {
      operationId: reserved.receipt.id,
      revision,
      interruptionCount,
      ...(input.actor.type === "agent_attempt"
        ? {
            callerSessionId: input.actor.sessionId,
            callerTurnId: input.actor.turnId,
            callerAttemptId: input.actor.attemptId,
            callerExecutionGeneration: input.actor.executionGeneration,
          }
        : {}),
    },
  });
  const cancellation =
    input.action === "cancel"
      ? await cancelSessionSubtreeInTransaction(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          rootSessionId: input.sessionId,
          sessionIds: cancellationSessionIds,
          lockedSessions: locks.sessions,
          candidateTurnIds: cancellationTurnIds,
          lockedTurns: locks.turns,
          actor,
          reason: input.reason ?? null,
          operationId: reserved.receipt.id,
          rootControlEventId: controlEvent.id,
        })
      : {
          cancelledSessionCount: 0,
          cancelledTurnCount: 0,
          affectedSessionEvents: [{ sessionId: input.sessionId, eventIds: [controlEvent.id] }],
        };
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    controlRevision: revision,
    result: {
      interruptionCount,
      wakeCount,
      eventId: controlEvent.id,
      workspaceControlEventId,
      cancelledSessionCount: cancellation.cancelledSessionCount,
      cancelledTurnCount: cancellation.cancelledTurnCount,
      affectedSessionEvents: cancellation.affectedSessionEvents,
    },
  });
  const control = await evaluateSessionControl(db, input.workspaceId, input.sessionId, {
    lock: "share",
  });
  return {
    receipt,
    control,
    sessionControlEventId: controlEvent.id,
    workspaceControlEventId,
    interruptionCount,
    wakeCount,
    cancelledSessionCount: cancellation.cancelledSessionCount,
    cancelledTurnCount: cancellation.cancelledTurnCount,
    affectedSessionEvents: cancellation.affectedSessionEvents,
    replay: false,
  };
}

export async function autoResumeSessionBranchInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    actor: string;
    reason: "human_send" | "human_steer" | "service_send" | "service_steer" | "agent_steer";
    observedControlEtag?: string | null;
  },
): Promise<{
  revision: number;
  control: EffectiveSessionControl;
  changed: boolean;
  workspaceControlEventId: string | null;
}> {
  const workspace = await lockWorkspaceInferenceControl(db, input.workspaceId, "update");
  await assertSessionBranchIsNotCancelled(db, input.workspaceId, input.sessionId);
  const before = await evaluateSessionControl(db, input.workspaceId, input.sessionId, {
    lock: "share",
  });
  if (input.observedControlEtag && input.observedControlEtag !== before.controlEtag) {
    throw new SessionControlConflictError();
  }
  if (before.state === "active") {
    return {
      revision: asSafeRevision(workspace.revision, "workspace control revision")!,
      control: before,
      changed: false,
      workspaceControlEventId: null,
    };
  }
  const revision = nextRevision(workspace);
  await advanceWorkspaceRevision(db, input.workspaceId, revision);
  await db
    .update(schema.sessions)
    .set({
      directControlState: "active",
      directPauseRevision: null,
      subtreeRunOverrideRevision: revision,
      controlVersion: revision,
      directControlReason: input.reason,
      directControlChangedBy: input.actor,
      directControlChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    );
  const workspaceControlEventId = await insertWorkspaceControlEventInTransaction(db, {
    accountId: workspace.accountId,
    workspaceId: input.workspaceId,
    revision,
    scope: "session",
    rootSessionId: input.sessionId,
    action: "resume",
    automatic: true,
    reason: input.reason,
    actor: input.actor,
  });
  return {
    revision,
    control: await evaluateSessionControl(db, input.workspaceId, input.sessionId, {
      lock: "share",
    }),
    changed: true,
    workspaceControlEventId,
  };
}

export type WorkspaceControlMutationResult = {
  receipt: SessionCommandReceiptRow;
  revision: number;
  workspaceControlEventId: string;
  workspaceState: EffectiveControlState;
  interruptionCount: number;
  wakeCount: number;
  replay: boolean;
};

export async function mutateWorkspaceControlInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actor: SessionCommandActor;
    operationKey: string;
    action: "pause" | "resume";
    reason?: string | null;
    expectedRevision?: number | null;
  },
): Promise<WorkspaceControlMutationResult> {
  const workspace = await lockWorkspaceInferenceControl(db, input.workspaceId, "update");
  const currentRevision = asSafeRevision(workspace.revision, "workspace control revision")!;
  const hash = canonicalSessionCommandHash({
    action: input.action,
    reason: input.reason ?? null,
    expectedRevision: input.expectedRevision ?? null,
  });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: `workspace.${input.action}`,
    targetSessionId: null,
    targetTurnId: null,
    operationKey: input.operationKey,
    canonicalRequestHash: hash,
  });
  if (reserved.replay && reserved.receipt.appliedControlRevision !== null) {
    const workspaceControlEventId = String(reserved.receipt.result.workspaceControlEventId ?? "");
    if (!workspaceControlEventId) {
      throw new SessionControlInvariantError("Replayed workspace control receipt has no event");
    }
    return {
      receipt: reserved.receipt,
      revision: Number(reserved.receipt.appliedControlRevision),
      workspaceControlEventId,
      workspaceState: input.action === "pause" ? "paused" : "active",
      interruptionCount: Number(reserved.receipt.result.interruptionCount ?? 0),
      wakeCount: Number(reserved.receipt.result.wakeCount ?? 0),
      replay: true,
    };
  }
  if (input.expectedRevision !== null && input.expectedRevision !== undefined) {
    if (input.expectedRevision !== currentRevision) throw new SessionControlConflictError();
  }

  const revision = nextRevision(workspace);
  const actor =
    input.actor.type === "agent_attempt"
      ? `attempt:${input.actor.attemptId}`
      : input.actor.subjectId;
  const [updated] = await db
    .update(schema.workspaceInferenceControls)
    .set({
      revision,
      workspaceState: input.action === "pause" ? "paused" : "active",
      workspacePauseRevision: input.action === "pause" ? revision : null,
      reason: input.reason ?? null,
      changedBy: actor,
      changedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.workspaceInferenceControls.workspaceId, input.workspaceId),
        eq(schema.workspaceInferenceControls.revision, currentRevision),
      ),
    )
    .returning({ workspaceId: schema.workspaceInferenceControls.workspaceId });
  if (!updated) {
    throw new SessionControlInvariantError("Workspace control did not mutate exactly once");
  }
  const workspaceControlEventId = await insertWorkspaceControlEventInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    revision,
    scope: "workspace",
    rootSessionId: null,
    action: input.action,
    automatic: false,
    reason: input.reason ?? null,
    actor,
  });
  const interruptionCount =
    input.action === "pause"
      ? await interruptWorkspaceAttempts(db, {
          workspaceId: input.workspaceId,
          operationId: reserved.receipt.id,
          controlRevision: revision,
        })
      : 0;
  const wakeCount =
    input.action === "pause"
      ? await registerInterruptionWakes(db, {
          operationId: reserved.receipt.id,
          reason: "workspace_pause_interruption",
        })
      : await registerWorkspaceWakes(db, {
          workspaceId: input.workspaceId,
          reason: "workspace_resume",
        });
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    controlRevision: revision,
    result: { interruptionCount, wakeCount, workspaceControlEventId },
  });
  return {
    receipt,
    revision,
    workspaceControlEventId,
    workspaceState: input.action === "pause" ? "paused" : "active",
    interruptionCount,
    wakeCount,
    replay: false,
  };
}

async function insertWorkspaceControlEventInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    revision: number;
    scope: "workspace" | "session";
    rootSessionId: string | null;
    action: "pause" | "resume";
    automatic: boolean;
    reason: string | null;
    actor: string;
  },
): Promise<string> {
  const projected = boundWorkspaceControlEvent(
    {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      sequence: input.revision,
      revision: input.revision,
      type: "workspace.control.changed",
      scope: input.scope,
      rootSessionId: input.rootSessionId,
      action: input.action,
      automatic: input.automatic,
      reason: input.reason,
      actor: input.actor,
      occurredAt: new Date(0).toISOString(),
    },
    { surface: "durable_control" },
  );
  const field = (name: "reason" | "actor") =>
    projected.truncation?.fields.find((candidate) => candidate.field === name);
  const [event] = await db
    .insert(schema.workspaceControlEvents)
    .values({
      ...input,
      reason: projected.reason,
      reasonOriginalBytes:
        input.reason === null
          ? null
          : (field("reason")?.originalBytes ?? workspaceControlUtf8Bytes(projected.reason!)),
      actor: projected.actor,
      actorOriginalBytes:
        field("actor")?.originalBytes ?? workspaceControlUtf8Bytes(projected.actor),
    })
    .returning({ id: schema.workspaceControlEvents.id });
  if (!event) {
    throw new SessionControlInvariantError("Workspace control event was not inserted");
  }
  return event.id;
}
