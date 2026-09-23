import { and, eq, inArray } from "drizzle-orm";
import type { SessionMcpApprovalPolicy } from "@opengeni/contracts";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/** Read only the immutable active-attempt policy, never a mutable session fallback. */
export async function getSessionAttemptMcpApprovalPolicies(
  db: Database,
  workspaceId: string,
  sessionId: string,
  attemptId: string,
): Promise<Record<string, SessionMcpApprovalPolicy>> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const [attempt] = await tx
      .select({ policies: schema.sessionTurnAttempts.mcpApprovalPolicies })
      .from(schema.sessionTurnAttempts)
      .where(
        and(
          eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
          eq(schema.sessionTurnAttempts.sessionId, sessionId),
          eq(schema.sessionTurnAttempts.id, attemptId),
          inArray(schema.sessionTurnAttempts.state, ["claimed", "running"]),
        ),
      )
      .limit(1);
    if (!attempt)
      throw new Error(`session MCP policy snapshot is unavailable for attempt ${attemptId}`);
    return attempt.policies;
  });
}
