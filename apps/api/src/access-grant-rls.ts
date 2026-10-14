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
  currentCreditDebitAttribution,
} from "@opengeni/db";
import { ApiHttpError } from "./http/api-error";

const AGENT_ATTEMPT_AUTHORITY_INVALID = "agent attempt authority is invalid";

/**
 * A refused agent-attempt credential. The detail code names why, so request
 * telemetry can tell a process that outlived its turn (`caller_stale`) from a
 * malformed or revoked credential instead of reporting it as unclassified.
 */
function agentAttemptAuthorityError(
  reason: "malformed" | SessionAuthorizationDeniedError["reason"],
  cause?: unknown,
): ApiHttpError {
  const error = new ApiHttpError(403, {
    code: "forbidden",
    message: AGENT_ATTEMPT_AUTHORITY_INVALID,
    retryable: false,
    outcomeUnknown: false,
    details: { code: `agent_attempt_${reason}` },
  });
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Trusted payer for a non-agent grant: an authenticated human session pays as
 * that human; keys and services are service work. An agent attempt must be
 * resolved through the validated middleware context installed below.
 */
export function creditDebitAttributionForGrant(grant: AccessGrant): CreditDebitAttribution {
  if (grant.principalKind === "agent_attempt") return currentCreditDebitAttribution();
  return grant.principalKind === "human_session"
    ? { kind: "human", initiatingHumanSubjectId: grant.subjectId }
    : ["service", "api_key", "configured_key", "mcp_gateway"].includes(grant.principalKind ?? "")
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
    throw agentAttemptAuthorityError("malformed");
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
      throw agentAttemptAuthorityError(error.reason, error);
    }
    throw error;
  }
}
