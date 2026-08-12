import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  rawRows,
  type Database,
  rlsContextForWorkspace,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
} from "./database";

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
  sessionId: string;
  workspaceId: string;
  visibility: SessionTenancyVisibility;
  authorityEpoch: number;
  copiedHistoryItemCount: number;
  replay: boolean;
};

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
  return await withWorkspaceSubjectSessionActivityRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const rows = await rawRows<{
        operationId: string;
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
          ${requestHash}
        )`,
      );
      const result = rows[0];
      if (!result) throw new Error("Session visibility transition returned no result");
      return result;
    },
  );
}

export async function forkSessionContent(
  db: Database,
  input: ForkSessionContentInput,
): Promise<ForkSessionContentResult> {
  if (!input.operationKey.trim()) throw new Error("operationKey must not be empty");
  const { accountId } = await rlsContextForWorkspace(db, input.sourceWorkspaceId);
  const requestHash = canonicalSessionForkHash(input);
  return await withWorkspaceSubjectRls(
    db,
    input.sourceWorkspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const rows = await rawRows<ForkSessionContentResult>(
        scopedDb,
        sql`select
          operation_id as "operationId",
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
          ${requestHash}
        )`,
      );
      const result = rows[0];
      if (!result) throw new Error("Session fork returned no result");
      return result;
    },
  );
}
