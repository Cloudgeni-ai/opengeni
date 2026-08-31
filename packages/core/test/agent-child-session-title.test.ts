import { describe, expect, test } from "bun:test";
import {
  freezeAgentChildAutomaticTitleInCreatorContext,
  initialAutomaticTitleForSessionStart,
} from "../src/domain/sessions";

describe("agent child session title repair", () => {
  test("uses the title frozen by the winning keyed create instead of a retry candidate", () => {
    const createdByContext = freezeAgentChildAutomaticTitleInCreatorContext(
      { callerSessionId: "manager" },
      "Winning child title",
    );
    expect(createdByContext).toEqual({
      callerSessionId: "manager",
      agentChildAutomaticTitle: "Winning child title",
    });
    expect(
      initialAutomaticTitleForSessionStart(
        { createdByContext: createdByContext ?? {} },
        "Losing retry title",
      ),
    ).toBe("Winning child title");
  });

  test("keeps legacy repair source-compatible when no frozen title exists", () => {
    expect(
      initialAutomaticTitleForSessionStart({ createdByContext: {} }, "Legacy retry title"),
    ).toBe("Legacy retry title");
  });
});
