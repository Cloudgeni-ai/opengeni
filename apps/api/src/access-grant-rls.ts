import type { AccessGrant } from "@opengeni/contracts";
import {
  requireLiveAgentAttemptAuthorization,
  SessionAuthorizationDeniedError,
  type ApiRouteDeps,
} from "@opengeni/core";
import { withSessionRlsActorContext } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

export async function withAccessGrantSessionRlsContext<T>(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  fn: () => Promise<T>,
): Promise<T> {
  if (grant.principalKind !== "agent_attempt") {
    return await withSessionRlsActorContext({ subjectId: grant.subjectId }, fn);
  }
  const callerSessionId = grant.metadata?.sessionId;
  if (typeof callerSessionId !== "string") {
    throw new HTTPException(403, { message: "agent attempt authority is invalid" });
  }
  try {
    const actor = await requireLiveAgentAttemptAuthorization(deps.db, grant, callerSessionId);
    return await withSessionRlsActorContext(
      {
        subjectId: actor.subjectId,
        initiatingHumanSubjectId: actor.initiatingHumanSubjectId,
      },
      fn,
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
