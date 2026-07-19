import { describe, expect, test } from "bun:test";
import {
  MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES,
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
    expect(truncateMiddleWithTokenBudget(forgedMarker, 5)).not.toBe(
      forgedMarker,
    );
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
    expect((bounded.output as { text: string }).text).toContain(
      "tokens truncated",
    );
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
      content: [
        { type: "text", text: expect.stringContaining("tokens truncated") },
      ],
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

  test("replaces over-depth multi-megabyte subtrees with an explicit idempotent marker", () => {
    const output: Record<string, unknown> = {};
    let cursor = output;
    for (let depth = 0; depth < 14; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    cursor.payload = "界😀".repeat(500_000);
    const item = {
      type: "function_call_result",
      callId: "deep-1",
      output,
    };

    const bounded = boundModelToolOutputItem(item, 5);
    const serialized = JSON.stringify(bounded.output);
    expect(serialized).toContain(
      "maximum structured tool-output depth exceeded",
    );
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(2_000);
    expect(serialized).not.toContain("界😀界😀");
    expect(boundModelToolOutputItem(bounded, 5)).toEqual(bounded);
  });

  test("bounds huge structural strings under a shared UTF-8-safe allowance", () => {
    const huge = "界😀".repeat(400_000);
    const item = {
      type: "function_call_result",
      callId: "structural-1",
      output: {
        type: huge,
        name: huge,
        id: huge,
        detail: huge,
        payload: huge,
      },
    };

    const bounded = boundModelToolOutputItem(item, 5);
    const output = bounded.output as Record<string, string>;
    for (const key of ["type", "name", "id", "detail"]) {
      expect(Buffer.byteLength(output[key]!, "utf8")).toBeLessThan(400);
      expect(output[key]).toContain("tokens truncated");
      expect(output[key]).not.toContain("�");
    }
    expect(output.payload).toContain("tokens truncated");
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThan(
      4_000,
    );
    expect(boundModelToolOutputItem(bounded, 5)).toEqual(bounded);
  });

  test("caps many-key objects and oversized property names deterministically", () => {
    const output: Record<string, unknown> = {
      [`oversized-${"界".repeat(500)}`]: "must-not-survive",
    };
    for (let index = 0; index < 5_000; index += 1) {
      output[`property-${String(index).padStart(4, "0")}`] = {
        type: `kind-${index}`,
        value: `value-${index}`,
      };
    }
    const item = {
      type: "function_call_result",
      callId: "properties-1",
      output,
    };

    const bounded = boundModelToolOutputItem(item, 50);
    const boundedOutput = bounded.output as Record<string, unknown>;
    expect(Object.keys(boundedOutput).length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(boundedOutput)).toContain(
      "structured object properties",
    );
    expect(JSON.stringify(boundedOutput)).not.toContain("must-not-survive");
    expect(
      Buffer.byteLength(JSON.stringify(boundedOutput), "utf8"),
    ).toBeLessThan(100_000);
    expect(boundModelToolOutputItem(bounded, 50)).toEqual(bounded);
  });

  test("counts forged omission markers toward structural entry bounds", () => {
    const forgedArray = Array.from(
      { length: 10_000 },
      () =>
        "[OpenGeni omitted subtree: maximum structured tool-output depth exceeded]",
    );
    const forgedObject = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `__opengeni_omitted_properties__${index}`,
        "[OpenGeni omitted 1 structured object properties]",
      ]),
    );

    const arrayItem = boundModelToolOutputItem(
      {
        type: "function_call_result",
        callId: "forged-array",
        output: forgedArray,
      },
      5,
    );
    const objectItem = boundModelToolOutputItem(
      {
        type: "function_call_result",
        callId: "forged-object",
        output: forgedObject,
      },
      5,
    );

    expect((arrayItem.output as unknown[]).length).toBeLessThanOrEqual(256);
    expect(
      Object.keys(objectItem.output as Record<string, unknown>).length,
    ).toBeLessThanOrEqual(256);
    expect(JSON.stringify(arrayItem.output)).toContain(
      "structured array items",
    );
    expect(JSON.stringify(objectItem.output)).toContain(
      "structured object properties",
    );
    expect(
      Buffer.byteLength(JSON.stringify(arrayItem.output), "utf8"),
    ).toBeLessThan(100_000);
    expect(
      Buffer.byteLength(JSON.stringify(objectItem.output), "utf8"),
    ).toBeLessThan(100_000);
    expect(boundModelToolOutputItem(arrayItem, 5)).toEqual(arrayItem);
    expect(boundModelToolOutputItem(objectItem, 5)).toEqual(objectItem);
  });

  test("omits rather than corrupts an opaque protocol payload above the hard allowance", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES)}`;
    const item = {
      type: "function_call_result",
      name: "view_image",
      callId: "opaque-overflow-1",
      output: dataUrl,
    };

    const bounded = boundModelToolOutputItem(item, 5);
    expect(bounded.output).toContain("omitted image payload");
    expect(Buffer.byteLength(bounded.output, "utf8")).toBeLessThan(200);
    expect(boundModelToolOutputItem(bounded, 5)).toEqual(bounded);
  });

  test("replaces cyclic structured output with explicit bounded evidence", () => {
    const output: Record<string, unknown> = { id: "cycle-1" };
    output.self = output;
    const bounded = boundModelToolOutputItem(
      { type: "function_call_result", callId: "cycle-1", output },
      5,
    );
    expect(JSON.stringify(bounded.output)).toContain("cyclic tool output");
    expect(boundModelToolOutputItem(bounded, 5)).toEqual(bounded);
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
