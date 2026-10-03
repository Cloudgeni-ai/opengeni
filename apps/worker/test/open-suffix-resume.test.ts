import { describe, expect, test } from "bun:test";
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import {
  matchingOpenSuffixCallId,
  openSuffixHistoryItems,
  openSuffixPairPresentInHistory,
  remainingPendingApprovalsFromSuffix,
  remainingRunStatePendingApprovalsFromSuffix,
  resolveOpenSuffixResumeTarget,
  resultItemForOpenSuffixMember,
} from "../src/activities/open-suffix-resume";
import { interruptedToolCallResult, type OpenSuffixPendingToolCall } from "@opengeni/db";

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

describe("open suffix approval results", () => {
  const rejectedDefault = "Tool approval was rejected. This proposed tool call was not executed.";
  const originalDefault = "Tool approval was rejected.";

  function fixture(
    input: {
      kind?: OpenSuffixPendingToolCall["interruptionKind"];
      output?: string;
      error?: Error;
    } = {},
  ) {
    const calls: Array<{ title: string }> = [];
    const agent = new Agent({
      name: "approval-result-test",
      tools: [
        tool({
          name: "change_article_title",
          description: "Synthetic local invocation counter; no host or model is called.",
          parameters: z.object({ title: z.string() }),
          errorFunction: null,
          execute: async (args) => {
            calls.push(args);
            if (input.error) {
              throw input.error;
            }
            return input.output ?? "Title changed successfully.";
          },
        }),
      ],
    });
    const row = {
      callId: "call_proposed_title",
      callType: "function_call",
      callItem: {
        type: "function_call",
        callId: "call_proposed_title",
        name: "change_article_title",
        arguments: '{"title":"Proposed title"}',
      },
      interruptionKind: input.kind ?? "approval",
      tiedReasoningItems: [],
      resultItem: null,
      modelToolOutputTruncationTokens: null,
    } satisfies OpenSuffixPendingToolCall;
    return {
      calls,
      resume: (decision: string | undefined, message?: unknown) =>
        resultItemForOpenSuffixMember({
          agent,
          row,
          trigger: {
            type: "user.approvalDecision",
            payload: { approvalId: row.callId, decision, message },
          },
          humanInputResume: null,
        }),
    };
  }

  function expectPairedResult(
    result: Awaited<ReturnType<typeof resultItemForOpenSuffixMember>>,
    output: string,
  ) {
    expect(result.eventOutput).toBe(output);
    expect(result.resultItem).toMatchObject({
      type: "function_call_result",
      callId: "call_proposed_title",
      name: "change_article_title",
      output: { type: "text", text: output },
    });
  }

  function expectInterruptedResult(
    result: Awaited<ReturnType<typeof resultItemForOpenSuffixMember>>,
    reason: string,
  ) {
    expect(result.eventOutput).toBe(reason);
    expect(result.resultItem).toEqual(
      interruptedToolCallResult({
        callType: "function_call",
        callId: "call_proposed_title",
        callItem: { name: "change_article_title" },
        reason,
      }),
    );
    expect(result.resultItem.status).toBe("incomplete");
  }

  test("explicit ordinary rejection states only that this proposed call was not executed", async () => {
    const { resume, calls } = fixture();
    expectPairedResult(await resume("reject"), rejectedDefault);
    expect(calls).toEqual([]);
  });

  test("preserves a nonempty custom rejection reason byte-for-byte", async () => {
    const { resume, calls } = fixture();
    const reason = "  Keep the original title.\nAnother call may already have run.  ";
    expectInterruptedResult(await resume("reject", reason), reason);
    expect(calls).toEqual([]);
  });

  for (const message of ["", " \n\t ", null, 42]) {
    test(`ordinary rejection retains the default fallback for ${JSON.stringify(message)}`, async () => {
      const { resume, calls } = fixture();
      expectPairedResult(await resume("reject", message), rejectedDefault);
      expect(calls).toEqual([]);
    });
  }

  test("intervention rejection remains conservative about prior execution", async () => {
    const { resume, calls } = fixture({ kind: "interaction_intervention" });
    expectInterruptedResult(await resume("reject"), originalDefault);
    expect(calls).toEqual([]);
  });

  test("intervention custom reason remains unchanged", async () => {
    const { resume, calls } = fixture({ kind: "interaction_intervention" });
    const reason = "Stop the interaction; prior actions are not rolled back.";
    expectInterruptedResult(await resume("reject", reason), reason);
    expect(calls).toEqual([]);
  });

  for (const decision of [undefined, "unknown"]) {
    test(`non-approve ambiguity ${String(decision)} retains the conservative default`, async () => {
      const { resume, calls } = fixture();
      expectInterruptedResult(await resume(decision), originalDefault);
      expect(calls).toEqual([]);
    });
  }

  test("approved success invokes once and preserves the actual result", async () => {
    const output = "Title changed successfully. Revision 1.";
    const { resume, calls } = fixture({ output });
    expectPairedResult(await resume("approve"), output);
    expect(calls).toEqual([{ title: "Proposed title" }]);
  });

  test("approved unknown outcome is not rewritten as rejection or nonexecution", async () => {
    const error = new Error("Tool execution outcome is unknown; do not replay this call.");
    const { resume, calls } = fixture({ error });
    expectPairedResult(await resume("approve"), error.message);
    expect(calls).toEqual([{ title: "Proposed title" }]);
  });
});
