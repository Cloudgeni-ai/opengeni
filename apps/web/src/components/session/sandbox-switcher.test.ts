import { describe, expect, test } from "bun:test";
import { sessionSupportsFleetSwitching } from "./sandbox-switcher";

describe("sessionSupportsFleetSwitching", () => {
  test("offers fleet attachment whether or not the session has a home sandbox", () => {
    expect(sessionSupportsFleetSwitching("none")).toBe(true);
    expect(sessionSupportsFleetSwitching("modal")).toBe(true);
    expect(sessionSupportsFleetSwitching("selfhosted")).toBe(true);
  });
});
