import type { AccessGrant } from "@opengeni/contracts";
import {
  buildFleetContextForSession,
  requireLiveAgentAttemptAuthorization,
  type FleetContext,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";

/** The exact live attempt a first-party agent token names, or null for any
 * other caller. */
export function exactAgentAttemptClaims(grant: AccessGrant): {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
} | null {
  if (grant.principalKind !== "agent_attempt") return null;
  const metadata = grant.metadata ?? {};
  if (
    typeof metadata["sessionId"] !== "string" ||
    typeof metadata["turnId"] !== "string" ||
    typeof metadata["attemptId"] !== "string" ||
    typeof metadata["executionGeneration"] !== "number" ||
    !Number.isSafeInteger(metadata["executionGeneration"]) ||
    metadata["executionGeneration"] < 1 ||
    metadata["executionGeneration"] > 2_147_483_647
  ) {
    return null;
  }
  return {
    sessionId: metadata["sessionId"],
    turnId: metadata["turnId"],
    attemptId: metadata["attemptId"],
    executionGeneration: metadata["executionGeneration"],
  };
}

/**
 * Whether this caller is an agent attempt reading or steering its own chat's
 * machines. Such an attempt may list the machines its chat can use with only
 * the session permissions its sandboxes_list tool needs.
 */
export function isAgentAttemptOnOwnSession(grant: AccessGrant, sessionId: string): boolean {
  return exactAgentAttemptClaims(grant)?.sessionId === sessionId;
}

/**
 * The person whose machines an agent attempt sees on its own chat: the person
 * who started its turn, as its sandboxes_list tool resolves them. Any other
 * caller, or a turn no person started, keeps `fallbackSubjectId`.
 */
export async function machineSubjectForCaller(
  deps: { db: Database },
  grant: AccessGrant,
  sessionId: string,
  fallbackSubjectId: string,
): Promise<string> {
  if (!isAgentAttemptOnOwnSession(grant, sessionId)) return fallbackSubjectId;
  const actor = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
  return actor.initiatingHumanSubjectId ?? fallbackSubjectId;
}

/**
 * The fleet context an agent attempt moves or lists its own chat's machines
 * with: it acts for the person who started its turn (so their personal
 * machines are in reach, subject to the per-chat permission) under that
 * exact attempt's custody. Every agent-facing machine surface (the
 * sandbox_swap MCP tool and the swap route an agent's interaction tools call)
 * builds it here, so they resolve the same machines and refusals. Any other
 * caller gets `fallbackSubjectId` as its subject.
 */
export async function sessionFleetContextForCaller(
  deps: { db: Database },
  grant: AccessGrant,
  sessionId: string,
  fallbackSubjectId?: string,
): Promise<FleetContext> {
  const claims = exactAgentAttemptClaims(grant);
  const actor = claims
    ? await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId)
    : null;
  const subjectId = actor ? actor.initiatingHumanSubjectId : fallbackSubjectId;
  return await buildFleetContextForSession(deps, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    ...(subjectId ? { subjectId } : {}),
    ...(actor && claims
      ? {
          commandAttempt: {
            turnId: claims.turnId,
            attemptId: claims.attemptId,
            executionGeneration: claims.executionGeneration,
          },
        }
      : {}),
    ...(actor?.initiatingHumanSubjectId && claims
      ? {
          attemptAuthority: {
            turnId: claims.turnId,
            attemptId: claims.attemptId,
            executionGeneration: claims.executionGeneration,
            initiatingHumanSubjectId: actor.initiatingHumanSubjectId,
          },
        }
      : {}),
  });
}
