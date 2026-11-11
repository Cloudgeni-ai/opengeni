import { describe, expect, test } from "bun:test";

import { runtimePages } from "./settings-rail";

describe("the rail's runtime pages", () => {
  test("list Computer use only inside a desktop app that offers it", () => {
    expect(runtimePages(false).map((page) => page.label)).toEqual([
      "Secrets",
      "Sandbox environments",
      "Machines",
    ]);
    expect(runtimePages(true).map((page) => page.label)).toEqual([
      "Secrets",
      "Sandbox environments",
      "Machines",
      "Computer use",
    ]);
  });
});
