import { describe, expect, test } from "bun:test";

import { sessionDescendantCountAria, sessionDescendantCountText } from "./session-tree-count";

describe("session tree descendant counts", () => {
  test("renders an exact aggregate as exact visible and accessible text", () => {
    expect(sessionDescendantCountText(3_834, false)).toBe("3,834");
    expect(sessionDescendantCountAria(3_834, false)).toBe("3,834 descendant sessions");
    expect(sessionDescendantCountAria(1, false)).toBe("1 descendant session");
  });

  test("renders a bounded thousand-descendant traversal as a lower bound", () => {
    expect(sessionDescendantCountText(1_000, true)).toBe("1,000+");
    expect(sessionDescendantCountAria(1_000, true)).toBe("At least 1,000 descendant sessions");
  });
});
