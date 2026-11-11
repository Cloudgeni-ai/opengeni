import { describe, expect, test } from "bun:test";
import { SAFETY_REFUSAL_OMISSIBLE_HISTORY_TYPES } from "@opengeni/db";
import {
  isOmissibleToolResult,
  projectSafetyRefusedToolResult,
  SAFETY_REFUSED_TOOL_RESULT_OMISSION,
} from "@opengeni/runtime";
import { selectSafetyRefusedToolResults } from "../src/activities/agent-turn/history";
import { projectRejectedProviderArtifacts } from "../src/activities/run-input";

type Row = {
  id: string;
  item: Record<string, unknown>;
  providerArtifactInvalidatedAt: Date | null;
};

const rows = (...items: Array<Record<string, unknown>>): Row[] =>
  items.map((item, index) => ({ id: `row-${index}`, item, providerArtifactInvalidatedAt: null }));
const user = (content: string) => ({ type: "message", role: "user", content });
const assistant = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const call = (callId: string, name: string) => ({
  type: "function_call",
  callId,
  name,
  arguments: "{}",
});
const result = (callId: string, output: unknown = "output") => ({
  type: "function_call_result",
  callId,
  output,
});

describe("selectSafetyRefusedToolResults", () => {
  test("selects only the tool results after the newest model item", () => {
    const history = rows(
      user("task"),
      call("a", "read_file"),
      result("a"),
      call("b", "shell"),
      call("c", "screenshot"),
      result("b"),
      result("c"),
    );
    // Result "a" was in the request the provider accepted when it called b and c.
    expect(selectSafetyRefusedToolResults(history)).toEqual({
      historyItemIds: ["row-5", "row-6"],
      toolNames: ["shell", "screenshot"],
    });
  });

  test("reaches a refused result through later messages, which are never selected", () => {
    // A session already stuck: the turn failed after the result, and each
    // later message was refused too.
    const history = rows(
      user("task"),
      call("a", "run_script"),
      result("a"),
      user("hello?"),
      { type: "message", role: "system", content: "operational notice" },
      user("are you there?"),
    );
    expect(selectSafetyRefusedToolResults(history)).toEqual({
      historyItemIds: ["row-2"],
      toolNames: ["run_script"],
    });
  });

  test("selects nothing when the newest item is the model's own, or results were marked already", () => {
    expect(
      selectSafetyRefusedToolResults(rows(user("task"), assistant("done"), user("next"))),
    ).toEqual({ historyItemIds: [], toolNames: [] });
    const marked = rows(user("task"), call("a", "run_script"), result("a"), user("again"));
    marked[2]!.providerArtifactInvalidatedAt = new Date();
    expect(selectSafetyRefusedToolResults(marked)).toEqual({ historyItemIds: [], toolNames: [] });
  });

  test("stops at reasoning, checkpoints and unknown items", () => {
    for (const stop of [
      { type: "reasoning", summary: [] },
      { type: "compaction", encrypted_content: "opaque" },
      { type: "some_future_item" },
    ]) {
      expect(
        selectSafetyRefusedToolResults(rows(call("a", "x"), result("a"), stop, user("next")))
          .historyItemIds,
      ).toEqual([]);
    }
  });

  test("tool search output carries tool definitions and is never selected", () => {
    const history = rows(
      { type: "tool_search_call", callId: "s", arguments: {} },
      { type: "tool_search_output", callId: "s", tools: [{ name: "x" }] },
    );
    expect(selectSafetyRefusedToolResults(history).historyItemIds).toEqual([]);
  });
});

describe("safety-refused tool result projection", () => {
  test("keeps the call settled and replaces only the body", () => {
    const screenshot = result("a", [
      { type: "input_image", image: "data:image/png;base64,AAAA" },
      { type: "input_text", text: "typed the password" },
    ]);
    expect(projectSafetyRefusedToolResult(screenshot)).toEqual({
      type: "function_call_result",
      callId: "a",
      output: SAFETY_REFUSED_TOOL_RESULT_OMISSION,
    });
    const shell = { type: "shell_call_output", callId: "s", output: [{ stdout: "secret" }] };
    expect(projectSafetyRefusedToolResult(shell)).toEqual({
      type: "shell_call_output",
      callId: "s",
      output: [
        {
          stdout: "",
          stderr: SAFETY_REFUSED_TOOL_RESULT_OMISSION,
          outcome: { type: "exit", exitCode: null },
        },
      ],
    });
    // Anything that is not a tool result is returned as it is.
    const message = user("keep me");
    expect(projectSafetyRefusedToolResult(message)).toBe(message);
  });

  test("model reads project only rows marked for a safety refusal", () => {
    const refused = result("a", "refused body");
    const kept = result("b", "kept body");
    const projected = projectRejectedProviderArtifacts([
      { item: kept, providerArtifactInvalidatedAt: null },
      {
        item: refused,
        providerArtifactInvalidatedAt: new Date(),
        providerArtifactInvalidationReason: "provider_safety_refusal",
      },
    ]);
    expect(projected[0]).toBe(kept);
    expect(projected[1]).toEqual({ ...refused, output: SAFETY_REFUSED_TOOL_RESULT_OMISSION });
    // The stored item itself is never changed.
    expect(refused.output).toBe("refused body");
  });

  test("the database marks exactly the tool results the projection can replace", () => {
    for (const type of SAFETY_REFUSAL_OMISSIBLE_HISTORY_TYPES)
      expect(isOmissibleToolResult({ type })).toBe(true);
    for (const type of [
      "function_call",
      "message",
      "reasoning",
      "compaction",
      "tool_search_output",
      "web_search_call",
    ])
      expect(isOmissibleToolResult({ type })).toBe(false);
    expect(new Set(SAFETY_REFUSAL_OMISSIBLE_HISTORY_TYPES).size).toBe(7);
  });
});
