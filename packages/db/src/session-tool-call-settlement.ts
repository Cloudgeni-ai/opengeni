import type { SessionEvent } from "@opengeni/contracts";
import { canonicalizePersistedHistoryItem, omitOutputOnlyHistoryItemFields } from "@opengeni/codex";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./database";
import { fromPostgresLosslessJson, LOSSLESS_CONTENT_CODEC_VERSION } from "./lossless-json";
import * as schema from "./schema";
import { cancelUnacceptedVideoGenerationsForToolCallsInTransaction } from "./video-generation";

export const TOOL_RESULT_TYPE_BY_CALL_TYPE: Readonly<Record<string, string>> = {
  function_call: "function_call_result",
  computer_call: "computer_call_result",
  shell_call: "shell_call_output",
  apply_patch_call: "apply_patch_call_output",
  tool_search_call: "tool_search_output",
};

export function historyCallId(item: Record<string, unknown>): string | null {
  const providerData =
    item.providerData && typeof item.providerData === "object" && !Array.isArray(item.providerData)
      ? (item.providerData as Record<string, unknown>)
      : null;
  // Native tool-search `id` is the provider item id, not the call correlation
  // id. Prefer its providerData identity before the generic item-id fallback.
  const value =
    item.callId ?? item.call_id ?? providerData?.call_id ?? providerData?.callId ?? item.id;
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
  turnAssociation?: "current" | null;
  preserveInterruptionRows?: boolean;
};

function mapEvent(row: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEvent["type"],
    payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
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
 * Close raw tool calls for a logical turn while its owning session/turn locks
 * are held. Recoverable transitions preserve interruption rows because those
 * rows are the exact open-suffix resume authority for a replacement attempt;
 * ordinary in-flight rows still receive durable outcome-unknown settlement.
 * Terminal and superseding transitions close every row. Durable results win;
 * repeated settlement is an exact no-op after the selected ledger rows are
 * deleted.
 */
export async function closePendingSessionToolCallsInTransaction(
  tx: Database,
  input: ClosePendingSessionToolCallsInput,
): Promise<{ sequence: number; events: SessionEvent[]; closed: number }> {
  const pendingRows = await tx
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
  const pending = pendingRows
    .filter((row) => !(input.preserveInterruptionRows && row.interruptionKind !== null))
    .map((row) => ({
      ...row,
      callItem: fromPostgresLosslessJson(row.callItem, row.callItemCodecVersion),
      resultItem:
        row.resultItem === null
          ? null
          : fromPostgresLosslessJson(row.resultItem, row.resultItemCodecVersion),
      eventOutput:
        row.eventOutput === null
          ? null
          : fromPostgresLosslessJson(row.eventOutput, row.eventOutputCodecVersion),
    }));
  if (pending.length === 0) return { sequence: input.sequence, events: [], closed: 0 };

  const history = await tx
    .select({
      position: schema.sessionHistoryItems.position,
      item: schema.sessionHistoryItems.item,
      itemCodecVersion: schema.sessionHistoryItems.itemCodecVersion,
      active: schema.sessionHistoryItems.active,
    })
    .from(schema.sessionHistoryItems)
    .where(
      and(
        eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
        eq(schema.sessionHistoryItems.sessionId, input.sessionId),
        eq(schema.sessionHistoryItems.turnId, input.turnId),
      ),
    )
    .orderBy(asc(schema.sessionHistoryItems.position));
  const decodedHistory = history.map((row) => ({
    ...row,
    item: fromPostgresLosslessJson(row.item, row.itemCodecVersion),
  }));
  const [{ maxPosition } = { maxPosition: -1 }] = await tx
    .select({ maxPosition: sql<number>`coalesce(max(${schema.sessionHistoryItems.position}), -1)` })
    .from(schema.sessionHistoryItems)
    .where(
      and(
        eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
        eq(schema.sessionHistoryItems.sessionId, input.sessionId),
      ),
    );
  const existingOutputEvents = await tx
    .select({ callId: sql<string | null>`${schema.sessionEvents.payload} ->> 'id'` })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, input.workspaceId),
        eq(schema.sessionEvents.sessionId, input.sessionId),
        eq(schema.sessionEvents.turnId, input.turnId),
        eq(schema.sessionEvents.type, "agent.toolCall.output"),
      ),
    );
  const projectedCallIds = new Set(
    existingOutputEvents.flatMap(({ callId }) => (callId ? [callId] : [])),
  );
  let nextPosition = Math.floor(Number(maxPosition)) + 1;
  let sequence = input.sequence;
  const historyValues: Array<typeof schema.sessionHistoryItems.$inferInsert> = [];
  const eventValues: Array<typeof schema.sessionEvents.$inferInsert> = [];
  const resolutions = pending.map((call) => {
    const resultType = TOOL_RESULT_TYPE_BY_CALL_TYPE[call.callType];
    const existingCall = decodedHistory.find(
      ({ item }) => historyItemType(item) === call.callType && historyCallId(item) === call.callId,
    );
    const existingResult = resultType
      ? decodedHistory.find(
          ({ item, position }) =>
            position > (existingCall?.position ?? Number.MAX_SAFE_INTEGER) &&
            historyItemType(item) === resultType &&
            historyCallId(item) === call.callId,
        )
      : undefined;
    const activeCall = decodedHistory.find(
      ({ item, active }) =>
        active && historyItemType(item) === call.callType && historyCallId(item) === call.callId,
    );
    const activeResult = resultType
      ? decodedHistory.find(
          ({ item, active, position }) =>
            active &&
            position > (activeCall?.position ?? Number.MAX_SAFE_INTEGER) &&
            historyItemType(item) === resultType &&
            historyCallId(item) === call.callId,
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
      activeCall,
      activeResult,
      completeDurablePair: Boolean(existingCall && existingResult),
      supersededDurablePair: Boolean(
        existingCall && existingResult && (!existingCall.active || !existingResult.active),
      ),
      rawCallIsValid: historyItemType(call.callItem) === call.callType,
      result: existingResult?.item ?? call.resultItem ?? interruptedResult,
      interrupted: !existingResult && !call.resultItem,
    };
  });

  for (const resolution of resolutions) {
    if (
      !resolution.completeDurablePair &&
      !resolution.activeCall &&
      resolution.result &&
      resolution.rawCallIsValid
    ) {
      historyValues.push({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        position: nextPosition++,
        item: omitOutputOnlyHistoryItemFields(resolution.call.callItem),
        itemCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
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
    if (
      !resolution.completeDurablePair &&
      !resolution.activeResult &&
      resolution.result &&
      resolution.rawCallIsValid
    ) {
      historyValues.push({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        position: nextPosition++,
        item: canonicalizePersistedHistoryItem(
          resolution.result,
          resolution.call.modelToolOutputTruncationTokens ?? undefined,
        ),
        itemCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
        active: true,
      });
    }
    // A pair superseded by compaction was already projected during its live
    // response. Reactivating or re-emitting it would undo the checkpoint and
    // duplicate the UI output. An active complete pair is different: it can be
    // the crash point after model-memory persistence but before event publish,
    // so it keeps the existing durable recovery projection below.
    if (resolution.supersededDurablePair || projectedCallIds.has(resolution.call.callId)) continue;
    eventValues.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: ++sequence,
      type: "agent.toolCall.output",
      turnId: input.turnId,
      turnGeneration: resolution.call.executionGeneration,
      turnAttemptId: resolution.call.attemptId,
      turnAssociation: input.turnAssociation === undefined ? "current" : input.turnAssociation,
      payload: {
        id: resolution.call.callId,
        output: resolution.interrupted
          ? {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Tool execution was interrupted by ${input.reason}; its side-effect outcome is unknown.`,
                },
              ],
            }
          : resolution.call.eventOutput !== null
            ? resolution.call.eventOutput.value
            : ((resolution.existingResult?.item ?? resolution.call.resultItem)?.output ??
              resolution.existingResult?.item ??
              resolution.call.resultItem),
        recovery: {
          interrupted: resolution.interrupted,
          outcome: resolution.interrupted ? "unknown" : "durable_result_found",
          reason: input.reason,
          unsupportedCallShape:
            resolution.interrupted && (!resolution.result || !resolution.rawCallIsValid),
        },
      },
      payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
      occurredAt: input.now,
    });
  }

  if (historyValues.length > 0) await tx.insert(schema.sessionHistoryItems).values(historyValues);
  const inserted =
    eventValues.length > 0
      ? await tx.insert(schema.sessionEvents).values(eventValues).returning()
      : [];
  await cancelUnacceptedVideoGenerationsForToolCallsInTransaction(tx, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolCallIds: pending.map((call) => call.callId),
    reason: input.reason,
    now: input.now,
  });
  await tx.delete(schema.sessionPendingToolCalls).where(
    and(
      eq(schema.sessionPendingToolCalls.workspaceId, input.workspaceId),
      eq(schema.sessionPendingToolCalls.sessionId, input.sessionId),
      eq(schema.sessionPendingToolCalls.turnId, input.turnId),
      inArray(
        schema.sessionPendingToolCalls.id,
        pending.map((call) => call.id),
      ),
    ),
  );
  return { sequence, events: inserted.map(mapEvent), closed: pending.length };
}
