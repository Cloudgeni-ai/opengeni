import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  SessionTenancyBlocker as SessionTenancyBlockerSchema,
  type SessionTenancyBlocker,
} from "@opengeni/contracts";
import {
  rawRows,
  type Database,
  rlsContextForWorkspace,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
} from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

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

export class SessionTenancyNotActivatedError extends Error {
  readonly name = "SessionTenancyNotActivatedError";
  constructor(options?: ErrorOptions) {
    super("Session tenancy product surface is not activated for this organization", options);
  }
}

export class SessionTenancyAccessError extends Error {
  readonly name = "SessionTenancyAccessError";
  constructor(options?: ErrorOptions) {
    super("Session tenancy target is unavailable", options);
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

export type TransitionSessionVisibilityInput = {
  workspaceId: string;
  sessionId: string;
  actorSubjectId: string;
  targetVisibility: SessionTenancyVisibility;
  expectedAuthorityEpoch: number;
  operationKey: string;
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
};

export type ForkSessionContentInput = {
  sourceWorkspaceId: string;
  sourceSessionId: string;
  actorSubjectId: string;
  destinationWorkspaceId: string;
  destinationVisibility: SessionTenancyVisibility;
  operationKey: string;
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
};

export async function sessionTenancyProductActivated(
  db: Database,
  workspaceId: string,
): Promise<boolean> {
  const { accountId } = await rlsContextForWorkspace(db, workspaceId);
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await rawRows<{ activated: boolean }>(
      scopedDb,
      sql`select session_tenancy_product_activated(
        ${accountId}::uuid,
        ${SESSION_TENANCY_ACTIVATION_VERSION}
      ) as activated`,
    );
    return rows[0]?.activated === true;
  });
}

/** Open the exact transaction-local trigger capability used by atomic private create. */
export async function openPrivateSessionCreateCapability(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; actorSubjectId: string },
): Promise<{ capabilityId: string; ownerMembershipId: string }> {
  const rows = await rawRows<{ capabilityId: string; ownerMembershipId: string }>(
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

async function assertSessionTenancyProductActivated(
  db: Database,
  workspaceId: string,
): Promise<void> {
  if (!(await sessionTenancyProductActivated(db, workspaceId))) {
    throw new SessionTenancyNotActivatedError();
  }
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
    "sourceSessionId" | "destinationWorkspaceId" | "destinationVisibility"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        sourceSessionId: input.sourceSessionId,
        destinationWorkspaceId: input.destinationWorkspaceId,
        destinationVisibility: input.destinationVisibility,
      }),
    )
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
  await assertSessionTenancyProductActivated(db, input.workspaceId);
  try {
    return await withWorkspaceSubjectSessionActivityRls(
      db,
      input.workspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
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
        return result;
      },
    );
  } catch (error) {
    mapSessionTenancyPersistenceError(error, { authorityEpochConflict: true });
  }
}

export async function forkSessionContent(
  db: Database,
  input: ForkSessionContentInput,
): Promise<ForkSessionContentResult> {
  if (!input.operationKey.trim()) throw new Error("operationKey must not be empty");
  if (input.destinationWorkspaceId !== input.sourceWorkspaceId) {
    throw new Error("The first session fork contract is same-workspace only");
  }
  if (input.destinationVisibility !== "user_private") {
    throw new Error("The first session fork contract is private-only");
  }
  const { accountId } = await rlsContextForWorkspace(db, input.sourceWorkspaceId);
  await assertSessionTenancyProductActivated(db, input.sourceWorkspaceId);
  const requestHash = canonicalSessionForkHash(input);
  try {
    return await withWorkspaceSubjectRls(
      db,
      input.sourceWorkspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
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
          replay
        from fork_session_content(
          ${accountId}::uuid,
          ${input.sourceWorkspaceId}::uuid,
          ${input.sourceSessionId}::uuid,
          ${input.actorSubjectId},
          ${input.destinationWorkspaceId}::uuid,
          ${input.destinationVisibility},
          ${input.operationKey},
          ${requestHash},
          ${SESSION_TENANCY_ACTIVATION_VERSION}
        )`,
        );
        const result = rows[0];
        if (!result) throw new Error("Session fork returned no result");
        return result;
      },
    );
  } catch (error) {
    mapSessionTenancyPersistenceError(error, { authorityEpochConflict: false });
  }
}
