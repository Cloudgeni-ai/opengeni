import { describe, expect, test } from "bun:test";
import { sessionSupportsFleetSwitching } from "./sandbox-switcher";

describe("sessionSupportsFleetSwitching", () => {
  test("does not offer post-create fleet swaps for an unboxed session", () => {
    expect(sessionSupportsFleetSwitching("none")).toBe(false);
  });

  test("keeps the switcher for sessions with an actual home sandbox", () => {
    expect(sessionSupportsFleetSwitching("modal")).toBe(true);
    expect(sessionSupportsFleetSwitching("selfhosted")).toBe(true);
  });
});
