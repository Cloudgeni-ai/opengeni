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
  test("retains view_image output before returning it unchanged", async () => {
    const output = { type: "image", image: { url: "data:image/png;base64,AA==" } };
    const observed: unknown[] = [];
    const [wrapped] = withRetainableSessionImageOutputHook(
      [functionTool("view_image", output)],
      async (input) => {
        observed.push(input);
      },
    );

    const result = await wrapped!.invoke(undefined, "{}", {
      toolCall: { callId: "call-view-image" },
    } as never);

    expect(result).toBe(output);
    expect(observed).toEqual([
      {
        toolName: "view_image",
        toolCallId: "call-view-image",
        output,
      },
    ]);
  });

  test.each(["computer_screenshot", "exec_command"] as const)(
    "does not intercept %s",
    async (toolName) => {
      const observed: unknown[] = [];
      const output = { ok: true };
      const [wrapped] = withRetainableSessionImageOutputHook(
        [functionTool(toolName, output)],
        async (input) => {
          observed.push(input);
        },
      );

      expect(await wrapped!.invoke(undefined, "{}", undefined)).toBe(output);
      expect(observed).toEqual([]);
    },
  );
});
