import { describe, expect, test } from "bun:test";
import { OPEN_SUFFIX_RUN_STATE_BLOB } from "@opengeni/contracts";
import {
  OpenSuffixUnresumableError,
  assertOpenSuffixResumable,
  extractOpenSuffixFromRunState,
  interruptionKindForCallItem,
  serializedRunStateForOpenSuffixPause,
} from "../src/open-suffix";

describe("open suffix", () => {
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

  test("replaces an oversized leftover heap with the open-suffix sentinel", () => {
    const oversized = JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) });
    expect(serializedRunStateForOpenSuffixPause(oversized)).toBe(OPEN_SUFFIX_RUN_STATE_BLOB);
    expect(serializedRunStateForOpenSuffixPause(JSON.stringify({ compact: true }))).toBe(
      JSON.stringify({ compact: true }),
    );
  });
});
