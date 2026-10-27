import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import {
  OPENGENI_CALLING_WORKSPACE_HEADER,
  verifyCallingWorkspaceProof,
} from "@opengeni/contracts";
import {
  assertOrganizationContentFlowAllowed,
  assertWorkspaceContentExchangeAllowed,
  assertWorkspaceContentFlowAllowed,
  WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE,
  WorkspaceContentFlowRefusedError,
  workspaceContentFlowEnd,
  type Database,
  type WorkspaceContentFlowEnd,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/* ----------------------------------------------------------------------------
   EU-only content stays in EU-only workspaces (docs/organization-tenancy.md).

   A session reaching another workspace of its organization (session tools
   given a workspaceId, admin_action_call naming one) brings that workspace's
   content back here, and anything carrying this session's text also takes it
   there. Each call is checked for this exact pair before it runs and again
   when it returns; nothing runs, or comes back, when the check refuses or
   can't be made. A workspace of another organization isn't checked here: the
   route answers it the same as one that doesn't exist, so the answer never
   says it exists or how it is set.

   An agent of one workspace calling Opengeni's own MCP endpoints as a remote
   MCP server sends a signed header naming its workspace (the runtime adds it
   and sends nothing it can't sign). The endpoint refuses when content of the
   workspace or organization it reaches may not go to that workspace.
   -------------------------------------------------------------------------- */

/**
 * `from_there`: the call only brings the other workspace's content here.
 * `both_ways`: it also carries this session's content there.
 */
export type OtherWorkspaceContentFlow = "from_there" | "both_ways";

export const REGION_RESTRICTED_TOOL_MESSAGE = `${WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE} Nothing was run. Tell the person plainly; it can't be worked around from here.`;
const UNCHECKED =
  "Nothing was run: Opengeni couldn't confirm that content may move between these workspaces. Retry.";
/** After the call ran: its answer is withheld instead. */
const REGION_RESTRICTED_AFTER = `${WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE} The answer isn't shown. Tell the person plainly; it can't be worked around from here.`;
const UNCHECKED_AFTER =
  "The answer isn't shown: Opengeni couldn't confirm that content may move between these workspaces. Retry.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The tool answer for a failed check, before the call (nothing ran) or after
 * it (its answer is withheld): a refusal, or a retryable unknown.
 */
export function contentFlowCheckFailure(
  error: unknown,
  phase: "before" | "after" = "before",
): CallToolResult {
  const refused = error instanceof WorkspaceContentFlowRefusedError;
  if (phase === "after") return refusal(refused ? REGION_RESTRICTED_AFTER : UNCHECKED_AFTER);
  return refusal(refused ? REGION_RESTRICTED_TOOL_MESSAGE : UNCHECKED);
}

/** Null when the call may run; otherwise the refusal to return instead. */
export async function otherWorkspaceContentRefusal(
  db: Database,
  input: {
    here: WorkspaceContentFlowEnd;
    thereWorkspaceId: string;
    flow: OtherWorkspaceContentFlow;
  },
  phase: "before" | "after" = "before",
): Promise<CallToolResult | null> {
  // Not a workspace id, or this one: the route answers as it always has.
  if (!UUID.test(input.thereWorkspaceId)) return null;
  if (input.thereWorkspaceId.toLowerCase() === input.here.workspaceId.toLowerCase()) return null;
  try {
    const there = await workspaceContentFlowEnd(db, input.thereWorkspaceId.toLowerCase());
    // No such workspace, or another organization's: the route answers that
    // this person can't reach it, exactly as it always has.
    if (!there || there.accountId !== input.here.accountId) return null;
    if (input.flow === "both_ways") {
      await assertWorkspaceContentExchangeAllowed(db, { here: input.here, there });
    } else {
      await assertWorkspaceContentFlowAllowed(db, { source: there, target: input.here });
    }
    return null;
  } catch (error) {
    return contentFlowCheckFailure(error, phase);
  }
}

/**
 * Run a call that reaches another workspace: checked before it runs and
 * again when it returns (a wait can outlast a setting change), so nothing
 * comes back once the check refuses.
 */
export async function withOtherWorkspaceContentFlow(
  db: Database,
  input: {
    here: WorkspaceContentFlowEnd;
    thereWorkspaceId: string;
    flow: OtherWorkspaceContentFlow;
  },
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const before = await otherWorkspaceContentRefusal(db, input);
  if (before) return before;
  const result = await run();
  return (await otherWorkspaceContentRefusal(db, input, "after")) ?? result;
}

/**
 * For Opengeni's own MCP endpoints: when the request names the Opengeni
 * workspace calling (a remote MCP server added to it), refuse unless content
 * of what the request reaches may go to that workspace. A request without the
 * header doesn't come from a workspace agent. Call only after the caller is
 * authorized, so a refusal says nothing to anyone who can't already reach it.
 */
export async function requireCallingWorkspaceContentFlow(
  deps: { db: Database; settings: Settings },
  request: Request,
  reached: { workspaceId: string } | { accountId: string },
): Promise<void> {
  const header = request.headers.get(OPENGENI_CALLING_WORKSPACE_HEADER);
  if (header === null) return;
  const secret = resolveFirstPartyDelegationSecret(deps.settings);
  const calling = secret ? await verifyCallingWorkspaceProof(secret, header) : null;
  if (!calling)
    throw new HTTPException(403, {
      message: "Nothing was run: Opengeni couldn't confirm which workspace is calling.",
    });
  if ("accountId" in reached) {
    await assertOrganizationContentFlowAllowed(deps.db, {
      sourceAccountId: reached.accountId,
      target: calling,
    });
    return;
  }
  const source = await workspaceContentFlowEnd(deps.db, reached.workspaceId);
  if (!source) throw new HTTPException(404, { message: "workspace not found" });
  await assertWorkspaceContentFlowAllowed(deps.db, { source, target: calling });
}
