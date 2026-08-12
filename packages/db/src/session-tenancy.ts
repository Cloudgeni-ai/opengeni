import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  rawRows,
  type Database,
  rlsContextForWorkspace,
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

export async function transitionSessionVisibility(
  db: Database,
  input: TransitionSessionVisibilityInput,
): Promise<TransitionSessionVisibilityResult> {
  if (
    !Number.isSafeInteger(input.expectedAuthorityEpoch) ||
    input.expectedAuthorityEpoch < 1
  ) {
    throw new Error("expectedAuthorityEpoch must be a positive safe integer");
  }
  if (!input.operationKey.trim())
    throw new Error("operationKey must not be empty");
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
      if (!result)
        throw new Error("Session visibility transition returned no result");
      return result;
    },
  );
}
