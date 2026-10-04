import { describe, expect, test } from "bun:test";

import * as activities from "../src/activities";
import { createControlActivitiesFromServices } from "../src/activities-control";
import { createTurnActivitiesFromServices } from "../src/activities-turn";

describe("Temporal activity registry", () => {
  test("exports only the clean-cutover runAgentTurn activity name", () => {
    expect(typeof activities.runAgentTurn).toBe("function");
    expect(Object.keys(activities).filter((name) => name.startsWith("runAgent"))).toEqual([
      "runAgentTurn",
    ]);
  });

  test("registers video reconciliation on control and retains the legacy turn handler", () => {
    const unavailable = async (): Promise<never> => {
      throw new Error("registry construction must not initialize services");
    };
    const control = createControlActivitiesFromServices(unavailable);
    const turn = createTurnActivitiesFromServices(unavailable);
    expect(typeof control.reconcileVideoGenerationOperation).toBe("function");
    expect(typeof turn.reconcileVideoGenerationOperation).toBe("function");
    expect(typeof turn.runAgentTurn).toBe("function");
    expect(Object.keys(control)).not.toContain("runAgentTurn");
  });
});
