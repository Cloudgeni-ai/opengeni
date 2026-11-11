import { describe, expect, test } from "bun:test";

import { parseReturnTo, returnToOf, returnToSearch, safeInAppPath } from "./return-to";

describe("return-to", () => {
  test("accepts in-app paths with their search", () => {
    expect(safeInAppPath("/workspaces/abc/settings?section=models&account=codex:1")).toBe(
      "/workspaces/abc/settings?section=models&account=codex:1",
    );
  });

  test("rejects anything that could leave the app", () => {
    for (const value of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
      "workspaces/abc",
      "/x\nSet-Cookie: a",
      "",
      42,
      "/" + "a".repeat(600),
    ]) {
      expect(safeInAppPath(value)).toBeUndefined();
    }
  });

  test("needs both the path and the label, and round-trips", () => {
    expect(parseReturnTo({ from: "/workspaces/a/settings" })).toEqual({});
    expect(parseReturnTo({ fromLabel: "Local · Models" })).toEqual({});
    expect(parseReturnTo({ from: "https://evil.example", fromLabel: "Local" })).toEqual({});
    const search = parseReturnTo({
      from: "/workspaces/a/settings?section=models",
      fromLabel: "  Local · Models ",
    });
    expect(search).toEqual({
      from: "/workspaces/a/settings?section=models",
      fromLabel: "Local · Models",
    });
    expect(returnToSearch(returnToOf(search))).toEqual(search);
  });
});
