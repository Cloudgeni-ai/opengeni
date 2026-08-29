import { describe, expect, test } from "bun:test";

import { withRetainableSessionImageOutputHook } from "../src/retained-session-image";

function functionTool(name: string, output: unknown) {
  return {
    type: "function" as const,
    name,
    invoke: async () => output,
  } as never;
}

describe("retained session image compatibility", () => {
  test.each(["view_image", "computer_screenshot"] as const)(
    "retains %s output before returning it unchanged",
    async (toolName) => {
      const output = { type: "image", image: { url: "data:image/png;base64,AA==" } };
      const observed: unknown[] = [];
      const [wrapped] = withRetainableSessionImageOutputHook(
        [functionTool(toolName, output)],
        async (input) => {
          observed.push(input);
        },
      );

      const result = await wrapped!.invoke(undefined, "{}", {
        toolCall: { callId: `call-${toolName}` },
      } as never);

      expect(result).toBe(output);
      expect(observed).toEqual([
        {
          toolName,
          toolCallId: `call-${toolName}`,
          output,
        },
      ]);
    },
  );

  test("does not intercept unrelated tools", async () => {
    const observed: unknown[] = [];
    const output = { ok: true };
    const [wrapped] = withRetainableSessionImageOutputHook(
      [functionTool("exec_command", output)],
      async (input) => {
        observed.push(input);
      },
    );

    expect(await wrapped!.invoke(undefined, "{}", undefined)).toBe(output);
    expect(observed).toEqual([]);
  });
});