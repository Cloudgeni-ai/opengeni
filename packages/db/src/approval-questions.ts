import { and, desc, eq } from "drizzle-orm";
import { McpElicitationApprovalRequest } from "@opengeni/contracts";
import type { Database } from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";
import * as schema from "./schema";

/**
 * The question a tool's MCP server asked about one pending approval, read from
 * a run state's pending approvals (`elicitation` on the entry), or undefined.
 */
export function pendingApprovalQuestion(
  pending: unknown,
  approvalId: string,
): McpElicitationApprovalRequest | undefined {
  if (!Array.isArray(pending)) return undefined;
  for (const value of pending) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const raw =
      item.rawItem && typeof item.rawItem === "object"
        ? (item.rawItem as Record<string, unknown>)
        : {};
    if ((raw.callId ?? raw.id ?? item.id ?? item.callId) !== approvalId) continue;
    const parsed = McpElicitationApprovalRequest.safeParse(item.elicitation);
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
}

/** The question waiting on one approval of a turn, from its latest run state. */
export async function waitingApprovalQuestion(
  scoped: Database,
  input: { workspaceId: string; sessionId: string; turnId: string; approvalId: string },
): Promise<McpElicitationApprovalRequest | undefined> {
  const [state] = await scoped
    .select({
      pending: schema.agentRunStates.pendingApprovals,
      codec: schema.agentRunStates.pendingApprovalsCodecVersion,
    })
    .from(schema.agentRunStates)
    .where(
      and(
        eq(schema.agentRunStates.workspaceId, input.workspaceId),
        eq(schema.agentRunStates.sessionId, input.sessionId),
        eq(schema.agentRunStates.turnId, input.turnId),
      ),
    )
    .orderBy(desc(schema.agentRunStates.stateVersion))
    .limit(1);
  if (!state) return undefined;
  try {
    return pendingApprovalQuestion(
      fromPostgresLosslessJson(state.pending, state.codec),
      input.approvalId,
    );
  } catch {
    // The question is presentation: an unreadable state leaves the review without it.
    return undefined;
  }
}
