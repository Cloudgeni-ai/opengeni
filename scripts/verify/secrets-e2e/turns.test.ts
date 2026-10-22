import { describe, expect, test } from "bun:test";

import { normalizeToolName } from "./turns";

describe("tool name normalization", () => {
  test("the native Responses patch item counts as apply_patch", () => {
    expect(normalizeToolName("apply_patch_call")).toBe("apply_patch");
  });

  test("function tool names pass through", () => {
    expect(normalizeToolName("apply_patch")).toBe("apply_patch");
    expect(normalizeToolName("exec_command")).toBe("exec_command");
  });
});
