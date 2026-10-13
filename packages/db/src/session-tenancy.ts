import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  SessionTenancyBlocker as SessionTenancyBlockerSchema,
  type SessionTenancyBlocker,
} from "@opengeni/contracts";
import {
  rawRows,
  type Database,
  type SessionActivityDatabase,
  rlsContextForWorkspace,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
} from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import { registerSessionWorkflowWakeInTransaction } from "./session-control";
import { endSessionRealtimeForPrivateTransitionInTransaction } from "./session-realtime";
import {
  interruptSessionAttemptsForVisibilityChangeInTransaction,
  lockSessionForVisibilityWork,
  readSessionVisibilityWork,
  sessionVisibilityWorkIsEmpty,
  settleSessionVisibilityWorkInTransaction,
  type SessionVisibilityWork,
  type SessionVisibilityWorkSettlement,
} from "./session-visibility-work";

export type { SessionVisibilityWork } from "./session-visibility-work";
export { EMPTY_SESSION_VISIBILITY_WORK } from "./session-visibility-work";

// Frozen SQL protocol argument: every organization is activated at version 1
// since migration 0611, but the lifecycle routines still require it explicitly.
const SESSION_TENANCY_ACTIVATION_VERSION = 1;

export class SessionTenancyConflictError extends Error {
  readonly name = "SessionTenancyConflictError";
  constructor(
    readonly reason: "not_quiescent" | "authority_epoch" | "operation_reuse",
    readonly blocker: SessionTenancyBlocker | null = null,
    options?: ErrorOptions,
  ) {
    super(
      reason === "not_quiescent"
        ? "Session must be fully quiescent before its tenancy can change"
        : reason === "authority_epoch"
          ? "Session authority changed before the operation committed"
          : "Session tenancy operation key was reused with different input",
      options,
    );
  }
}

/**
 * The organization's owner/admin Only-me setting does not permit a new private
 * session (or private transition) in this shared workspace. Activation itself is
 * universal since migration 0611; the name and the SESSION_TENANCY_NOT_ACTIVATED
 * wire code are kept for client compatibility.
 */
export class SessionTenancyNotActivatedError extends Error {
  readonly name = "SessionTenancyNotActivatedError";
  constructor(options?: ErrorOptions) {
    super("Only-me chats are not enabled for this organization", options);
  }
}

export class SessionTenancyAccessError extends Error {
  readonly name = "SessionTenancyAccessError";
  constructor(options?: ErrorOptions) {
    super("Session tenancy target is unavailable", options);
  }
}

/**
 * The chat has work the person can see (a running or parked response, queued
 * messages, an active goal). `active_work` asks for "make private anyway"
 * consent; `stopping_active_work` means the consented stop is still settling
 * and the same request can be retried.
 */
export class SessionVisibilityWorkConflictError extends Error {
  readonly name = "SessionVisibilityWorkConflictError";
  constructor(
    readonly reason: "active_work" | "stopping_active_work",
    readonly work: SessionVisibilityWork,
    /** Attempts a worker is executing right now; stopping them is asynchronous. */
    readonly liveAttemptCount: number,
    options?: ErrorOptions,
  ) {
    super(
      reason === "active_work"
        ? "Session has active work; stop it to change visibility"
        : "Session work is still stopping",
      options,
    );
  }
}

export class SessionTenancyInvalidRequestError extends Error {
  readonly name = "SessionTenancyInvalidRequestError";
  constructor(options?: ErrorOptions) {
    super("Session tenancy request is invalid", options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

/** Extract only the fixed quiescence DETAIL vocabulary, never arbitrary driver detail. */
export function nestedSessionTenancyBlocker(error: unknown): SessionTenancyBlocker | null {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    for (const key of ["detail", "detailMessage"] as const) {
      const parsed = SessionTenancyBlockerSchema.safeParse(current[key]);
      if (parsed.success) return parsed.data;
    }
    for (const key of ["cause", "original", "driverError", "error", "errors"] as const) {
      const nested = current[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return null;
}

export type SessionTenancyVisibility = "user_private" | "workspace_shared";

export type PrivateSessionCreatePolicy = {
  personalWorkspace: boolean;
  platformAvailable: boolean;
  organizationEnabled: boolean;
};

export type TransitionSessionVisibilityInput = {
  workspaceId: string;
  sessionId: string;
  actorSubjectId: string;
  targetVisibility: SessionTenancyVisibility;
  expectedAuthorityEpoch: number;
  operationKey: string;
  /**
   * The owner consented to stop visible work (cancel parked and queued turns,
   * pause the active goal). Leftovers are always settled. Excluded from the
   * idempotency hash: it is consent, not a different requested outcome.
   */
  stopActiveWork?: boolean;
  beforeCommit?: (tx: Database) => Promise<void>;
};

export type TransitionSessionVisibilityResult = {
  operationId: string;
  eventId: string | null;
  eventSequence: number | null;
  visibility: SessionTenancyVisibility;
  authorityEpoch: number;
  ownerOrganizationMembershipId: string | null;
  changed: boolean;
  replay: boolean;
  interruptedAttemptCount: number;
  cancelledTurnCount: number;
  cancelledUpdateCount: number;
  pausedGoalCount: number;
  revokedGrantCount: number;
  /** Events written while settling leftovers and consented work, in order. */
  settledEventIds: string[];
  workflowWake: SessionVisibilityWorkSettlement["workflowWake"];
};

export type ForkSessionContentInput = {
  sourceEventId?: string;
  sourceWorkspaceId: string;
  sourceSessionId: string;
  actorSubjectId: string;
  destinationWorkspaceId: string;
  destinationVisibility: SessionTenancyVisibility;
  workspaceSharedAcknowledged: boolean;
  operationKey: string;
  runtimeRequest?: ForkSessionRuntimeRequest;
  runtimeConfiguration?: ForkSessionRuntimeConfiguration;
  beforeCommit?: (tx: Database) => Promise<void>;
};

export type ForkSessionRuntimeRequest = {
  variableSetIds: string[];
  rigId: string | null;
};

export type ForkSessionRuntimeConfiguration = ForkSessionRuntimeRequest & {
  rigVersionId: string | null;
};

export type ForkSessionContentResult = {
  operationId: string;
  eventId: string;
  eventSequence: number;
  sessionId: string;
  workspaceId: string;
  visibility: SessionTenancyVisibility;
  authorityEpoch: number;
  copiedHistoryItemCount: number;
  replay: boolean;
  runtimeEventId: string | null;
  runtimeEventSequence: number | null;
};

export async function getPrivateSessionCreatePolicy(
  db: Database,
  input: { workspaceId: string; actorSubjectId: string },
): Promise<PrivateSessionCreatePolicy> {
  const { accountId } = await rlsContextForWorkspace(db, input.workspaceId);
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const rows = await rawRows<{
        personalWorkspace: boolean;
        platformAvailable: boolean;
        organizationEnabled: boolean;
      }>(
        scopedDb,
        sql`select
          personal_workspace as "personalWorkspace",
          platform_available as "platformAvailable",
          organization_enabled as "organizationEnabled"
        from get_private_session_create_policy(
          ${accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.actorSubjectId}
        )`,
      );
      const policy = rows[0];
      if (!policy) throw new SessionTenancyAccessError();
      return policy;
    },
  );
}

/** Open the exact transaction-local trigger capability used by atomic private create. */
export async function openPrivateSessionCreateCapability(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; actorSubjectId: string },
): Promise<{ capabilityId: string; ownerMembershipId: string }> {
  let rows: Array<{ capabilityId: string; ownerMembershipId: string }>;
  try {
    rows = await rawRows<{ capabilityId: string; ownerMembershipId: string }>(
      db,
      sql`select
        capability_id as "capabilityId",
        owner_membership_id as "ownerMembershipId"
      from open_private_session_create_capability(
        ${input.accountId}::uuid,
        ${input.workspaceId}::uuid,
        ${input.sessionId}::uuid,
        ${input.actorSubjectId}
      )`,
    );
  } catch (error) {
    // The definer raises 55000 only when the organization owner/admin setting
    // does not permit a new private session in this shared workspace; every
    // authority failure remains 42501 and propagates unchanged.
    if (nestedPostgresSqlState(error) === "55000") {
      throw new SessionTenancyNotActivatedError({ cause: error });
    }
    throw error;
  }
  const capabilityId = rows[0]?.capabilityId;
  const ownerMembershipId = rows[0]?.ownerMembershipId;
  if (!capabilityId || !ownerMembershipId) {
    throw new Error("Private session create capability was not returned");
  }
  return { capabilityId, ownerMembershipId };
}

/** Open the exact transaction-local capability for one private child insert. */
export async function openPrivateChildSessionCreateCapability(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    parentSessionId: string;
    actorTurnId: string;
    actorAttemptId: string;
    actorExecutionGeneration: number;
  },
): Promise<{ capabilityId: string; ownerMembershipId: string; ownerSubjectId: string }> {
  const rows = await rawRows<{
    capabilityId: string;
    ownerMembershipId: string;
    ownerSubjectId: string;
  }>(
    db,
    sql`select
      capability_id as "capabilityId",
      owner_membership_id as "ownerMembershipId",
      owner_subject_id as "ownerSubjectId"
    from open_private_child_session_create_capability(
      ${input.accountId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.sessionId}::uuid,
      ${input.parentSessionId}::uuid,
      ${input.actorTurnId}::uuid,
      ${input.actorAttemptId}::uuid,
      ${input.actorExecutionGeneration}::integer
    )`,
  );
  const capabilityId = rows[0]?.capabilityId;
  const ownerMembershipId = rows[0]?.ownerMembershipId;
  const ownerSubjectId = rows[0]?.ownerSubjectId;
  if (!capabilityId || !ownerMembershipId || !ownerSubjectId) {
    throw new Error("Private child session create capability was not returned");
  }
  return { capabilityId, ownerMembershipId, ownerSubjectId };
}

export async function closePrivateSessionCreateCapability(
  db: Database,
  capabilityId: string,
): Promise<void> {
  await db.execute(sql`select close_private_session_create_capability(${capabilityId}::uuid)`);
}

function mapSessionTenancyPersistenceError(
  error: unknown,
  options: { authorityEpochConflict: boolean },
): never {
  const state = nestedPostgresSqlState(error);
  if (state === "55P03") {
    throw new SessionTenancyConflictError("not_quiescent", nestedSessionTenancyBlocker(error), {
      cause: error,
    });
  }
  if (state === "40001" && options.authorityEpochConflict) {
    throw new SessionTenancyConflictError("authority_epoch", null, { cause: error });
  }
  if (state === "23505") {
    throw new SessionTenancyConflictError("operation_reuse", null, { cause: error });
  }
  if (state === "55000") {
    throw new SessionTenancyNotActivatedError({ cause: error });
  }
  if (state === "42501" || state === "P0002") {
    throw new SessionTenancyAccessError({ cause: error });
  }
  if (state === "22023") {
    throw new SessionTenancyInvalidRequestError({ cause: error });
  }
  throw error;
}

export function canonicalSessionVisibilityTransitionHash(
  input: Pick<
    TransitionSessionVisibilityInput,
    "sessionId" | "targetVisibility" | "expectedAuthorityEpoch"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        sessionId: input.sessionId,
        targetVisibility: input.targetVisibility,
        expectedAuthorityEpoch: input.expectedAuthorityEpoch,
      }),
    )
    .digest("hex");
}

export function canonicalSessionForkHash(
  input: Pick<
    ForkSessionContentInput,
    | "sourceSessionId"
    | "destinationWorkspaceId"
    | "destinationVisibility"
    | "workspaceSharedAcknowledged"
    | "runtimeRequest"
    | "sourceEventId"
  >,
): string {
  if (input.sourceEventId) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: 4,
          sourceSessionId: input.sourceSessionId,
          destinationWorkspaceId: input.destinationWorkspaceId,
          destinationVisibility: input.destinationVisibility,
          workspaceSharedAcknowledged: input.workspaceSharedAcknowledged,
          sourceEventId: input.sourceEventId,
        }),
      )
      .digest("hex");
  }
  if (input.runtimeRequest) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: 3,
          sourceSessionId: input.sourceSessionId,
          destinationWorkspaceId: input.destinationWorkspaceId,
          destinationVisibility: input.destinationVisibility,
          workspaceSharedAcknowledged: input.workspaceSharedAcknowledged,
          runtime: input.runtimeRequest,
        }),
      )
      .digest("hex");
  }
  const legacyCompatiblePrivateRequest =
    input.destinationVisibility === "user_private" && !input.workspaceSharedAcknowledged;
  return createHash("sha256")
    .update(
      JSON.stringify(
        legacyCompatiblePrivateRequest
          ? {
              version: 1,
              sourceSessionId: input.sourceSessionId,
              destinationWorkspaceId: input.destinationWorkspaceId,
              destinationVisibility: input.destinationVisibility,
            }
          : {
              version: 2,
              sourceSessionId: input.sourceSessionId,
              destinationWorkspaceId: input.destinationWorkspaceId,
              destinationVisibility: input.destinationVisibility,
              workspaceSharedAcknowledged: input.workspaceSharedAcknowledged,
            },
      ),
    )
    .digest("hex");
}

function canonicalForkRuntimeConfigurationDigest(input: ForkSessionRuntimeRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...input }))
    .digest("hex");
}

export async function transitionSessionVisibility(
  db: Database,
  input: TransitionSessionVisibilityInput,
): Promise<TransitionSessionVisibilityResult> {
  if (!Number.isSafeInteger(input.expectedAuthorityEpoch) || input.expectedAuthorityEpoch < 1) {
    throw new Error("expectedAuthorityEpoch must be a positive safe integer");
  }
  if (!input.operationKey.trim()) throw new Error("operationKey must not be empty");
  const requestHash = canonicalSessionVisibilityTransitionHash(input);
  const { accountId } = await rlsContextForWorkspace(db, input.workspaceId);
  try {
    return await withWorkspaceSubjectSessionActivityRls(
      db,
      input.workspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
        const settlement =
          input.targetVisibility === "user_private"
            ? await settleWorkBeforePrivateTransition(scopedDb, {
                accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                actorSubjectId: input.actorSubjectId,
                expectedAuthorityEpoch: input.expectedAuthorityEpoch,
                operationKey: input.operationKey,
                stopActiveWork: input.stopActiveWork === true,
              })
            : null;
        const rows = await rawRows<{
          operationId: string;
          eventId: string | null;
          eventSequence: number | null;
          visibility: SessionTenancyVisibility;
          authorityEpoch: number;
          ownerOrganizationMembershipId: string | null;
          changed: boolean;
          replay: boolean;
          interruptedAttemptCount: number;
          cancelledTurnCount: number;
          cancelledUpdateCount: number;
          pausedGoalCount: number;
          revokedGrantCount: number;
        }>(
          scopedDb,
          sql`select
          operation_id as "operationId",
          event_id as "eventId",
          event_sequence as "eventSequence",
          visibility,
          authority_epoch as "authorityEpoch",
          owner_organization_membership_id as "ownerOrganizationMembershipId",
          changed,
          replay,
          interrupted_attempt_count as "interruptedAttemptCount",
          cancelled_turn_count as "cancelledTurnCount",
          cancelled_update_count as "cancelledUpdateCount",
          paused_goal_count as "pausedGoalCount",
          revoked_grant_count as "revokedGrantCount"
        from transition_session_visibility(
          ${accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid,
          ${input.actorSubjectId},
          ${input.targetVisibility},
          ${input.expectedAuthorityEpoch},
          ${input.operationKey},
          ${requestHash},
          ${SESSION_TENANCY_ACTIVATION_VERSION}
        )`,
        );
        const result = rows[0];
        if (!result) throw new Error("Session visibility transition returned no result");
        await input.beforeCommit?.(scopedDb);
        return {
          ...result,
          cancelledTurnCount: settlement?.cancelledTurnCount ?? result.cancelledTurnCount,
          pausedGoalCount: settlement?.pausedGoal ? 1 : result.pausedGoalCount,
          settledEventIds: settlement?.eventIds ?? [],
          workflowWake: settlement?.workflowWake ?? null,
        };
      },
      undefined,
      "none",
      // Organization membership, then the exclusive tenancy fence, before any
      // row lock: the same prefix transition_session_visibility takes itself.
      true,
    );
  } catch (error) {
    mapSessionTenancyPersistenceError(error, { authorityEpochConflict: true });
  }
}

async function lockSessionTenancyExclusively(db: Database, workspaceId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`,
  );
}

/**
 * Settle what would otherwise refuse a private transition, inside its own
 * transaction: leftover turns always, visible work only with consent. Live
 * attempts cannot be settled synchronously; they surface as `active_work` with
 * a live attempt count so the caller can stop them first.
 */
async function settleWorkBeforePrivateTransition(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    actorSubjectId: string;
    expectedAuthorityEpoch: number;
    operationKey: string;
    stopActiveWork: boolean;
  },
): Promise<SessionVisibilityWorkSettlement | null> {
  await lockSessionTenancyExclusively(db, input.workspaceId);
  const lock = await lockSessionForVisibilityWork(db, input);
  // Anything the definer refuses or replays is left to it, unchanged.
  if (
    !lock ||
    lock.session.visibility === "user_private" ||
    lock.session.ownerSubjectId !== input.actorSubjectId ||
    lock.session.authorityEpoch !== input.expectedAuthorityEpoch ||
    (await visibilityReceiptExists(db, input))
  ) {
    return null;
  }
  const inventory = await readSessionVisibilityWork(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sessionStatus: lock.session.status,
  });
  const hasWork = !sessionVisibilityWorkIsEmpty(inventory.work);
  if ((hasWork && !input.stopActiveWork) || inventory.liveAttempts.length > 0) {
    throw new SessionVisibilityWorkConflictError(
      "active_work",
      inventory.work,
      inventory.liveAttempts.length,
    );
  }
  // A live voice session ends with consent; an expired lease ends silently.
  const voice = await endSessionRealtimeForPrivateTransitionInTransaction(db, lock.session);
  const settlement = await settleSessionVisibilityWorkInTransaction(db, {
    session: lock.session,
    actorSubjectId: input.actorSubjectId,
    cancelTurnIds: inventory.pendingTurnIds,
    pauseGoal: input.stopActiveWork && inventory.work.activeGoal,
    liveTurnId: null,
  });
  if (!voice) return settlement;
  const wakeRevision = Math.max(
    voice.workflowWakeRevision,
    settlement.workflowWake?.wakeRevision ?? 0,
  );
  return {
    ...settlement,
    eventIds: [voice.eventId, ...settlement.eventIds],
    workflowWake: {
      accountId: lock.session.accountId,
      workspaceId: lock.session.workspaceId,
      sessionId: lock.session.id,
      temporalWorkflowId: lock.session.temporalWorkflowId ?? `session-${lock.session.id}`,
      wakeRevision,
    },
  };
}

async function visibilityReceiptExists(
  db: Database,
  input: { workspaceId: string; sessionId: string; actorSubjectId: string; operationKey: string },
): Promise<boolean> {
  const rows = await rawRows<{ exists: boolean }>(
    db,
    sql`select exists (
      select 1 from session_command_receipts receipt
      where receipt.workspace_id = ${input.workspaceId}::uuid
        and receipt.actor_type = 'human'
        and receipt.actor_subject_id = ${input.actorSubjectId}
        and receipt.actor_attempt_id is null
        and receipt.action = 'session.visibility.change'
        and receipt.target_session_id = ${input.sessionId}::uuid
        and receipt.target_turn_id is null
        and receipt.operation_key = ${input.operationKey}
    ) as "exists"`,
  );
  return rows[0]?.exists === true;
}

export type SessionVisibilityChangePreview = {
  visibility: SessionTenancyVisibility;
  authorityEpoch: number;
  /** What a confirmed change to Only me stops or removes; nothing else refuses it. */
  work: SessionVisibilityWork;
};

/** Owner-only, read-only answer to "what happens if I make this chat Only me?". */
export async function inspectSessionVisibilityChange(
  db: Database,
  input: { workspaceId: string; sessionId: string; actorSubjectId: string },
): Promise<SessionVisibilityChangePreview> {
  const { accountId } = await rlsContextForWorkspace(db, input.workspaceId);
  try {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
        const [session] = await rawRows<{
          visibility: SessionTenancyVisibility;
          authorityEpoch: number;
          status: string;
        }>(
          scopedDb,
          sql`select visibility, authority_epoch as "authorityEpoch", status
          from sessions
          where workspace_id = ${input.workspaceId}::uuid and id = ${input.sessionId}::uuid`,
        );
        if (!session) throw new SessionTenancyAccessError();
        // Owner-only: the routine behind the other-people counts refuses
        // anyone else before anything is returned.
        const inventory = await readSessionVisibilityWork(scopedDb, {
          accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sessionStatus: session.status,
        });
        return {
          visibility: session.visibility,
          authorityEpoch: Number(session.authorityEpoch),
          work: inventory.work,
        };
      },
    );
  } catch (error) {
    mapSessionTenancyPersistenceError(error, { authorityEpochConflict: false });
  }
}

export type StopSessionWorkForVisibilityChangeResult = {
  interruptedAttemptCount: number;
  liveAttemptCount: number;
  eventIds: string[];
  workflowWake: SessionVisibilityWorkSettlement["workflowWake"];
};

/**
 * First half of a consented "make private anyway" when a worker is executing
 * the chat: durably interrupt each live attempt (the worker cancels the turn
 * when it settles), cancel everything queued or parked, and pause the goal.
 * It commits on its own; the transition that follows drops everything else.
 */
export async function stopSessionWorkForVisibilityChange(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    actorSubjectId: string;
    expectedAuthorityEpoch: number;
    operationKey: string;
  },
): Promise<StopSessionWorkForVisibilityChangeResult> {
  if (!input.operationKey.trim()) throw new Error("operationKey must not be empty");
  const { accountId } = await rlsContextForWorkspace(db, input.workspaceId);
  try {
    return await withWorkspaceSubjectSessionActivityRls(
      db,
      input.workspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
        await lockSessionTenancyExclusively(scopedDb, input.workspaceId);
        const lock = await lockSessionForVisibilityWork(scopedDb, input);
        if (!lock || lock.session.ownerSubjectId !== input.actorSubjectId) {
          throw new SessionTenancyAccessError();
        }
        const empty = {
          interruptedAttemptCount: 0,
          liveAttemptCount: 0,
          eventIds: [],
          workflowWake: null,
        };
        if (lock.session.visibility === "user_private") return empty;
        if (lock.session.authorityEpoch !== input.expectedAuthorityEpoch) {
          throw new SessionTenancyConflictError("authority_epoch");
        }
        const inventory = await readSessionVisibilityWork(scopedDb, {
          accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sessionStatus: lock.session.status,
        });
        const interruptedAttemptCount =
          await interruptSessionAttemptsForVisibilityChangeInTransaction(scopedDb, {
            session: lock.session,
            actorSubjectId: input.actorSubjectId,
            operationKey: input.operationKey,
            attemptIds: inventory.liveAttempts.map((attempt) => attempt.id),
          });
        const liveTurnIds = new Set(inventory.liveAttempts.map((attempt) => attempt.turnId));
        const liveTurnId =
          lock.session.activeTurnId && liveTurnIds.has(lock.session.activeTurnId)
            ? lock.session.activeTurnId
            : (inventory.liveAttempts[0]?.turnId ?? null);
        const settlement = await settleSessionVisibilityWorkInTransaction(scopedDb, {
          session: lock.session,
          actorSubjectId: input.actorSubjectId,
          cancelTurnIds: inventory.pendingTurnIds,
          pauseGoal: inventory.work.activeGoal,
          liveTurnId,
        });
        let workflowWake = settlement.workflowWake;
        if (!workflowWake && interruptedAttemptCount > 0) {
          const temporalWorkflowId =
            lock.session.temporalWorkflowId ?? `session-${lock.session.id}`;
          workflowWake = {
            accountId: lock.session.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            temporalWorkflowId,
            wakeRevision: await registerVisibilityStopWake(scopedDb, lock.session),
          };
        }
        return {
          interruptedAttemptCount,
          liveAttemptCount: inventory.liveAttempts.length,
          eventIds: settlement.eventIds,
          workflowWake,
        };
      },
      undefined,
      "none",
      true,
    );
  } catch (error) {
    mapSessionTenancyPersistenceError(error, { authorityEpochConflict: false });
  }
}

async function registerVisibilityStopWake(
  db: Database,
  session: {
    accountId: string;
    workspaceId: string;
    id: string;
    temporalWorkflowId: string | null;
  },
): Promise<number> {
  return await registerSessionWorkflowWakeInTransaction(db, {
    accountId: session.accountId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    temporalWorkflowId: session.temporalWorkflowId ?? `session-${session.id}`,
    reason: "session_visibility_stop_work",
    controlRequested: true,
  });
}

/** Whether a worker is still executing an attempt of this session (read-only). */
export async function sessionHasLiveAttempts(
  db: Database,
  input: { workspaceId: string; sessionId: string; actorSubjectId: string },
): Promise<boolean> {
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const [row] = await rawRows<{ live: boolean }>(
        scopedDb,
        sql`select exists (
          select 1 from session_turn_attempts attempt
          where attempt.workspace_id = ${input.workspaceId}::uuid
            and attempt.session_id = ${input.sessionId}::uuid
            and attempt.state in ('claimed', 'running')
        ) as live`,
      );
      return row?.live === true;
    },
  );
}

export async function forkSessionContent(
  db: Database,
  input: ForkSessionContentInput,
): Promise<ForkSessionContentResult> {
  if (!input.operationKey.trim()) throw new Error("operationKey must not be empty");
  if (input.destinationWorkspaceId !== input.sourceWorkspaceId) {
    throw new Error("The first session fork contract is same-workspace only");
  }
  if (input.sourceEventId && input.runtimeRequest) {
    throw new Error("Message forks cannot replace runtime setup");
  }
  if (Boolean(input.runtimeRequest) !== Boolean(input.runtimeConfiguration)) {
    throw new Error("A fresh session fork runtime request requires its resolved configuration");
  }
  if (
    input.runtimeRequest &&
    (input.runtimeRequest.rigId !== input.runtimeConfiguration?.rigId ||
      JSON.stringify(input.runtimeRequest.variableSetIds) !==
        JSON.stringify(input.runtimeConfiguration?.variableSetIds))
  ) {
    throw new Error("Resolved session fork runtime configuration does not match its request");
  }
  const { accountId } = await rlsContextForWorkspace(db, input.sourceWorkspaceId);
  const requestHash = canonicalSessionForkHash(input);
  try {
    return await withWorkspaceSubjectRls(
      db,
      input.sourceWorkspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
        if (input.runtimeRequest && input.runtimeConfiguration) {
          const runtimeDigest = canonicalForkRuntimeConfigurationDigest(input.runtimeRequest);
          const rows = await rawRows<ForkSessionContentResult>(
            scopedDb,
            sql`select
            operation_id as "operationId",
            event_id as "eventId",
            event_sequence as "eventSequence",
            session_id as "sessionId",
            workspace_id as "workspaceId",
            visibility,
            authority_epoch as "authorityEpoch",
            copied_history_item_count as "copiedHistoryItemCount",
            replay,
            runtime_event_id as "runtimeEventId",
            runtime_event_sequence as "runtimeEventSequence"
          from fork_session_content_with_runtime(
            ${accountId}::uuid,
            ${input.sourceWorkspaceId}::uuid,
            ${input.sourceSessionId}::uuid,
            ${input.actorSubjectId},
            ${input.destinationWorkspaceId}::uuid,
            ${input.destinationVisibility},
            ${input.workspaceSharedAcknowledged},
            ${input.operationKey},
            ${requestHash},
            ${SESSION_TENANCY_ACTIVATION_VERSION},
            ${JSON.stringify(input.runtimeConfiguration.variableSetIds)}::jsonb,
            ${input.runtimeConfiguration.rigId}::uuid,
            ${input.runtimeConfiguration.rigVersionId}::uuid,
            ${runtimeDigest}
          )`,
          );
          const result = rows[0];
          if (!result) throw new Error("Session fork returned no result");
          await input.beforeCommit?.(scopedDb);
          return result;
        }
        const rows = await rawRows<ForkSessionContentResult>(
          scopedDb,
          sql`select
          operation_id as "operationId",
          event_id as "eventId",
          event_sequence as "eventSequence",
          session_id as "sessionId",
          workspace_id as "workspaceId",
          visibility,
          authority_epoch as "authorityEpoch",
          copied_history_item_count as "copiedHistoryItemCount",
          replay,
          null::uuid as "runtimeEventId",
          null::integer as "runtimeEventSequence"
        from fork_session_content(
          ${accountId}::uuid,
          ${input.sourceWorkspaceId}::uuid,
          ${input.sourceSessionId}::uuid,
          ${input.actorSubjectId},
          ${input.destinationWorkspaceId}::uuid,
          ${input.destinationVisibility},
          ${input.workspaceSharedAcknowledged},
          ${input.operationKey},
          ${requestHash},
          ${SESSION_TENANCY_ACTIVATION_VERSION}
          ${input.sourceEventId ? sql`, ${input.sourceEventId}::uuid` : sql``}
        )`,
        );
        const result = rows[0];
        if (!result) throw new Error("Session fork returned no result");
        await input.beforeCommit?.(scopedDb);
        return result;
      },
      undefined,
      "none",
    );
  } catch (error) {
    // A private destination inside a shared workspace carries the same
    // organization owner/admin product decision the create path enforces
    // (migration 0323), and the fork routine raises the same 55000. Surface it
    // as the not-activated product state rather than an opaque database error.
    if (nestedPostgresSqlState(error) === "55000") {
      throw new SessionTenancyNotActivatedError({ cause: error });
    }
    mapSessionTenancyPersistenceError(error, { authorityEpochConflict: false });
  }
}

/**
 * Recover one exact committed fork before mutable source-session authorization.
 *
 * The database capability requires the authenticated actor's active workspace
 * authority and matches the complete actor/workspace/source/key/request-hash
 * tuple. A fresh key returns null; changed intent raises the ordinary tenancy
 * idempotency conflict. This is receipt recovery, not session discovery.
 */
export async function replayAppliedSessionFork(
  db: Database,
  input: ForkSessionContentInput,
): Promise<ForkSessionContentResult | null> {
  if (!input.operationKey.trim()) throw new Error("operationKey must not be empty");
  if (input.destinationWorkspaceId !== input.sourceWorkspaceId) {
    throw new Error("The first session fork contract is same-workspace only");
  }
  const { accountId } = await rlsContextForWorkspace(db, input.sourceWorkspaceId);
  const requestHash = canonicalSessionForkHash(input);
  try {
    return await withWorkspaceSubjectRls(
      db,
      input.sourceWorkspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
        if (input.runtimeRequest) {
          const runtimeDigest = canonicalForkRuntimeConfigurationDigest(input.runtimeRequest);
          const rows = await rawRows<ForkSessionContentResult>(
            scopedDb,
            sql`select
            operation_id as "operationId",
            event_id as "eventId",
            event_sequence as "eventSequence",
            session_id as "sessionId",
            workspace_id as "workspaceId",
            visibility,
            authority_epoch as "authorityEpoch",
            copied_history_item_count as "copiedHistoryItemCount",
            replay,
            runtime_event_id as "runtimeEventId",
            runtime_event_sequence as "runtimeEventSequence"
          from replay_applied_session_fork_with_runtime(
            ${accountId}::uuid,
            ${input.sourceWorkspaceId}::uuid,
            ${input.sourceSessionId}::uuid,
            ${input.actorSubjectId},
            ${input.destinationWorkspaceId}::uuid,
            ${input.destinationVisibility},
            ${input.workspaceSharedAcknowledged},
            ${input.operationKey},
            ${requestHash},
            ${SESSION_TENANCY_ACTIVATION_VERSION},
            ${runtimeDigest}
          )`,
          );
          await input.beforeCommit?.(scopedDb);
          return rows[0] ?? null;
        }
        const rows = await rawRows<ForkSessionContentResult>(
          scopedDb,
          sql`select
          operation_id as "operationId",
          event_id as "eventId",
          event_sequence as "eventSequence",
          session_id as "sessionId",
          workspace_id as "workspaceId",
          visibility,
          authority_epoch as "authorityEpoch",
          copied_history_item_count as "copiedHistoryItemCount",
          replay,
          null::uuid as "runtimeEventId",
          null::integer as "runtimeEventSequence"
        from replay_applied_session_fork(
          ${accountId}::uuid,
          ${input.sourceWorkspaceId}::uuid,
          ${input.sourceSessionId}::uuid,
          ${input.actorSubjectId},
          ${input.destinationWorkspaceId}::uuid,
          ${input.destinationVisibility},
          ${input.workspaceSharedAcknowledged},
          ${input.operationKey},
          ${requestHash},
          ${SESSION_TENANCY_ACTIVATION_VERSION}
        )`,
        );
        await input.beforeCommit?.(scopedDb);
        return rows[0] ?? null;
      },
    );
  } catch (error) {
    mapSessionTenancyPersistenceError(error, { authorityEpochConflict: false });
  }
}
