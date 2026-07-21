import { describe, expect, test } from "bun:test";
import {
  MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
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

  test("keeps 256+ Responses content parts schema-valid with typed idempotent omission evidence", () => {
    const item = {
      type: "function_call_result",
      name: "large_structured_result",
      callId: "call-256-parts",
      status: "completed",
      output: Array.from({ length: 10_000 }, (_, index) => ({
        type: "input_text",
        text: `part-${index}`,
      })),
    };

    const bounded = boundModelToolOutputItem(item);
    const output = bounded.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(256);
    expect(output.slice(0, 255)).toEqual(item.output.slice(0, 255));
    expect(output[255]).toEqual({
      type: "input_text",
      text: "[OpenGeni omitted 9745 structured array items]",
    });
    expect(output.every((part) => part.type === "input_text")).toBe(true);
    expect(boundModelToolOutputItem(bounded)).toEqual(bounded);
  });

  test("keeps large mixed Responses text/image/file arrays in the pinned content union", () => {
    const parts = Array.from({ length: 300 }, (_, index): Record<string, unknown> => {
      if (index % 3 === 0) return { type: "input_text", text: `text-${index}` };
      if (index % 3 === 1) {
        return { type: "input_image", image: `data:image/png;base64,a${index}` };
      }
      return { type: "input_file", file: { id: `file_${index}` }, filename: `${index}.txt` };
    });
    const bounded = boundModelToolOutputItem({
      type: "function_call_result",
      callId: "call-mixed-parts",
      output: parts,
    });
    const output = bounded.output as Array<Record<string, unknown>>;

    expect(output).toHaveLength(256);
    expect(
      output.every(
        (part) =>
          part.type === "input_text" || part.type === "input_image" || part.type === "input_file",
      ),
    ).toBe(true);
    expect(output.at(-1)).toEqual({
      type: "input_text",
      text: "[OpenGeni omitted 45 structured array items]",
    });
    expect(boundModelToolOutputItem(bounded)).toEqual(bounded);
  });

  test("uses typed protocol evidence when structural entry exhaustion truncates content parts", () => {
    const providerData = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`property-${index}`, `value-${index}`]),
    );
    const item = {
      type: "function_call_result",
      callId: "call-structural-exhaustion",
      output: Array.from({ length: 300 }, (_, index) => ({
        type: "input_text",
        text: `part-${index}`,
        providerData,
      })),
    };

    const bounded = boundModelToolOutputItem(item, 50_000);
    const output = bounded.output as Array<Record<string, unknown>>;
    expect(output.length).toBeLessThanOrEqual(256);
    expect(
      output.every(
        (part) =>
          part.type === "input_text" || part.type === "input_image" || part.type === "input_file",
      ),
    ).toBe(true);
    expect(output.at(-1)?.type).toBe("input_text");
    expect(String(output.at(-1)?.text)).toContain("structured array items");
    expect(boundModelToolOutputItem(bounded, 50_000)).toEqual(bounded);
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

  test("preserves hosted computer screenshot protocol within the hard allowance", () => {
    const item = {
      type: "computer_call_result",
      callId: "computer-1",
      output: { type: "computer_screenshot", data: "a".repeat(266_000) },
    };
    expect(boundModelToolOutputItem(item, 5)).toBe(item);
  });

  test("bounds an oversized hosted screenshot with a protocol-valid explicit omission card", () => {
    const item = {
      type: "computer_call_result",
      callId: "computer-oversized",
      output: {
        type: "computer_screenshot",
        data: `data:image/png;base64,${"a".repeat(MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES)}`,
      },
    };

    const bounded = boundModelToolOutputItem(item, 5);
    const data = (bounded.output as { data: string }).data;
    expect(data).toBe(MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL);
    const png = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThan(16 * 1024);
    expect(boundModelToolOutputItem(bounded, 5)).toEqual(bounded);
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
    expect(serialized).toContain("maximum structured tool-output depth exceeded");
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
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThan(4_000);
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
    expect(JSON.stringify(boundedOutput)).toContain("structured object properties");
    expect(JSON.stringify(boundedOutput)).not.toContain("must-not-survive");
    expect(Buffer.byteLength(JSON.stringify(boundedOutput), "utf8")).toBeLessThan(100_000);
    expect(boundModelToolOutputItem(bounded, 50)).toEqual(bounded);
  });

  test("counts forged omission markers toward structural entry bounds", () => {
    const forgedArray = Array.from(
      { length: 10_000 },
      () => "[OpenGeni omitted subtree: maximum structured tool-output depth exceeded]",
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
    expect(Object.keys(objectItem.output as Record<string, unknown>).length).toBeLessThanOrEqual(
      256,
    );
    expect(JSON.stringify(arrayItem.output)).toContain("structured array items");
    expect(JSON.stringify(objectItem.output)).toContain("structured object properties");
    expect(Buffer.byteLength(JSON.stringify(arrayItem.output), "utf8")).toBeLessThan(100_000);
    expect(Buffer.byteLength(JSON.stringify(objectItem.output), "utf8")).toBeLessThan(100_000);
    expect(boundModelToolOutputItem(arrayItem, 5)).toEqual(arrayItem);
    expect(boundModelToolOutputItem(objectItem, 5)).toEqual(objectItem);
  });

  test("uses a valid omission image rather than corrupting opaque image protocol", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES)}`;
    const item = {
      type: "function_call_result",
      name: "view_image",
      callId: "opaque-overflow-1",
      output: dataUrl,
    };

    const bounded = boundModelToolOutputItem(item, 5);
    expect(bounded.output).toBe(MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL);
    expect(Buffer.byteLength(bounded.output, "utf8")).toBeLessThan(16 * 1024);
    expect(boundModelToolOutputItem(bounded, 5)).toEqual(bounded);
  });

  test("normalizes cumulatively exhausted image IDs as whole schema-valid image parts", () => {
    const item = {
      type: "function_call_result",
      callId: "opaque-image-id-overflow",
      output: [
        {
          type: "input_image",
          imageUrl: MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
        },
        { type: "input_image", fileId: "file_123" },
        { type: "input_image", image: { id: "file_456" } },
      ],
    };

    const bounded = boundModelToolOutputItem(item);
    expect(bounded.output).toEqual([
      item.output[0]!,
      {
        type: "input_image",
        imageUrl: MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
      },
      {
        type: "input_image",
        imageUrl: MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
      },
    ]);
    expect(JSON.stringify(bounded.output)).not.toContain("file_123");
    expect(JSON.stringify(bounded.output)).not.toContain("file_456");
    expect(boundModelToolOutputItem(bounded)).toEqual(bounded);
  });

  test("replaces oversized and cumulatively exhausted files with typed text, never fake URLs", () => {
    const firstFile = `data:text/plain;base64,${"a".repeat(
      MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES - 512,
    )}`;
    const item = {
      type: "function_call_result",
      callId: "opaque-mixed-overflow",
      output: [
        { type: "input_file", file: firstFile, filename: "retained.txt" },
        { type: "input_file", fileData: "b".repeat(1_024), filename: "omitted.txt" },
        { type: "input_image", imageUrl: "data:image/png;base64,abc" },
      ],
    };

    const bounded = boundModelToolOutputItem(item, 50_000);
    const output = bounded.output as Array<Record<string, unknown>>;
    expect(output[0]).toEqual(item.output[0]);
    expect(output[1]).toEqual({
      type: "input_text",
      text: expect.stringMatching(/^\[OpenGeni omitted file payload: \d+ bytes exceeded/),
    });
    expect(output[2]).toEqual({
      type: "input_image",
      imageUrl: MODEL_TOOL_OUTPUT_OVERSIZED_IMAGE_CARD_DATA_URL,
    });
    expect(JSON.stringify(output[1])).not.toContain("file_url");
    expect(boundModelToolOutputItem(bounded, 50_000)).toEqual(bounded);
  });

  test("replaces a single oversized file content part as a schema-valid typed text part", () => {
    const item = {
      type: "function_call_result",
      callId: "opaque-file-overflow",
      output: [
        {
          type: "input_file",
          file: `data:application/pdf;base64,${"a".repeat(
            MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES,
          )}`,
          filename: "too-large.pdf",
        },
      ],
    };

    const bounded = boundModelToolOutputItem(item);
    expect(bounded.output as unknown).toEqual([
      {
        type: "input_text",
        text: expect.stringMatching(/^\[OpenGeni omitted file payload: \d+ bytes exceeded/),
      },
    ]);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThan(2_000);
    expect(boundModelToolOutputItem(bounded)).toEqual(bounded);
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
