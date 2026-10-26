import type { Agent } from "@openai/agents";
import {
  OPEN_SUFFIX_RUN_STATE_BLOB,
  approvalIdentifier,
  withPublicApprovalFields,
  type HumanInputResponse,
  type McpElicitationContent,
  type SessionEvent,
} from "@opengeni/contracts";
import {
  appendSessionHistoryItems,
  getActiveSessionHistoryItems,
  interruptedToolCallResult,
  listTurnOpenSuffixToolCalls,
  nextSessionHistoryPosition,
  recordPendingSessionToolCallResult,
  replacePendingToolCallMcpInputRequest,
  type Database,
  type OpenSuffixPendingToolCall,
} from "@opengeni/db";
import {
  functionCallResultItem,
  invokePreparedAgentTool,
  mcpElicitationApproval,
  mcpInputRequestOf,
  parseMcpInputRequest,
  sanitizeHistoryItemsForModel,
  type McpInputAnswer,
  type McpInputRequest,
} from "@opengeni/runtime";

export type OpenSuffixResumeOutcome =
  | { action: "continue" }
  | { action: "requires_action" }
  | { action: "cancelled" };

type OpenSuffixSettle = (input: {
  events: Array<
    | { type: "session.requiresAction"; payload: { approvals: unknown[] } }
    | { type: "session.status.changed"; payload: { status: "requires_action" } }
  >;
  turnStatus: "requires_action";
  sessionStatus: "requires_action";
  activeTurnId: string;
  runState: {
    serializedRunState: string;
    pendingApprovals: unknown[];
  };
}) => Promise<boolean>;

function argumentsJsonFromCallItem(callItem: Record<string, unknown>): string {
  const raw = callItem.arguments;
  if (typeof raw === "string") {
    return raw;
  }
  return JSON.stringify(raw ?? {});
}

function toolNameFromCallItem(callItem: Record<string, unknown>): string {
  return typeof callItem.name === "string" && callItem.name.length > 0 ? callItem.name : "tool";
}

function pendingApprovalProjection(row: OpenSuffixPendingToolCall): unknown {
  return {
    id: row.callId,
    name: toolNameFromCallItem(row.callItem),
    arguments: row.callItem.arguments ?? null,
    raw: row.callItem,
    ...(row.mcpInputRequest
      ? { elicitation: mcpElicitationApproval(parseMcpInputRequest(row.mcpInputRequest)) }
      : {}),
  };
}

function remainingSuffixApprovals(
  rows: readonly OpenSuffixPendingToolCall[],
  kinds: ReadonlySet<OpenSuffixPendingToolCall["interruptionKind"]>,
): unknown[] {
  return rows
    .filter((row) => row.resultItem == null && kinds.has(row.interruptionKind))
    .map(pendingApprovalProjection);
}

/** Matches the original pause `session.requiresAction` payload: ordinary approvals only. */
export function remainingPendingApprovalsFromSuffix(
  rows: readonly OpenSuffixPendingToolCall[],
): unknown[] {
  return remainingSuffixApprovals(rows, new Set(["approval"]));
}

/** Leftover `pendingApprovals` snapshot includes interaction interventions. */
export function remainingRunStatePendingApprovalsFromSuffix(
  rows: readonly OpenSuffixPendingToolCall[],
): unknown[] {
  return remainingSuffixApprovals(rows, new Set(["approval", "interaction_intervention"]));
}

export function openSuffixHistoryItems(
  row: OpenSuffixPendingToolCall,
  resultItem: Record<string, unknown>,
): Record<string, unknown>[] {
  return sanitizeHistoryItemsForModel([
    ...row.tiedReasoningItems,
    row.callItem,
    resultItem,
  ]) as Record<string, unknown>[];
}

export function matchingOpenSuffixCallId(input: {
  trigger: Pick<SessionEvent, "type" | "payload">;
  humanInputToolCallId?: string | undefined;
}): string | null {
  if (input.trigger.type === "user.humanInputResponse") {
    return input.humanInputToolCallId ?? null;
  }
  if (input.trigger.type === "user.approvalDecision") {
    const payload = input.trigger.payload as { approvalId?: unknown };
    return typeof payload.approvalId === "string" ? payload.approvalId : null;
  }
  return null;
}

function historyItemCallId(item: Record<string, unknown>): string | null {
  const value = item.callId ?? item.call_id ?? item.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function resolveOpenSuffixResumeTarget(
  rows: readonly OpenSuffixPendingToolCall[],
  callId: string | null,
): OpenSuffixPendingToolCall | null {
  if (!callId) {
    return null;
  }
  return rows.find((row) => row.callId === callId) ?? null;
}

/** True when the paired call and result already exist in durable history. */
export function openSuffixPairPresentInHistory(
  items: readonly Record<string, unknown>[],
  callId: string,
): boolean {
  let sawCall = false;
  for (const item of items) {
    if (historyItemCallId(item) !== callId) {
      continue;
    }
    const type = typeof item.type === "string" ? item.type : null;
    if (type === "function_call" || type === "computer_call") {
      sawCall = true;
      continue;
    }
    if (sawCall && (type === "function_call_result" || type === "computer_call_result")) {
      return true;
    }
  }
  return false;
}

function memberResult(input: {
  callId: string;
  name: string;
  output: unknown;
  resultItem?: Record<string, unknown>;
}): { resultItem: Record<string, unknown>; eventOutput: unknown } {
  return {
    resultItem:
      input.resultItem ??
      functionCallResultItem({
        callId: input.callId,
        name: input.name,
        output: input.output,
      }),
    eventOutput: input.output,
  };
}

/**
 * A resumed member either finishes with a result or, when its MCP server asks
 * the person another question, stays paused with that question.
 */
export type OpenSuffixMemberOutcome =
  | { resultItem: Record<string, unknown>; eventOutput: unknown }
  | { asked: McpInputRequest };

/**
 * What the model reads after the person declined an MCP server's question:
 * the server's own result for the declined call, then who declined and, if
 * they wrote one, their message.
 */
export function declinedMcpQuestionOutput(input: {
  output: unknown;
  server: string;
  message?: string | undefined;
}): string {
  const result =
    typeof input.output === "string" ? input.output : JSON.stringify(input.output ?? null);
  const message = input.message?.trim();
  const note = message
    ? `The person declined ${input.server}'s question and said: ${message}`
    : `The person declined ${input.server}'s question.`;
  return result.trim().length > 0 ? `${result}\n\n${note}` : note;
}

export async function resultItemForOpenSuffixMember(input: {
  agent: Agent<any, any>;
  row: OpenSuffixPendingToolCall;
  trigger: Pick<SessionEvent, "type" | "payload">;
  humanInputResume: {
    requestId: string;
    toolCallId: string;
    response: HumanInputResponse;
  } | null;
}): Promise<OpenSuffixMemberOutcome> {
  const name = toolNameFromCallItem(input.row.callItem);
  const asked = input.row.mcpInputRequest ? parseMcpInputRequest(input.row.mcpInputRequest) : null;
  const payload = input.trigger.payload as {
    decision?: unknown;
    message?: unknown;
    content?: McpElicitationContent;
  };
  const message =
    typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message
      : undefined;
  const rejected = (): { resultItem: Record<string, unknown>; eventOutput: unknown } => {
    if (input.row.interruptionKind === "approval" && payload.decision === "reject" && !message) {
      // This approval was rejected before invocation, not interrupted during execution.
      return memberResult({
        callId: input.row.callId,
        name,
        output: "Tool approval was rejected. This proposed tool call was not executed.",
      });
    }
    const reason = message ?? "Tool approval was rejected.";
    const interrupted = interruptedToolCallResult({
      callType: input.row.callType,
      callId: input.row.callId,
      callItem: input.row.callItem,
      reason,
    });
    return memberResult({
      callId: input.row.callId,
      name,
      output: reason,
      ...(interrupted ? { resultItem: interrupted } : {}),
    });
  };
  if (input.row.interruptionKind === "human_input") {
    if (!input.humanInputResume || input.humanInputResume.toolCallId !== input.row.callId) {
      throw new Error("Human-input open suffix is missing its durable response");
    }
    const output = JSON.stringify({
      requestId: input.humanInputResume.requestId,
      ...input.humanInputResume.response,
    });
    return memberResult({
      callId: input.row.callId,
      name,
      output,
    });
  }
  const invoke = async (
    mcpInputAnswer?: McpInputAnswer,
  ): Promise<{ output: unknown } | { asked: McpInputRequest }> => {
    try {
      const output = await invokePreparedAgentTool({
        agent: input.agent,
        toolName: name,
        argumentsJson: argumentsJsonFromCallItem(input.row.callItem),
        callId: input.row.callId,
        ...(mcpInputAnswer ? { mcpInputAnswer } : {}),
      });
      const askedAgain = mcpInputRequestOf(output);
      return askedAgain ? { asked: askedAgain } : { output };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
  };
  if (payload.decision === "approve") {
    const outcome = await invoke(
      asked ? { request: asked, action: "accept", content: payload.content ?? {} } : undefined,
    );
    if ("asked" in outcome) return outcome;
    return memberResult({ callId: input.row.callId, name, output: outcome.output });
  }
  if (asked && input.row.interruptionKind === "approval" && payload.decision === "reject") {
    // The server stopped mid-call to ask: it is told the person declined and
    // finishes the call its own way, or asks something else.
    const outcome = await invoke({ request: asked, action: "decline" });
    if ("asked" in outcome) return outcome;
    return memberResult({
      callId: input.row.callId,
      name,
      output: declinedMcpQuestionOutput({ output: outcome.output, server: asked.server, message }),
    });
  }
  return rejected();
}

export async function settleOpenSuffixResumeIfNeeded(input: {
  additionalApprovals?: unknown[];
  programmaticApprovalAcknowledged?: boolean;
  db: Database;
  agent: Agent<any, any>;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
  trigger: Pick<SessionEvent, "type" | "payload">;
  humanInputResume: {
    requestId: string;
    toolCallId: string;
    response: HumanInputResponse;
  } | null;
  modelToolOutputTruncationTokens?: number;
  settle: OpenSuffixSettle;
  publish?: (
    events: Array<{ type: "agent.toolCall.output"; payload: { id: string; output: unknown } }>,
  ) => Promise<unknown>;
}): Promise<OpenSuffixResumeOutcome> {
  if (
    input.trigger.type !== "user.approvalDecision" &&
    input.trigger.type !== "user.humanInputResponse" &&
    !input.additionalApprovals?.length
  ) {
    return { action: "continue" };
  }
  const rows = await listTurnOpenSuffixToolCalls(
    input.db,
    input.workspaceId,
    input.sessionId,
    input.turnId,
  );
  if (rows.length === 0 && !input.additionalApprovals?.length) {
    return { action: "continue" };
  }
  const callId = matchingOpenSuffixCallId({
    trigger: input.trigger,
    humanInputToolCallId: input.humanInputResume?.toolCallId,
  });
  const target = resolveOpenSuffixResumeTarget(rows, callId);
  if (
    (!target || !callId) &&
    !input.programmaticApprovalAcknowledged &&
    (input.trigger.type === "user.approvalDecision" ||
      input.trigger.type === "user.humanInputResponse" ||
      !input.additionalApprovals?.length)
  ) {
    throw new Error("Open suffix resume event does not match an interruption");
  }
  if (target && callId) {
    const settled = await settleOpenSuffixTarget(input, target);
    if (settled === "cancelled") return { action: "cancelled" };
  }
  const remaining = (
    await listTurnOpenSuffixToolCalls(input.db, input.workspaceId, input.sessionId, input.turnId)
  ).filter((row) => row.resultItem == null);
  if (remaining.length === 0 && !input.additionalApprovals?.length) {
    return { action: "continue" };
  }
  const requiresActionApprovals = [
    ...remainingPendingApprovalsFromSuffix(remaining),
    ...(input.additionalApprovals ?? []),
  ];
  const pendingApprovals = [
    ...remainingRunStatePendingApprovalsFromSuffix(remaining),
    ...(input.additionalApprovals ?? []),
  ];
  const settled = await input.settle({
    events: [
      ...(requiresActionApprovals.length > 0
        ? [
            {
              type: "session.requiresAction" as const,
              payload: { approvals: requiresActionApprovals.map(withPublicApprovalFields) },
            },
          ]
        : []),
      {
        type: "session.status.changed" as const,
        payload: { status: "requires_action" as const },
      },
    ],
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: input.turnId,
    runState: {
      serializedRunState: OPEN_SUFFIX_RUN_STATE_BLOB,
      pendingApprovals,
    },
  });
  return settled ? { action: "requires_action" } : { action: "cancelled" };
}

/**
 * Settle the call the person decided on: record its result and pair it in
 * history, or keep it open with its MCP server's next question.
 */
async function settleOpenSuffixTarget(
  input: Parameters<typeof settleOpenSuffixResumeIfNeeded>[0],
  target: OpenSuffixPendingToolCall,
): Promise<"settled" | "asked" | "cancelled"> {
  const truncationTokens =
    input.modelToolOutputTruncationTokens ?? target.modelToolOutputTruncationTokens ?? undefined;
  let resultItem = target.resultItem;
  if (!resultItem) {
    const member = await resultItemForOpenSuffixMember({
      agent: input.agent,
      row: target,
      trigger: input.trigger,
      humanInputResume: input.humanInputResume,
    });
    if ("asked" in member) {
      const replaced = await replacePendingToolCallMcpInputRequest(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionGeneration: input.executionGeneration,
        attemptId: input.attemptId,
        callId: target.callId,
        mcpInputRequest: member.asked,
      });
      return replaced.accepted ? "asked" : "cancelled";
    }
    resultItem = member.resultItem;
    const recorded = await recordPendingSessionToolCallResult(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      executionGeneration: input.executionGeneration,
      attemptId: input.attemptId,
      callId: target.callId,
      ...(truncationTokens !== undefined
        ? { modelToolOutputTruncationTokens: truncationTokens }
        : {}),
      resultItem,
      eventOutput: member.eventOutput,
    });
    if (!recorded.accepted) {
      return "cancelled";
    }
    if (!recorded.recorded) {
      const latest = resolveOpenSuffixResumeTarget(
        await listTurnOpenSuffixToolCalls(
          input.db,
          input.workspaceId,
          input.sessionId,
          input.turnId,
        ),
        target.callId,
      );
      resultItem = latest?.resultItem ?? resultItem;
    } else if (input.publish) {
      await input.publish([
        {
          type: "agent.toolCall.output",
          payload: { id: target.callId, output: member.eventOutput },
        },
      ]);
    }
  }
  const history = await getActiveSessionHistoryItems(input.db, input.workspaceId, input.sessionId);
  if (
    !openSuffixPairPresentInHistory(
      history.map((row) => row.item),
      target.callId,
    )
  ) {
    const historyItems = openSuffixHistoryItems(target, resultItem);
    if (historyItems.length === 0) {
      throw new Error(`Open suffix resume for ${target.callId} produced no paired history`);
    }
    const nextPosition = await nextSessionHistoryPosition(
      input.db,
      input.workspaceId,
      input.sessionId,
    );
    const appended = await appendSessionHistoryItems(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      expectedExecutionGeneration: input.executionGeneration,
      expectedAttemptId: input.attemptId,
      ...(truncationTokens !== undefined
        ? { modelToolOutputTruncationTokens: truncationTokens }
        : {}),
      items: historyItems.map((item, offset) => ({
        position: nextPosition + offset,
        item,
      })),
    });
    if (!appended) {
      return "cancelled";
    }
  }
  return "settled";
}

export function interruptionCallIdsFromPause(input: {
  humanInputRequests: Array<{ toolCallId: string }>;
  interactionInterventionRequests: Array<{ toolCallId: string }>;
  pendingApprovals: unknown[];
}): string[] {
  const ids = new Set<string>();
  for (const request of input.humanInputRequests) {
    ids.add(request.toolCallId);
  }
  for (const request of input.interactionInterventionRequests) {
    ids.add(request.toolCallId);
  }
  for (const approval of input.pendingApprovals) {
    const id = approvalIdentifier(approval);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}
