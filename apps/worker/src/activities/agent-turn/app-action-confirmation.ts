import {
  APP_ACTION_CALL_TOOL_NAME,
  appActionCallChangesState,
  appActionCallHandlesSecrets,
  appActionConfirmationTitle,
} from "@opengeni/contracts/app-actions";
import {
  prefixedMcpToolName,
  type ConnectorActionPolicyHooks,
  type ConnectorActionToolCall,
} from "@opengeni/runtime";

/** As whom this turn's app actions run; see resolveSessionAppActionAuthority. */
export type AppActionAuthorityKind = "full_access" | "confirm" | "read_only" | "unavailable";

const APP_ACTION_CALL_MODEL_NAME = prefixedMcpToolName("opengeni", APP_ACTION_CALL_TOOL_NAME);

/**
 * Word an app action's pending approval as the same plain question its saved
 * review asks, so every surface that draws the approval from the event alone
 * (embeds, the session-ui components) shows it too. Presentation only.
 */
export function withAppActionApprovalTitle(
  approval: unknown,
  chat: { workspaceId: string; sessionId: string },
): unknown {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return approval;
  const item = approval as Record<string, unknown>;
  const raw =
    item.rawItem && typeof item.rawItem === "object" && !Array.isArray(item.rawItem)
      ? (item.rawItem as Record<string, unknown>)
      : {};
  if ((item.name ?? item.toolName ?? raw.name) !== APP_ACTION_CALL_MODEL_NAME) return approval;
  const display =
    item.display && typeof item.display === "object" && !Array.isArray(item.display)
      ? (item.display as Record<string, unknown>)
      : {};
  return {
    ...item,
    display: {
      ...display,
      toolName: APP_ACTION_CALL_TOOL_NAME,
      title: appActionConfirmationTitle(item.arguments ?? raw.arguments, chat),
    },
  };
}

/**
 * Decide, per admin_action_call, whether it waits for the person's
 * confirmation in the chat: a change in a session without full access does,
 * with a plain question as the card's title. A read, a full-access session,
 * and anything the API refuses whatever the answer (an action that handles
 * secrets, a change from a read-only embed, a turn where the route is
 * unavailable) run without a card, so nobody is asked to allow what can't run. The API checks the confirmation again before a
 * change runs. Every other call passes through untouched.
 *
 * One call keeps its first decision within an attempt, so its preparation and
 * execution always agree.
 */
export function withAppActionConfirmation(
  policy: ConnectorActionPolicyHooks,
  chat: {
    workspaceId: string;
    sessionId: string;
    authority: () => Promise<AppActionAuthorityKind>;
  },
): ConnectorActionPolicyHooks {
  const decided = new Map<string, boolean>();
  const decide = async (call: ConnectorActionToolCall): Promise<ConnectorActionToolCall> => {
    if (call.serverId !== "opengeni" || call.toolName !== APP_ACTION_CALL_TOOL_NAME) return call;
    let confirm = decided.get(call.approvalId);
    if (confirm === undefined) {
      confirm =
        appActionCallChangesState(call.arguments) &&
        !appActionCallHandlesSecrets(call.arguments) &&
        (await chat.authority()) === "confirm";
      decided.set(call.approvalId, confirm);
    }
    if (confirm) {
      return {
        ...call,
        approvalMode: "session_mcp",
        defaultDecision: "ask",
        reviewContext: {
          kind: "generic",
          ...call.reviewContext,
          title: appActionConfirmationTitle(call.arguments, chat),
        },
      };
    }
    const { approvalMode: _approvalMode, ...rest } = call;
    return { ...rest, defaultDecision: "allow" };
  };
  return {
    ...(policy.preview
      ? { preview: async (call) => await policy.preview!(await decide(call)) }
      : {}),
    prepare: async (call) => await policy.prepare(await decide(call)),
    begin: async (call) => await policy.begin(await decide(call)),
    complete: policy.complete,
  };
}
