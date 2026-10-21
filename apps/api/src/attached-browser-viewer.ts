import type { AccessGrant } from "@opengeni/contracts";
import { requireLiveAgentAttemptAuthorization, type ApiRouteDeps } from "@opengeni/core";
import type { AttachedBrowserViewer } from "@opengeni/db";

/**
 * The person whose machine access decides which attached browsers a caller
 * may see and control. Personal (Only me) machines belong to one person, so a
 * human sees and controls their own; an agent acts for the person who started
 * its turn (never merely for the workspace). Other callers (keys, services)
 * reach only machines that are not personal.
 */
export async function attachedBrowserViewer(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  workspaceId: string,
): Promise<AttachedBrowserViewer> {
  let subjectId = grant.subjectId;
  if (grant.principalKind === "agent_attempt") {
    const callerSessionId = grant.metadata?.["sessionId"];
    if (typeof callerSessionId === "string") {
      const actor = await requireLiveAgentAttemptAuthorization(deps.db, grant, callerSessionId);
      subjectId = actor.initiatingHumanSubjectId ?? grant.subjectId;
    }
  }
  return { accountId: grant.accountId, workspaceId, subjectId };
}
