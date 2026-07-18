import { describe, expect, test } from "bun:test";
import {
  boundModelToolOutputItem,
  modelToolOutputSerializationBudgetTokens,
  truncateMiddleWithTokenBudget,
} from "../src/model-output-truncation";

describe("Codex-parity model tool-output truncation", () => {
  test("uses the live 10k policy with Codex's 1.2x serialization allowance", () => {
    expect(modelToolOutputSerializationBudgetTokens()).toBe(12_000);
  });

  test("matches Codex's head/tail token marker", () => {
    const bounded = truncateMiddleWithTokenBudget(
      "this is an example of a long output that should be truncated",
      5,
    );
    expect(bounded).toBe("this is an…10 tokens truncated… truncated");
    expect(truncateMiddleWithTokenBudget(bounded, 5)).toBe(bounded);
  });

  test("does not mistake marker-like text in an oversized raw result for a bounded result", () => {
    const raw = `prefix …999 tokens truncated… ${"x".repeat(100)}`;
    expect(truncateMiddleWithTokenBudget(raw, 5)).not.toBe(raw);

    const forgedMarker = `…${"9".repeat(500)} tokens truncated…`;
    expect(truncateMiddleWithTokenBudget(forgedMarker, 5)).not.toBe(forgedMarker);
  });

  test("preserves UTF-8 boundaries", () => {
    const value = "😀".repeat(20);
    const bounded = truncateMiddleWithTokenBudget(value, 5);
    expect(bounded).toContain("tokens truncated");
    expect(bounded).not.toContain("�");
  });

  test("bounds function output text without changing call/result truth", () => {
    const item = {
      type: "function_call_result",
      name: "sessions_list",
      callId: "call-1",
      status: "completed",
      output: { type: "text", text: "x".repeat(100) },
    };
    const bounded = boundModelToolOutputItem(item, 5);
    expect(bounded).toMatchObject({
      type: "function_call_result",
      name: "sessions_list",
      callId: "call-1",
      status: "completed",
      output: { type: "text" },
    });
    expect((bounded.output as { text: string }).text).toContain("tokens truncated");
    expect(item.output.text).toHaveLength(100);
  });

  test("shares one sequential budget across structured text and preserves images", () => {
    const image = { type: "input_image", image: "data:image/png;base64,abc" };
    const item = {
      type: "function_call_result",
      name: "mixed",
      callId: "call-2",
      status: "completed",
      output: [
        { type: "input_text", text: "a".repeat(12) },
        image,
        { type: "input_text", text: "b".repeat(80) },
        { type: "input_text", text: "dropped" },
      ],
    };
    const bounded = boundModelToolOutputItem(item, 5);
    expect(bounded.output).toEqual([
      item.output[0],
      image,
      expect.objectContaining({
        type: "input_text",
        text: expect.stringContaining("tokens truncated"),
      }),
      { type: "input_text", text: "[omitted 1 text items ...]" },
    ]);
  });

  test("bounds stdout and stderr inside structured shell results", () => {
    const item = {
      type: "shell_call_output",
      callId: "call-shell",
      output: [
        {
          stdout: "s".repeat(100),
          stderr: "e".repeat(100),
          outcome: { type: "exit", exitCode: 0 },
        },
      ],
    };
    const bounded = boundModelToolOutputItem(item, 5);
    const output = bounded.output as Array<{
      stdout: string;
      stderr: string;
      outcome: { type: string; exitCode: number };
    }>;
    expect(output[0]!.stdout).toContain("tokens truncated");
    expect(output[0]!.stderr).toContain("omitted text field");
    expect(output[0]!.outcome).toEqual({ type: "exit", exitCode: 0 });
    expect(boundModelToolOutputItem(bounded, 5)).toEqual(bounded);
  });

  test("preserves MCP content discriminators while bounding nested text", () => {
    const item = {
      type: "function_call_result",
      callId: "call-mcp",
      output: {
        isError: false,
        content: [{ type: "text", text: "m".repeat(100) }],
      },
    };
    const bounded = boundModelToolOutputItem(item, 5);
    expect(bounded.output).toMatchObject({
      isError: false,
      content: [{ type: "text", text: expect.stringContaining("tokens truncated") }],
    });
  });

  test("never truncates hosted computer screenshot protocol", () => {
    const item = {
      type: "computer_call_result",
      callId: "computer-1",
      output: { type: "computer_screenshot", data: "a".repeat(266_000) },
    };
    expect(boundModelToolOutputItem(item, 5)).toBe(item);
  });

  test("never truncates a text-transport screenshot data URL", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(266_000)}`;
    const item = {
      type: "function_call_result",
      name: "computer_screenshot",
      callId: "computer-2",
      status: "completed",
      output: dataUrl,
    };
    expect(boundModelToolOutputItem(item, 5)).toBe(item);
    expect(item.output).toBe(dataUrl);
  });

  test("never truncates structured function-result images", () => {
    const item = {
      type: "function_call_result",
      name: "view_image",
      callId: "image-1",
      status: "completed",
      output: {
        type: "image",
        image: { data: "a".repeat(266_000), mediaType: "image/png" },
      },
    };
    expect(boundModelToolOutputItem(item, 5)).toBe(item);
  });

  test("leaves empty and already-bounded output byte-identical", () => {
    const empty = {
      type: "function_call_result",
      name: "empty",
      callId: "call-3",
      status: "completed",
      output: { type: "text", text: "" },
    };
    expect(boundModelToolOutputItem(empty)).toBe(empty);
  });
});
