import { describe, expect, test } from "bun:test";
import { browserExtensionIdsEnv } from "../src/this-computer";

describe("an app's own browser extensions", () => {
  test("are passed to the agent as one comma-separated setting", () => {
    const own = "a".repeat(32);
    const other = "p".repeat(32);
    expect(browserExtensionIdsEnv([own, other, own])).toBe(`${own},${other}`);
  });

  test("are left out when the app has none", () => {
    expect(browserExtensionIdsEnv(undefined)).toBeNull();
    expect(browserExtensionIdsEnv([])).toBeNull();
  });

  test("fail at startup when an ID is malformed", () => {
    for (const id of ["a".repeat(31), "q".repeat(32), "A".repeat(32), "a,b"]) {
      expect(() => browserExtensionIdsEnv([id])).toThrow("is not a Chrome extension ID");
    }
  });
});
