import { and, eq, inArray } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

/**
 * The saved arguments of first-party `toolName` calls a person approved in
 * this chat that this exact attempt is running right now: approved by a
 * person or an API caller acting for the workspace (never by an agent, such
 * as a parent answering for its worker, or by the system), and marked as
 * executing by this attempt. A tool that changes what the chat can reach
 * runs only when its arguments are one of these, whatever path called it.
 */
export async function listPersonApprovedFirstPartyToolCalls(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    toolName: string;
  },
): Promise<string[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select({ reviewArguments: schema.connectorActionRequests.reviewArguments })
        .from(schema.connectorActionRequests)
        .where(
          and(
            eq(schema.connectorActionRequests.workspaceId, input.workspaceId),
            eq(schema.connectorActionRequests.sessionId, input.sessionId),
            eq(schema.connectorActionRequests.turnId, input.turnId),
            eq(schema.connectorActionRequests.executionAttemptId, input.attemptId),
            eq(schema.connectorActionRequests.serverId, "opengeni"),
            eq(schema.connectorActionRequests.toolName, input.toolName),
            eq(schema.connectorActionRequests.status, "executing"),
            eq(schema.connectorActionRequests.decision, "approve"),
            inArray(schema.connectorActionRequests.decisionByKind, ["human", "api"]),
          ),
        );
      return rows.flatMap((row) => (row.reviewArguments === null ? [] : [row.reviewArguments]));
    },
  );
}
