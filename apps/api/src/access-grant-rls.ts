import type { AccessGrant } from "@opengeni/contracts";
import {
  requireLiveAgentAttemptAuthorization,
  SessionAuthorizationDeniedError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  freezeAgentLearningPolicy,
  withSessionRlsActorContext,
  withCreditDebitAttribution,
  type CreditDebitAttribution,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/**
 * Trusted payer for a non-agent grant: an authenticated human session pays as
 * that human; keys and services are service work. An agent attempt must be
 * resolved through its live attempt (see below) and is `unknown` here.
 */
export function creditDebitAttributionForGrant(grant: AccessGrant): CreditDebitAttribution {
  return grant.principalKind === "human_session"
    ? { kind: "human", initiatingHumanSubjectId: grant.subjectId }
    : grant.principalKind === "service" ||
        grant.principalKind === "api_key" ||
        grant.principalKind === "configured_key" ||
        grant.principalKind === "mcp_gateway"
      ? { kind: "service" }
      : { kind: "unknown" };
}

export async function withAccessGrantSessionRlsContext<T>(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  fn: () => Promise<T>,
): Promise<T> {
  if (grant.principalKind !== "agent_attempt") {
    return await withCreditDebitAttribution(creditDebitAttributionForGrant(grant), () =>
      withSessionRlsActorContext({ subjectId: grant.subjectId }, fn),
    );
  }
  const callerSessionId = grant.metadata?.sessionId;
  if (typeof callerSessionId !== "string") {
    throw new HTTPException(403, { message: "agent attempt authority is invalid" });
  }
  try {
    const actor = await requireLiveAgentAttemptAuthorization(deps.db, grant, callerSessionId);
    const learning = await freezeAgentLearningPolicy(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "agent",
        sessionId: actor.callerSessionId,
        turnId: actor.turnId,
        attemptId: actor.attemptId,
        executionGeneration: actor.executionGeneration,
      },
    });
    return await withCreditDebitAttribution(
      {
        kind: "turn",
        turnId: actor.turnId,
        initiatingHumanSubjectId: actor.initiatingHumanSubjectId ?? null,
      },
      () =>
        withSessionRlsActorContext(
          {
            subjectId: actor.subjectId,
            initiatingHumanSubjectId: actor.initiatingHumanSubjectId,
            privateFileOwnerSubjectId:
              learning.defaultScope === "personal" ? learning.subjectId : null,
          },
          fn,
        ),
    );
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) {
      throw new HTTPException(403, {
        message: "agent attempt authority is invalid",
        cause: error,
      });
    }
    throw error;
  }
}
