import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  assertWorkspaceContentExchangeAllowed,
  assertWorkspaceContentFlowAllowed,
  WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE,
  WorkspaceContentFlowRefusedError,
  workspaceContentFlowEnd,
  type Database,
  type WorkspaceContentFlowEnd,
} from "@opengeni/db";

/* ----------------------------------------------------------------------------
   A session reaching another workspace (session tools given a workspaceId,
   admin_action_call naming one) brings that workspace's content back here, and
   a change also carries this session's content there. EU-only content stays in
   EU-only workspaces, so each call is checked for this exact pair first, and
   nothing runs when the check refuses or can't be made.
   -------------------------------------------------------------------------- */

/**
 * `from_there`: the call only brings the other workspace's content here.
 * `both_ways`: it also carries this session's content there.
 */
export type OtherWorkspaceContentFlow = "from_there" | "both_ways";

export const REGION_RESTRICTED_TOOL_MESSAGE = `${WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE} Nothing was run. Tell the person plainly; it can't be worked around from here.`;
const UNCHECKED =
  "Nothing was run: Opengeni couldn't confirm that content may move between these workspaces. Retry.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Null when the call may run; otherwise the refusal to return instead. */
export async function otherWorkspaceContentRefusal(
  db: Database,
  input: {
    here: WorkspaceContentFlowEnd;
    thereWorkspaceId: string;
    flow: OtherWorkspaceContentFlow;
  },
): Promise<CallToolResult | null> {
  // Not a workspace id, or this one: the route answers as it always has.
  if (!UUID.test(input.thereWorkspaceId)) return null;
  if (input.thereWorkspaceId.toLowerCase() === input.here.workspaceId.toLowerCase()) return null;
  try {
    const there = await workspaceContentFlowEnd(db, input.thereWorkspaceId.toLowerCase());
    // No such workspace holds no content; the route answers not found.
    if (!there) return null;
    if (input.flow === "both_ways") {
      await assertWorkspaceContentExchangeAllowed(db, { here: input.here, there });
    } else {
      await assertWorkspaceContentFlowAllowed(db, { source: there, target: input.here });
    }
    return null;
  } catch (error) {
    if (error instanceof WorkspaceContentFlowRefusedError)
      return refusal(REGION_RESTRICTED_TOOL_MESSAGE);
    return refusal(UNCHECKED);
  }
}
