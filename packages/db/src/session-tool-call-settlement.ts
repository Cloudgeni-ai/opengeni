import { isPrivateMemoryToolName, type SessionEvent } from "@opengeni/contracts";
import { boundModelToolOutputItem } from "@opengeni/codex";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./index";
import { sanitizeEventPayload, sanitizeModelPayload } from "./event-payload-sanitizer";
import * as schema from "./schema";

export const TOOL_RESULT_TYPE_BY_CALL_TYPE: Readonly<Record<string, string>> = {
  function_call: "function_call_result",
  computer_call: "computer_call_result",
  shell_call: "shell_call_output",
  apply_patch_call: "apply_patch_call_output",
  tool_search_call: "tool_search_output",
};

export function historyCallId(item: Record<string, unknown>): string | null {
  const value = item.callId ?? item.call_id ?? item.id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function historyItemType(item: Record<string, unknown>): string | null {
  return typeof item.type === "string" ? item.type : null;
}

/** Provider-valid result for a started call whose durable outcome is unknown. */
export function interruptedToolCallResult(input: {
  callType: string;
  callId: string;
  callItem: Record<string, unknown>;
  reason: string;
}): Record<string, unknown> | null {
  const message =
    `Tool execution was interrupted by ${input.reason} before its result was durably recorded. ` +
    "The side-effect outcome is unknown; inspect actual state before repeating the call.";
  if (input.callType === "function_call") {
    const name = typeof input.callItem.name === "string" ? input.callItem.name : "tool";
    return {
      type: "function_call_result",
      name,
      ...(typeof input.callItem.namespace === "string"
        ? { namespace: input.callItem.namespace }
        : {}),
      callId: input.callId,
      status: "incomplete",
      output: { type: "text", text: message },
    };
  }
  if (input.callType === "shell_call") {
    return {
      type: "shell_call_output",
      callId: input.callId,
      output: [{ stdout: "", stderr: message, outcome: { type: "exit", exitCode: null } }],
    };
  }
  if (input.callType === "apply_patch_call") {
    return {
      type: "apply_patch_call_output",
      callId: input.callId,
      status: "failed",
      output: message,
    };
  }
  if (input.callType === "computer_call") return null;
  if (input.callType === "tool_search_call") {
    const snakeId = typeof input.callItem.call_id === "string";
    return {
      type: "tool_search_output",
      ...(snakeId ? { call_id: input.callId } : { callId: input.callId }),
      ...(input.callItem.execution === "client" || input.callItem.execution === "server"
        ? { execution: input.callItem.execution }
        : {}),
      status: "incomplete",
      tools: [],
    };
  }
  return null;
}

export type ClosePendingSessionToolCallsInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  reason: string;
  sequence: number;
  now: Date;
};

function mapEvent(row: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEvent["type"],
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    clientEventId: row.clientEventId,
    turnId: row.turnId,
    turnGeneration: row.turnGeneration,
    turnAttemptId: row.turnAttemptId,
    turnAssociation: row.turnAssociation as SessionEvent["turnAssociation"],
    duplicateOfEventId: row.duplicateOfEventId,
    duplicateReason: row.duplicateReason,
  };
}

/**
 * Close every unresolved raw tool call for a logical turn while its owning
 * session/turn locks are held. Durable results win; otherwise the model gets an
 * explicit interrupted/outcome-unknown result for protocols that can represent
 * one. Repeated settlement is an exact no-op after ledger deletion.
 */
export async function closePendingSessionToolCallsInTransaction(
  tx: Database,
  input: ClosePendingSessionToolCallsInput,
): Promise<{ sequence: number; events: SessionEvent[]; closed: number }> {
  const pending = await tx
    .select()
    .from(schema.sessionPendingToolCalls)
    .where(
      and(
        eq(schema.sessionPendingToolCalls.workspaceId, input.workspaceId),
        eq(schema.sessionPendingToolCalls.sessionId, input.sessionId),
        eq(schema.sessionPendingToolCalls.turnId, input.turnId),
      ),
    )
    .orderBy(asc(schema.sessionPendingToolCalls.createdAt), asc(schema.sessionPendingToolCalls.id))
    .for("update");
  if (pending.length === 0) return { sequence: input.sequence, events: [], closed: 0 };

  const history = await tx
    .select({ item: schema.sessionHistoryItems.item })
    .from(schema.sessionHistoryItems)
    .where(
      and(
        eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
        eq(schema.sessionHistoryItems.sessionId, input.sessionId),
        eq(schema.sessionHistoryItems.turnId, input.turnId),
        eq(schema.sessionHistoryItems.active, true),
      ),
    )
    .orderBy(asc(schema.sessionHistoryItems.position));
  const [{ maxPosition } = { maxPosition: -1 }] = await tx
    .select({ maxPosition: sql<number>`coalesce(max(${schema.sessionHistoryItems.position}), -1)` })
    .from(schema.sessionHistoryItems)
    .where(
      and(
        eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
        eq(schema.sessionHistoryItems.sessionId, input.sessionId),
      ),
    );
  let nextPosition = Math.floor(Number(maxPosition)) + 1;
  let sequence = input.sequence;
  const historyValues: Array<typeof schema.sessionHistoryItems.$inferInsert> = [];
  const eventValues: Array<typeof schema.sessionEvents.$inferInsert> = [];
  const resolutions = pending.map((call) => {
    const resultType = TOOL_RESULT_TYPE_BY_CALL_TYPE[call.callType];
    const existingCall = history.find(
      ({ item }) => historyItemType(item) === call.callType && historyCallId(item) === call.callId,
    );
    const existingResult = resultType
      ? history.find(
          ({ item }) => historyItemType(item) === resultType && historyCallId(item) === call.callId,
        )
      : undefined;
    const interruptedResult = interruptedToolCallResult({
      callType: call.callType,
      callId: call.callId,
      callItem: call.callItem,
      reason: input.reason,
    });
    return {
      call,
      existingCall,
      existingResult,
      rawCallIsValid: historyItemType(call.callItem) === call.callType,
      result: existingResult?.item ?? call.resultItem ?? interruptedResult,
      interrupted: !existingResult && !call.resultItem,
    };
  });

  for (const resolution of resolutions) {
    if (
      !resolution.existingResult &&
      !resolution.existingCall &&
      resolution.result &&
      resolution.rawCallIsValid
    ) {
      historyValues.push({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        position: nextPosition++,
        item: sanitizeModelPayload(resolution.call.callItem),
        active: true,
      });
    }
  }
  const orderedResults = [...resolutions].sort(
    (left, right) =>
      (left.call.resultRecordedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (right.call.resultRecordedAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
  );
  for (const resolution of orderedResults) {
    const privateMemoryTool = isPrivateMemoryToolName(resolution.call.callItem.name);
    if (!resolution.existingResult && resolution.result && resolution.rawCallIsValid) {
      historyValues.push({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        position: nextPosition++,
        item: sanitizeModelPayload(boundModelToolOutputItem(resolution.result)),
        active: true,
      });
    }
    eventValues.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: ++sequence,
      type: "agent.toolCall.output",
      turnId: input.turnId,
      turnGeneration: resolution.call.executionGeneration,
      turnAttemptId: resolution.call.attemptId,
      turnAssociation: "current",
      payload: sanitizeEventPayload({
        id: resolution.call.callId,
        output: privateMemoryTool
          ? null
          : resolution.interrupted
            ? {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Tool execution was interrupted by ${input.reason}; its side-effect outcome is unknown.`,
                  },
                ],
              }
            : ((resolution.existingResult?.item ?? resolution.call.resultItem)?.output ??
              resolution.existingResult?.item ??
              resolution.call.resultItem),
        ...(privateMemoryTool ? { redacted: true } : {}),
        recovery: {
          interrupted: resolution.interrupted,
          outcome: resolution.interrupted ? "unknown" : "durable_result_found",
          reason: input.reason,
          unsupportedCallShape:
            resolution.interrupted && (!resolution.result || !resolution.rawCallIsValid),
        },
      }),
      occurredAt: input.now,
    });
  }

  if (historyValues.length > 0) await tx.insert(schema.sessionHistoryItems).values(historyValues);
  const inserted =
    eventValues.length > 0
      ? await tx.insert(schema.sessionEvents).values(eventValues).returning()
      : [];
  await tx
    .delete(schema.sessionPendingToolCalls)
    .where(
      and(
        eq(schema.sessionPendingToolCalls.workspaceId, input.workspaceId),
        eq(schema.sessionPendingToolCalls.sessionId, input.sessionId),
        eq(schema.sessionPendingToolCalls.turnId, input.turnId),
      ),
    );
  return { sequence, events: inserted.map(mapEvent), closed: pending.length };
}
