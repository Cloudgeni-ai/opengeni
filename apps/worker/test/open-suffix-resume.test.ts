import { describe, expect, test } from "bun:test";
import {
  matchingOpenSuffixCallId,
  openSuffixHistoryItems,
  openSuffixPairPresentInHistory,
  remainingPendingApprovalsFromSuffix,
  remainingRunStatePendingApprovalsFromSuffix,
  resolveOpenSuffixResumeTarget,
} from "../src/activities/open-suffix-resume";
import type { OpenSuffixPendingToolCall } from "@opengeni/db";

describe("open suffix resume helpers", () => {
  test("promotes reasoning, call, and result as one paired history suffix", () => {
    const row = {
      callId: "call_human",
      callType: "function_call",
      callItem: {
        type: "function_call",
        callId: "call_human",
        name: "request_human_input",
        arguments: "{}",
      },
      interruptionKind: "human_input",
      tiedReasoningItems: [
        { type: "reasoning", id: "rs_1", content: [{ type: "input_text", text: "ask" }] },
      ],
      resultItem: null,
      modelToolOutputTruncationTokens: null,
    } satisfies OpenSuffixPendingToolCall;
    const resultItem = {
      type: "function_call_result",
      name: "request_human_input",
      callId: "call_human",
      status: "completed",
      output: { type: "text", text: '{"requestId":"req"}' },
    };
    expect(openSuffixHistoryItems(row, resultItem)).toEqual([
      row.tiedReasoningItems[0],
      row.callItem,
      resultItem,
    ]);
  });

  test("executes one member and withholds remaining parallel approvals from the model", () => {
    const remaining = [
      {
        callId: "call_a",
        callType: "function_call",
        callItem: { type: "function_call", callId: "call_a", name: "wiki_read", arguments: "{}" },
        interruptionKind: "approval" as const,
        tiedReasoningItems: [],
        resultItem: { type: "function_call_result", callId: "call_a" },
        modelToolOutputTruncationTokens: null,
      },
      {
        callId: "call_b",
        callType: "function_call",
        callItem: { type: "function_call", callId: "call_b", name: "wiki_list", arguments: "{}" },
        interruptionKind: "approval" as const,
        tiedReasoningItems: [],
        resultItem: null,
        modelToolOutputTruncationTokens: null,
      },
    ] satisfies OpenSuffixPendingToolCall[];
    expect(remainingPendingApprovalsFromSuffix(remaining)).toEqual([
      {
        id: "call_b",
        name: "wiki_list",
        arguments: "{}",
        raw: remaining[1]!.callItem,
      },
    ]);
  });

  test("matches human-input and approval resume events to the open-suffix call id", () => {
    expect(
      matchingOpenSuffixCallId({
        trigger: { type: "user.humanInputResponse", payload: { requestId: "req" } },
        humanInputToolCallId: "human-call-1",
      }),
    ).toBe("human-call-1");
    expect(
      matchingOpenSuffixCallId({
        trigger: {
          type: "user.approvalDecision",
          payload: { approvalId: "call_tool", decision: "approve" },
        },
      }),
    ).toBe("call_tool");
  });

  test("treats an already-recorded member as the resume target instead of missing", () => {
    const rows = [
      {
        callId: "call_a",
        callType: "function_call",
        callItem: { type: "function_call", callId: "call_a", name: "wiki_read", arguments: "{}" },
        interruptionKind: "approval" as const,
        tiedReasoningItems: [],
        resultItem: { type: "function_call_result", callId: "call_a" },
        modelToolOutputTruncationTokens: null,
      },
      {
        callId: "call_b",
        callType: "function_call",
        callItem: { type: "function_call", callId: "call_b", name: "wiki_list", arguments: "{}" },
        interruptionKind: "approval" as const,
        tiedReasoningItems: [],
        resultItem: null,
        modelToolOutputTruncationTokens: null,
      },
    ] satisfies OpenSuffixPendingToolCall[];
    expect(resolveOpenSuffixResumeTarget(rows, "call_a")?.callId).toBe("call_a");
    expect(resolveOpenSuffixResumeTarget(rows, "call_b")?.resultItem).toBeNull();
    expect(resolveOpenSuffixResumeTarget(rows, "call_missing")).toBeNull();
  });

  test("detects a durable call/result pair and ignores a result-only history", () => {
    const call = { type: "function_call", callId: "call_human", name: "request_human_input" };
    const result = {
      type: "function_call_result",
      callId: "call_human",
      output: { type: "text", text: "yes" },
    };
    expect(openSuffixPairPresentInHistory([call, result], "call_human")).toBe(true);
    expect(openSuffixPairPresentInHistory([result], "call_human")).toBe(false);
    expect(openSuffixPairPresentInHistory([call], "call_human")).toBe(false);
  });

  test("keeps interaction interventions out of the requiresAction event payload", () => {
    const remaining = [
      {
        callId: "call_mcp",
        callType: "function_call",
        callItem: { type: "function_call", callId: "call_mcp", name: "wiki_read", arguments: "{}" },
        interruptionKind: "approval" as const,
        tiedReasoningItems: [],
        resultItem: null,
        modelToolOutputTruncationTokens: null,
      },
      {
        callId: "call_interact",
        callType: "function_call",
        callItem: {
          type: "function_call",
          callId: "call_interact",
          name: "interaction__interaction_request_human",
          arguments: "{}",
        },
        interruptionKind: "interaction_intervention" as const,
        tiedReasoningItems: [],
        resultItem: null,
        modelToolOutputTruncationTokens: null,
      },
    ] satisfies OpenSuffixPendingToolCall[];
    expect(remainingPendingApprovalsFromSuffix(remaining)).toEqual([
      {
        id: "call_mcp",
        name: "wiki_read",
        arguments: "{}",
        raw: remaining[0]!.callItem,
      },
    ]);
    expect(
      remainingRunStatePendingApprovalsFromSuffix(remaining).map(
        (item) => (item as { id: string }).id,
      ),
    ).toEqual(["call_mcp", "call_interact"]);
  });
});
