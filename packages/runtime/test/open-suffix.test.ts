import { describe, expect, spyOn, test } from "bun:test";
import { Agent, RunContext, RunState } from "@openai/agents";
import {
  OpenSuffixUnresumableError,
  assertOpenSuffixResumable,
  extractOpenSuffixFromRunState,
  interruptionKindForCallItem,
} from "../src/open-suffix";

describe("open suffix", () => {
  const call = {
    type: "function_call",
    callId: "call_exec",
    name: "exec_command",
    arguments: "{}",
  };
  const result = {
    type: "function_call_result",
    callId: "call_exec",
    name: "exec_command",
    output: { type: "text", text: "waiting_for_approval" },
  };

  test("a programmatic approval checkpoints an empty suffix without serializing SDK history", () => {
    // Canonical input omits output-only statuses. It is valid model input,
    // but the SDK's full snapshot validator requires those statuses.
    const input = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ready" }] },
      call,
      result,
    ];
    const state = new RunState(
      new RunContext(),
      input as never,
      new Agent({ name: "Test agent" }),
      null,
    );
    const serialize = spyOn(state, "toString");
    try {
      const suffix = extractOpenSuffixFromRunState(state);
      expect(suffix).toEqual([]);
      expect(() => assertOpenSuffixResumable(suffix, [])).not.toThrow();
      expect(serialize).not.toHaveBeenCalled();
      expect(input).toEqual([
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ready" }] },
        call,
        result,
      ]);
    } finally {
      serialize.mockRestore();
    }
  });

  test.each(["generatedItems", "_generatedItems"])(
    "%s is authoritative when all generated calls are paired",
    (field) => {
      const suffix = extractOpenSuffixFromRunState({
        [field]: [{ rawItem: call }, { rawItem: result }],
        history: [call],
        toString() {
          throw new Error("Full history must not be serialized");
        },
      });
      expect(suffix).toEqual([]);
      expect(() => assertOpenSuffixResumable(suffix, [call.callId])).toThrow(
        OpenSuffixUnresumableError,
      );
    },
  );

  test.each([{ history: [] }, { history: [call, result] }])(
    "an available history array needs no snapshot fallback: %j",
    ({ history }) => {
      expect(
        extractOpenSuffixFromRunState({
          history,
          toString() {
            throw new Error("Full history must not be serialized");
          },
        }),
      ).toEqual([]);
    },
  );

  test("legacy states without item arrays retain serialized suffix recovery", () => {
    const suffix = extractOpenSuffixFromRunState({
      toString: () => JSON.stringify({ generatedItems: [{ rawItem: call }] }),
    });
    expect(suffix.map((member) => member.callId)).toEqual([call.callId]);
    expect(() => assertOpenSuffixResumable(suffix, [call.callId])).not.toThrow();
    expect(() => assertOpenSuffixResumable(suffix, [])).toThrow(OpenSuffixUnresumableError);
  });

  test("maps generatedItems wrappers and classifies interruption kinds", () => {
    const state = {
      generatedItems: [
        {
          rawItem: {
            type: "reasoning",
            id: "rs_1",
            content: [{ type: "input_text", text: "ask" }],
          },
        },
        {
          rawItem: {
            type: "function_call",
            callId: "call_human",
            name: "request_human_input",
            arguments: "{}",
          },
        },
      ],
    };
    const members = extractOpenSuffixFromRunState(state);
    expect(members).toHaveLength(1);
    expect(members[0]?.callId).toBe("call_human");
    expect(interruptionKindForCallItem(members[0]!.callItem as Record<string, unknown>)).toBe(
      "human_input",
    );
    expect(
      interruptionKindForCallItem({
        name: "interaction__interaction_request_human",
      }),
    ).toBe("interaction_intervention");
    expect(interruptionKindForCallItem({ name: "wiki_read" })).toBe("approval");
  });

  test("fails closed on a computer_call interruption", () => {
    const members = extractOpenSuffixFromRunState({
      generatedItems: [
        {
          rawItem: { type: "computer_call", callId: "call_computer", action: { type: "click" } },
        },
      ],
    });
    expect(() => assertOpenSuffixResumable(members, ["call_computer"])).toThrow(
      OpenSuffixUnresumableError,
    );
  });
});
