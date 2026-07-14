import { describe, expect, test } from "bun:test";

import * as activities from "../src/activities";

describe("Temporal activity registry", () => {
  test("exports only the clean-cutover runAgentTurn activity name", () => {
    expect(typeof activities.runAgentTurn).toBe("function");
    expect(Object.keys(activities).filter((name) => name.startsWith("runAgent"))).toEqual([
      "runAgentTurn",
    ]);
  });
});
