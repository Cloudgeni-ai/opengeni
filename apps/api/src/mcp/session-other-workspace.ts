import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolGatewayInvokeResponse } from "@opengeni/contracts";
import * as z4 from "zod/v4";

import { runOrganizationAction } from "../organization-mcp";
import type { SessionAdminReach } from "./session-admin-access-tools";

/* ----------------------------------------------------------------------------
   Session tools act on this workspace's chats. Given another workspace's id, a
   session with full access reaches a chat there with the same tool, run as the
   person who gave that access through the action admin_action_call already
   runs (the workspace tool gateway's invoke), so it can do exactly what that
   person can do there right now and nothing more, and what it writes is that
   person's, as with every other action it takes for them. Without full
   access, or for a chat that person can't open, the answer never says whether
   the chat exists.
   -------------------------------------------------------------------------- */

export const OTHER_WORKSPACE_SESSION_TOOLS = [
  "session_get",
  "session_events",
  "session_wait",
  "session_send_message",
  "session_steer",
  "session_pause",
  "session_resume",
] as const;
export type OtherWorkspaceSessionTool = (typeof OTHER_WORKSPACE_SESSION_TOOLS)[number];
const OTHER_WORKSPACE_SESSION_TOOL_SET: ReadonlySet<string> = new Set(
  OTHER_WORKSPACE_SESSION_TOOLS,
);

/** The first-party server's identity in a workspace's tool gateway. */
const FIRST_PARTY_SERVER_ID = "opengeni";
const INVOKE_ACTION = "POST /v1/workspaces/:workspaceId/tools/invoke";
const MAX_NEXT_ACTION_DEPTH = 8;

export const workspaceIdToolInput = () =>
  z4
    .string()
    .uuid()
    .optional()
    .describe(
      "Only for a chat in another workspace: its workspace id, from its link (/workspaces/<workspaceId>/sessions/<sessionId>). Reaches it when this session has full access, as the person who gave it. Omit for this workspace.",
    );

const NOT_REACHABLE =
  "Session not found or access denied: there is no chat with that id in that workspace that the person who gave this session full access can open.";
const NO_FULL_ACCESS =
  "Session tools reach only chats in this workspace: this session has no full access, which is what reaches chats in other workspaces. The person who started this session can give it full access from the session's menu in the app, if their organization allows it.";
const ENDED =
  "This session no longer has full access, so session tools reach only chats in this workspace. The person who started it can give it again from the session's menu in the app.";

function refusal(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Explains a not-found-or-denied answer about a chat in this workspace without
 * saying whether it exists anywhere else: how a chat in another workspace is
 * reached, given whether this session has full access.
 */
export function sessionToolDenialHint(fullAccess: boolean): string {
  return fullAccess
    ? "Session tools look in this workspace unless you pass workspaceId. For a chat in another workspace, pass the workspaceId from its link (/workspaces/<workspaceId>/sessions/<sessionId>); this session's full access reaches it as the person who gave that access."
    : "Session tools reach only chats in this workspace. A chat in another workspace needs this session to have full access, which the person who started it can give from the session's menu in the app, if their organization allows it; then pass that chat's workspaceId.";
}

function isDenial(result: { content?: unknown; structuredContent?: unknown }): boolean {
  const code = (result.structuredContent as { error?: { code?: unknown } } | undefined)?.error
    ?.code;
  if (typeof code === "string" && code.endsWith("_not_found_or_denied")) return true;
  return (
    Array.isArray(result.content) &&
    result.content.some(
      (block: { type?: unknown; text?: unknown }) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        /session not found or access denied|session not found\b/i.test(block.text),
    )
  );
}

/** Follow-up hints in the result name this workspace's id, so they stay correct. */
function withWorkspaceInNextActions(value: unknown, workspaceId: string, depth = 0): unknown {
  if (depth > MAX_NEXT_ACTION_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => withWorkspaceInNextActions(item, workspaceId, depth + 1));
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record))
    out[key] = withWorkspaceInNextActions(item, workspaceId, depth + 1);
  const args = out["arguments"];
  if (
    typeof out["tool"] === "string" &&
    OTHER_WORKSPACE_SESSION_TOOL_SET.has(out["tool"]) &&
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args)
  ) {
    out["arguments"] = { ...(args as Record<string, unknown>), workspaceId };
  }
  return out;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Run one session tool on a chat in another workspace, as the person who gave
 * this session full access. `adjust` may rewrite the tool's JSON answer (for
 * example to add this caller's own pending input to a wait).
 */
export async function reachSessionInOtherWorkspace(input: {
  reach: SessionAdminReach | null;
  workspaceId: string;
  toolName: OtherWorkspaceSessionTool;
  arguments: Record<string, unknown>;
  adjust?: (value: unknown) => Promise<unknown>;
}): Promise<CallToolResult> {
  if (!input.reach) return refusal(NO_FULL_ACCESS);
  if (input.toolName === "session_get" && input.arguments["sessionId"] === undefined)
    return refusal("Pass sessionId with workspaceId: it names a chat in that workspace.");
  const actingPerson = await input.reach.actingPerson();
  if (!actingPerson) return refusal(ENDED);
  const outcome = await runOrganizationAction(actingPerson, {
    id: INVOKE_ACTION,
    pathParameters: { workspaceId: input.workspaceId },
    query: {},
    body: {
      target: { identity: { serverId: FIRST_PARTY_SERVER_ID, toolName: input.toolName } },
      operationId: crypto.randomUUID(),
      arguments: input.arguments,
    },
  });
  if ("refused" in outcome) return outcome.refused;
  const { response } = outcome;
  if (response.status !== 200) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
    } | null;
    // A workspace the person can't use and a chat they can't open read the
    // same as one that doesn't exist.
    if (response.status === 401 || response.status === 403 || response.status === 404)
      return refusal(NOT_REACHABLE);
    if (response.status >= 500)
      return refusal("That workspace is temporarily unavailable — retry.");
    const message = typeof body?.error?.message === "string" ? body.error.message : null;
    return refusal(
      `That workspace refused the request (${response.status})${message ? `: ${message}` : "."}`,
    );
  }
  const parsed = ToolGatewayInvokeResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return refusal("That workspace is temporarily unavailable — retry.");
  const result = parsed.data.result;
  if (result.isError && isDenial(result)) return refusal(NOT_REACHABLE);
  const content: CallToolResult["content"] = [];
  for (const block of result.content) {
    if (block.type !== "text") {
      content.push(block as CallToolResult["content"][number]);
      continue;
    }
    const json = parseJson(block.text);
    if (!json.ok) {
      content.push({ type: "text", text: block.text });
      continue;
    }
    let value = withWorkspaceInNextActions(json.value, input.workspaceId);
    if (input.adjust && !result.isError) value = await input.adjust(value);
    content.push({ type: "text", text: JSON.stringify(value, null, 2) });
  }
  return {
    content,
    ...(result.structuredContent
      ? {
          structuredContent: withWorkspaceInNextActions(
            result.structuredContent,
            input.workspaceId,
          ) as Record<string, unknown>,
        }
      : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}
